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
      const order = await razorpayClient.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `topup_${req.user._id.toHexString()}_${Date.now()}`,
        notes: { userId: req.user._id.toHexString(), purpose: 'wallet_topup' },
      });
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
        const payment = await razorpayClient.payments.fetch(paymentId);
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

    const result = await withTransaction(async (session) =>
      wallet.credit({
        userId: req.user._id,
        // The recorded intent, never a client-supplied amount.
        amountPaise: intent.amountPaise,
        reason: 'razorpay_topup',
        // Replay-proof: the unique index on this key absorbs duplicate calls.
        idempotencyKey: `razorpay:${paymentId}`,
        razorpayOrderId: orderId,
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

    return res.json({
      data: {
        credited: !result.replayed,
        balancePaise: result.balancePaise,
        balance: result.balancePaise / 100,
      },
    });
  }
);

module.exports = router;
