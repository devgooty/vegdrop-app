'use strict';

/**
 * Razorpay's payment webhook.
 *
 * This is the only path that credits a wallet without the customer's browser
 * being alive to ask for it. Before it existed, `/topup/verify` was the sole
 * crediting route — so a tab closed in the seconds after paying meant the money
 * was captured and never credited, with nothing anywhere to reconcile it.
 *
 * Set before anything reads it: config/env.js freezes its values at load, and
 * node's test runner gives each file its own process, so this cannot leak into
 * another suite.
 */
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec-test-only';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
} = require('./helpers');

const config = require('../config/env');
const PaymentIntent = require('../models/PaymentIntent');
const WalletTransaction = require('../models/WalletTransaction');
const wallet = require('../services/wallet');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/**
 * A real, non-mock intent.
 *
 * Created directly rather than through /topup/create, because that route issues
 * a MOCK intent without Razorpay credentials — and a mock intent is exactly
 * what the webhook must refuse to settle.
 */
async function seedIntent(user, amountPaise = 50000) {
  return PaymentIntent.create({
    razorpayOrderId: `order_${uniq()}`,
    user: user._id,
    amountPaise,
    purpose: 'wallet_topup',
    isMock: false,
  });
}

function capturedBody(intent, paymentId = `pay_${uniq()}`) {
  return {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: intent.razorpayOrderId,
          amount: intent.amountPaise,
          status: 'captured',
        },
      },
    },
  };
}

/**
 * Post exactly the bytes we signed.
 *
 * `.send(string)` with an explicit content type is deliberate: signing a body
 * and letting superagent re-serialise the object would produce different bytes
 * and the HMAC would never match — the same trap the express.json verify hook
 * in app.js exists to avoid.
 */
function deliver(body, { secret = config.razorpay.webhookSecret, signature = null } = {}) {
  const raw = JSON.stringify(body);
  const sig =
    signature ?? crypto.createHmac('sha256', secret).update(raw).digest('hex');

  return api()
    .post('/api/wallet/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig)
    .send(raw);
}

// ---------------------------------------------------------------------------
// The signature is the only gate
// ---------------------------------------------------------------------------

test('a captured payment credits the wallet with no browser involved', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user, 50000);

  const res = await deliver(capturedBody(intent));

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.handled, true);
  assert.equal(res.body.data.credited, true);
  assert.equal(await wallet.getBalancePaise(user._id), 50000);

  const settled = await PaymentIntent.findById(intent._id);
  assert.equal(settled.status, 'paid');
  assert.ok(settled.settledAt);
});

test('an unsigned or wrongly signed delivery credits nothing', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user);

  const forged = await deliver(capturedBody(intent), { secret: 'not-the-secret' });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'INVALID_SIGNATURE');

  const bare = await api()
    .post('/api/wallet/webhook')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(capturedBody(intent)));
  assert.equal(bare.status, 400);

  assert.equal(await wallet.getBalancePaise(user._id), 0, 'a forged body must move nothing');
});

test('a signature is compared without leaking its length', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user);

  // timingSafeEqual throws on a length mismatch; a short signature must be
  // refused rather than crashing the handler into a 500.
  const short = await deliver(capturedBody(intent), { signature: 'abc' });
  assert.equal(short.status, 400);
  assert.equal(await wallet.getBalancePaise(user._id), 0);
});

// ---------------------------------------------------------------------------
// It cannot credit twice, whichever path gets there first
// ---------------------------------------------------------------------------

test('the webhook and the browser together credit exactly once', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user, 50000);
  const body = capturedBody(intent);
  const paymentId = body.payload.payment.entity.id;

  const first = await deliver(body);
  assert.equal(first.body.data.credited, true);

  // Razorpay retries a webhook it did not see acknowledged.
  const retry = await deliver(body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.credited, false, 'reported as already credited, not as an error');

  assert.equal(await wallet.getBalancePaise(user._id), 50000);
  assert.equal(
    await WalletTransaction.countDocuments({ idempotencyKey: `razorpay:${paymentId}` }),
    1,
    'the shared idempotency key is what makes the two paths safe to both run'
  );
});

test('two simultaneous deliveries of the same payment credit once', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user, 30000);
  const body = capturedBody(intent);

  const results = await Promise.all([deliver(body), deliver(body)]);
  for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal(await wallet.getBalancePaise(user._id), 30000);
});

// ---------------------------------------------------------------------------
// What it refuses to act on
// ---------------------------------------------------------------------------

test('a captured amount that does not match the recorded intent is not credited', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user, 50000);

  const body = capturedBody(intent);
  body.payload.payment.entity.amount = 100; // ₹1 claiming to settle a ₹500 intent

  const res = await deliver(body);

  // 200 so Razorpay stops retrying — the mismatch will never resolve itself —
  // but nothing is credited and the operator gets a loud log line.
  assert.equal(res.status, 200);
  assert.equal(res.body.data.handled, false);
  assert.equal(res.body.data.reason, 'AMOUNT_MISMATCH');
  assert.equal(await wallet.getBalancePaise(user._id), 0);
});

test('a mock intent is never settled by something claiming to be Razorpay', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await PaymentIntent.create({
    razorpayOrderId: `order_mock_${uniq()}`,
    user: user._id,
    amountPaise: 50000,
    purpose: 'wallet_topup',
    isMock: true,
  });

  const res = await deliver(capturedBody(intent));
  assert.equal(res.body.data.reason, 'MOCK_INTENT');
  assert.equal(await wallet.getBalancePaise(user._id), 0);
});

test('a payment for an order we never recorded is acknowledged and ignored', async () => {
  const res = await deliver({
    event: 'payment.captured',
    payload: {
      payment: { entity: { id: 'pay_stranger', order_id: 'order_stranger', amount: 100 } },
    },
  });

  assert.equal(res.status, 200, 'a 4xx here would get the webhook disabled');
  assert.equal(res.body.data.handled, false);
  assert.equal(res.body.data.reason, 'NO_INTENT');
});

test('an event we do not handle is acknowledged rather than retried', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user);

  const body = capturedBody(intent);
  body.event = 'refund.processed';

  const res = await deliver(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.handled, false);
  assert.equal(await wallet.getBalancePaise(user._id), 0);
});

test('a failed payment marks the intent without touching the ledger', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user);

  const body = capturedBody(intent);
  body.event = 'payment.failed';

  const res = await deliver(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.handled, true);

  assert.equal((await PaymentIntent.findById(intent._id)).status, 'failed');
  assert.equal(await wallet.getBalancePaise(user._id), 0);
});

test('a failed event never downgrades an intent already paid', async () => {
  const { user } = await authenticatedUser('customer');
  const intent = await seedIntent(user);

  await deliver(capturedBody(intent));

  const failure = capturedBody(intent);
  failure.event = 'payment.failed';
  await deliver(failure);

  const after = await PaymentIntent.findById(intent._id);
  assert.equal(after.status, 'paid', 'a late failure event must not rewrite a settled payment');
});

// ---------------------------------------------------------------------------
// It credits the intent owner, never the caller
// ---------------------------------------------------------------------------

test('the wallet credited is the intent owner, and the body cannot say otherwise', async () => {
  const payer = await authenticatedUser('customer');
  const stranger = await authenticatedUser('customer');
  const intent = await seedIntent(payer.user, 50000);

  // A webhook carries no session, so there is nothing to confuse it with. What
  // matters is that the recipient comes from the stored intent, not the body.
  const body = capturedBody(intent);
  body.payload.payment.entity.notes = { userId: stranger.user._id.toHexString() };

  await deliver(body);

  assert.equal(await wallet.getBalancePaise(payer.user._id), 50000);
  assert.equal(await wallet.getBalancePaise(stranger.user._id), 0);
});

test('the amount credited comes from the intent, not from anything sent to us', async () => {
  const { user, accessToken } = await authenticatedUser('customer');
  const intent = await seedIntent(user, 25000);

  await deliver(capturedBody(intent));

  const statement = await api().get('/api/wallet').set(auth(accessToken));
  assert.equal(statement.body.data.balancePaise, 25000);

  const entry = statement.body.data.transactions.find((t) => t.reason === 'razorpay_topup');
  assert.ok(entry, 'it lands as an ordinary statement line');
  assert.equal(entry.amountPaise, 25000);
});
