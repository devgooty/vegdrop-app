'use strict';

const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const config = require('../config/env');
const PaymentIntent = require('../models/PaymentIntent');
const { ApiError } = require('../middleware/errors');
const { validate, z } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimit');
const { withTransaction } = require('../db/connect');
const wallet = require('../services/wallet');

const router = express.Router();

const MIN_TOPUP_PAISE = 1000; // ₹10
const MAX_TOPUP_PAISE = 5_000_00; // ₹50,000

const razorpayClient = config.razorpay.configured
  ? new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret })
  : null;

router.get('/', requireAuth, async (req, res) => {
  const [balancePaise, transactions] = await Promise.all([
    wallet.getBalancePaise(req.user._id),
    wallet.listTransactions(req.user._id, { limit: 50 }),
  ]);

  return res.json({
    data: {
      balancePaise,
      balance: balancePaise / 100,
      transactions: transactions.map((t) => ({
        id: t._id.toString(),
        type: t.type,
        amountPaise: t.amountPaise,
        amount: t.amountPaise / 100,
        balanceAfter: t.balanceAfterPaise / 100,
        reason: t.reason,
        note: t.note,
        createdAt: t.createdAt,
      })),
    },
  });
});

/**
 * Begin a top-up.
 *
 * The amount is recorded server-side against the returned order id so that
 * verification can prove the user paid what they claimed.
 */
router.post(
  '/topup/create',
  requireAuth,
  paymentLimiter,
  validate({
    body: z
      .object({
        amount: z
          .number()
          .positive()
          .max(MAX_TOPUP_PAISE / 100)
          .transform((rupees) => Math.round(rupees * 100)),
      })
      .strict(),
  }),
  async (req, res) => {
    const amountPaise = req.valid.body.amount;

    if (amountPaise < MIN_TOPUP_PAISE) {
      throw new ApiError(400, `Minimum top-up is ₹${MIN_TOPUP_PAISE / 100}.`, 'AMOUNT_TOO_SMALL');
    }

    let razorpayOrderId;
    let isMock = false;

    if (razorpayClient) {
      /**
       * A Razorpay rejection is our integration's fault, not the caller's, so
       * it surfaces as 502 — the same rule payouts.js follows and the one
       * middleware/errors.js exists to enforce. It is also caught at all: the
       * SDK rejects with a plain `{statusCode, error}` object rather than an
       * Error, so uncaught it reached the client as a bare 500 whose log line
       * had an undefined name, message, and stack. That is what hid the
       * receipt-length bug below.
       */
      let order;
      try {
        order = await razorpayClient.orders.create({
          amount: amountPaise,
          currency: 'INR',
          /**
           * Razorpay caps `receipt` at 40 characters and rejects the whole
           * order with a 400 when it is longer. `topup_` + a 24-char ObjectId
           * + `_` + a millisecond epoch is 44, so every live top-up failed
           * here — the mock path has no such limit, which is why this
           * survived.
           *
           * Base 36 puts the timestamp in 8 characters instead of 13, landing
           * at 39, and stays 8 characters until well past 2050.
           */
          receipt: `topup_${req.user._id.toHexString()}_${Date.now().toString(36)}`,
          notes: { userId: req.user._id.toHexString(), purpose: 'wallet_topup' },
        });
      } catch (err) {
        // Full detail for operators; the caller learns only that we failed.
        console.error('[wallet] razorpay rejected order creation', {
          status: err?.statusCode,
          code: err?.error?.code,
          description: err?.error?.description,
          reason: err?.error?.reason,
        });
        throw new ApiError(
          502,
          'Could not start the payment. Please try again in a moment.',
          'PAYMENT_PROVIDER_ERROR'
        );
      }
      razorpayOrderId = order.id;
    } else if (config.razorpay.allowMock) {
      // Development affordance only. config/env.js aborts boot if production
      // reaches this branch, so a mock intent can never exist in production.
      razorpayOrderId = `order_mock_${crypto.randomBytes(10).toString('hex')}`;
      isMock = true;
    } else {
      throw new ApiError(503, 'Payments are not available right now.', 'PAYMENTS_UNAVAILABLE');
    }

    await PaymentIntent.create({
      razorpayOrderId,
      user: req.user._id,
      amountPaise,
      purpose: 'wallet_topup',
      isMock,
    });

    return res.status(201).json({
      data: {
        razorpayOrderId,
        amountPaise,
        currency: 'INR',
        // Publishable key only. The secret never leaves the server.
        keyId: config.razorpay.keyId || null,
        isMock,
      },
    });
  }
);

/**
 * Verify a completed payment and credit the wallet.
 *
 * Three independent checks must all pass:
 *   1. HMAC signature over `order_id|payment_id` matches the key secret.
 *   2. The order id maps to an intent owned by THIS user.
 *   3. Where the live API is available, Razorpay itself confirms the payment is
 *      captured and the amount matches the recorded intent.
 *
 * Crediting is keyed on the payment id, so replaying this request is a no-op.
 */
router.post(
  '/topup/verify',
  requireAuth,
  paymentLimiter,
  validate({
    body: z
      .object({
        razorpay_order_id: z.string().trim().min(6).max(80),
        razorpay_payment_id: z.string().trim().min(6).max(80),
        razorpay_signature: z.string().trim().min(16).max(256),
      })
      .strict(),
  }),
  async (req, res) => {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } =
      req.valid.body;

    const intent = await PaymentIntent.findOne({ razorpayOrderId: orderId });

    // Ownership check: a signature proves the payment is real, not that it is
    // yours. Without this, one user could credit their wallet with another
    // user's payment reference.
    if (!intent || intent.user.toString() !== req.user._id.toHexString()) {
      throw new ApiError(404, 'Payment record not found.', 'NOT_FOUND');
    }

    if (intent.isMock && config.isProduction) {
      throw new ApiError(400, 'Invalid payment reference.', 'INVALID_PAYMENT');
    }

    if (!intent.isMock) {
      const expected = crypto
        .createHmac('sha256', config.razorpay.keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const expectedBuf = Buffer.from(expected, 'utf8');
      const actualBuf = Buffer.from(signature, 'utf8');
      const signatureValid =
        expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

      if (!signatureValid) {
        intent.status = 'failed';
        await intent.save();
        throw new ApiError(400, 'Payment signature verification failed.', 'INVALID_SIGNATURE');
      }

      // Authoritative amount check against Razorpay, not against the request.
      if (razorpayClient) {
        /**
         * Same plain-object rejection as orders.create, and the same 502. This
         * one fails closed either way — an unreadable payment must never be
         * credited — but as an uncaught 500 it was indistinguishable from a
         * bug in our own handler.
         */
        let payment;
        try {
          payment = await razorpayClient.payments.fetch(paymentId);
        } catch (err) {
          console.error('[wallet] razorpay payment lookup failed', {
            status: err?.statusCode,
            code: err?.error?.code,
            description: err?.error?.description,
          });
          throw new ApiError(
            502,
            'Could not confirm the payment with the provider. It has not been credited yet.',
            'PAYMENT_PROVIDER_ERROR'
          );
        }
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
          throw new ApiError(400, `Payment is not complete (status: ${payment.status}).`, 'PAYMENT_NOT_CAPTURED');
        }
        if (Number(payment.amount) !== intent.amountPaise) {
          throw new ApiError(400, 'Paid amount does not match the requested amount.', 'AMOUNT_MISMATCH');
        }
        if (payment.order_id !== orderId) {
          throw new ApiError(400, 'Payment does not belong to that order.', 'ORDER_MISMATCH');
        }
      }
    }

    const result = await settleIntent(intent, paymentId);

    return res.json({
      data: {
        credited: !result.replayed,
        balancePaise: result.balancePaise,
        balance: result.balancePaise / 100,
      },
    });
  }
);

/**
 * Credit a verified payment against its recorded intent, and mark the intent.
 *
 * Shared by the browser's verification call and the webhook below, so the two
 * cannot credit differently — or twice. `razorpay:<paymentId>` is the whole
 * guard: whichever arrives second collides on the ledger's unique index and is
 * reported as the first one's success.
 *
 * The amount always comes from the stored intent. Neither caller is trusted for
 * it — not the browser, and not the webhook body either, since a body is only
 * as trustworthy as the signature that covered it.
 */
async function settleIntent(intent, paymentId) {
  const result = await withTransaction(async (session) =>
    wallet.credit({
      userId: intent.user,
      amountPaise: intent.amountPaise,
      reason: 'razorpay_topup',
      idempotencyKey: `razorpay:${paymentId}`,
      razorpayOrderId: intent.razorpayOrderId,
      razorpayPaymentId: paymentId,
      note: 'Wallet top-up',
      session,
    })
  );

  if (intent.status !== 'paid') {
    intent.status = 'paid';
    intent.razorpayPaymentId = paymentId;
    intent.settledAt = new Date();
    await intent.save();
  }

  return result;
}

/**
 * Razorpay's webhook — the path that does not depend on the customer's browser.
 *
 * WHY THIS EXISTS
 *
 * Until now `/topup/verify` was the only thing that credited a wallet, and it
 * is called by the page that Razorpay redirects back to. Close the tab, lose
 * signal, or run out of battery in the seconds after paying and the money was
 * captured and never credited — with nothing anywhere to reconcile it. The
 * top-up screen even promised "if you were charged, it will be reconciled",
 * which was not true of any code that existed.
 *
 * Deliberately NOT rate-limited. paymentLimiter keys on IP, and Razorpay's
 * retries all arrive from a small set of theirs — throttling them would drop
 * precisely the deliveries this exists to catch. The signature is the gate.
 *
 * Unauthenticated for the same reason: there is no user session on a
 * server-to-server call. The signature proves the sender, and the intent lookup
 * decides whose wallet is credited — the request body never names a user.
 */
router.post('/webhook', async (req, res) => {
  const secret = config.razorpay.webhookSecret;

  if (!secret) {
    /**
     * 503, not 200. An unconfigured secret means we cannot tell a real delivery
     * from a forged one, so the only safe answer is "not now" — and Razorpay
     * retrying is what gives an operator time to set it before the payment is
     * lost. Production cannot reach this; config/env.js refuses to boot.
     */
    console.error('[wallet] webhook received but RAZORPAY_WEBHOOK_SECRET is not set');
    return res.status(503).json({ error: { code: 'WEBHOOK_NOT_CONFIGURED' } });
  }

  const signature = req.get('x-razorpay-signature') || '';
  // Set by the express.json verify hook in app.js, for this path only.
  const raw = req.rawBody;

  if (!raw || !verifyWebhookSignature(raw, signature, secret)) {
    // 400 and not 401: there is no credential to re-present. Razorpay does not
    // retry a 4xx, which is right — a bad signature will never become good.
    return res.status(400).json({ error: { code: 'INVALID_SIGNATURE' } });
  }

  const event = req.body?.event;
  const payment = req.body?.payload?.payment?.entity;

  // Everything else Razorpay may send (refunds, settlements, disputes) is
  // acknowledged rather than retried. Answering non-2xx to an event we simply
  // do not handle gets the whole webhook disabled after enough failures.
  if (!payment?.id || !payment?.order_id) {
    return res.json({ data: { handled: false, event: event || null } });
  }

  const intent = await PaymentIntent.findOne({ razorpayOrderId: payment.order_id });
  if (!intent) {
    // Not ours, or older than the intent's 25-hour retention. Nothing to do,
    // and nothing a retry would fix.
    return res.json({ data: { handled: false, reason: 'NO_INTENT' } });
  }

  if (event === 'payment.failed') {
    if (intent.status === 'created') {
      intent.status = 'failed';
      await intent.save();
    }
    return res.json({ data: { handled: true, event } });
  }

  if (event !== 'payment.captured') {
    return res.json({ data: { handled: false, event } });
  }

  /**
   * A signed body proving ₹10 was captured must not credit a ₹5000 intent.
   *
   * This should be impossible — Razorpay collects against the order we created
   * — so it is logged loudly and left uncredited rather than reconciled
   * automatically. 200, because retrying will send the same mismatch for ever.
   */
  if (Number(payment.amount) !== intent.amountPaise) {
    console.error('[wallet] webhook amount does not match the recorded intent', {
      razorpayOrderId: payment.order_id,
      paymentId: payment.id,
      captured: payment.amount,
      expected: intent.amountPaise,
    });
    return res.json({ data: { handled: false, reason: 'AMOUNT_MISMATCH' } });
  }

  // Belt and braces: a mock intent is a development artefact and must never be
  // settled by anything claiming to be Razorpay.
  if (intent.isMock) {
    return res.json({ data: { handled: false, reason: 'MOCK_INTENT' } });
  }

  const result = await settleIntent(intent, payment.id);

  // `replayed` is the normal case whenever the browser got back first, which is
  // most of the time. It is a success, not a duplicate to worry about.
  console.log(
    `[wallet] webhook credited ${payment.id} (${result.replayed ? 'already credited' : 'new'})`
  );

  return res.json({ data: { handled: true, credited: !result.replayed } });
});

/** Constant-time HMAC-SHA256 comparison over the exact bytes Razorpay sent. */
function verifyWebhookSignature(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');

  // timingSafeEqual throws on a length mismatch, so the length is checked first.
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = router;
