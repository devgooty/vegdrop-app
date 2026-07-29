'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  createUser,
  authenticatedUser,
  auth,
} = require('./helpers');

const Product = require('../models/Product');
const WalletTransaction = require('../models/WalletTransaction');
const PaymentIntent = require('../models/PaymentIntent');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

async function seedProduct(overrides = {}) {
  return Product.create({
    sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
    categoryId: 1,
    name: 'Test Tomatoes',
    pricePaise: 4000,
    stock: 10,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Unauthenticated access
// ---------------------------------------------------------------------------

test('sensitive endpoints reject unauthenticated callers', async () => {
  const product = await seedProduct();
  const { user } = await createUser();
  const id = user._id.toHexString();

  const cases = [
    ['get', '/api/orders'],
    ['get', '/api/users'],
    ['get', '/api/wallet'],
    ['post', '/api/orders'],
    ['patch', `/api/users/${id}`],
    ['delete', `/api/users/${id}`],
    ['patch', `/api/products/${product._id}/stock`],
    ['patch', `/api/users/${id}/role`],
  ];

  for (const [method, path] of cases) {
    const res = await api()[method](path).send({});
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should require authentication`);
  }
});

test('the product catalog remains publicly readable', async () => {
  await seedProduct();
  const res = await api().get('/api/products');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
});

// ---------------------------------------------------------------------------
// Role enforcement
// ---------------------------------------------------------------------------

test('a customer cannot list all users', async () => {
  const { accessToken } = await authenticatedUser('customer');
  const res = await api().get('/api/users').set(auth(accessToken));
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
});

test('a customer cannot change product stock', async () => {
  const product = await seedProduct();
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .patch(`/api/products/${product._id}/stock`)
    .set(auth(accessToken))
    .send({ stock: 9999 });

  assert.equal(res.status, 403);

  const unchanged = await Product.findById(product._id);
  assert.equal(unchanged.stock, 10);
});

test('a shopkeeper can change product stock', async () => {
  const product = await seedProduct();
  const { accessToken } = await authenticatedUser('shopkeeper');

  const res = await api()
    .patch(`/api/products/${product._id}/stock`)
    .set(auth(accessToken))
    .send({ stock: 42 });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.stock, 42);
});

test('a customer cannot delete another account', async () => {
  const victim = await createUser({ role: 'customer' });
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .delete(`/api/users/${victim.user._id}`)
    .set(auth(accessToken));

  assert.equal(res.status, 403);
});

test('a customer cannot read another user record', async () => {
  const other = await createUser({ role: 'customer' });
  const { accessToken } = await authenticatedUser('customer');

  const res = await api().get(`/api/users/${other.user._id}`).set(auth(accessToken));
  // 404 rather than 403: existence is not disclosed.
  assert.equal(res.status, 404);
});

test('a user cannot promote themselves via profile update', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .patch(`/api/users/${user._id}`)
    .set(auth(accessToken))
    .send({ name: 'New Name', role: 'developer' });

  assert.equal(res.status, 400, 'an unknown key must fail the request outright');
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('an admin cannot change their own role', async () => {
  const { accessToken, user } = await authenticatedUser('market_owner');

  const res = await api()
    .patch(`/api/users/${user._id}/role`)
    .set(auth(accessToken))
    .send({ role: 'developer' });

  assert.equal(res.status, 403);
});

test('an admin can change another user role, and it takes effect immediately', async () => {
  const target = await createUser({ role: 'customer' });
  const { accessToken } = await authenticatedUser('market_owner');

  const res = await api()
    .patch(`/api/users/${target.user._id}/role`)
    .set(auth(accessToken))
    .send({ role: 'shopkeeper' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.role, 'shopkeeper');
});

// ---------------------------------------------------------------------------
// Orders: server-computed totals
// ---------------------------------------------------------------------------

test('order totals are recomputed server-side and client prices are ignored', async () => {
  const product = await seedProduct({ pricePaise: 4000, stock: 10 });
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .post('/api/orders')
    .set(auth(accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 2 }],
      address: '12 Test Street, Hyderabad',
      paymentMethod: 'cod',
    });

  assert.equal(res.status, 201);
  // 2 × ₹40 = ₹80 subtotal, below the free-delivery threshold, so + ₹25.
  assert.equal(res.body.data.subtotalPaise, 8000);
  assert.equal(res.body.data.deliveryFeePaise, 2500);
  assert.equal(res.body.data.totalAmountPaise, 10500);
});

test('an order cannot smuggle its own total or paid status', async () => {
  const product = await seedProduct();
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .post('/api/orders')
    .set(auth(accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 1 }],
      address: '12 Test Street',
      paymentMethod: 'cod',
      totalAmountPaise: 1,
      paymentStatus: 'paid',
      status: 'Delivered',
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('ordering more than the available stock fails and does not consume stock', async () => {
  const product = await seedProduct({ stock: 3 });
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .post('/api/orders')
    .set(auth(accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 5 }],
      address: '12 Test Street',
      paymentMethod: 'cod',
    });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');

  const after = await Product.findById(product._id);
  assert.equal(after.stock, 3, 'stock must be restored when an order fails');
});

test('a customer sees only their own orders', async () => {
  const product = await seedProduct({ stock: 50 });
  const alice = await authenticatedUser('customer');
  const bob = await authenticatedUser('customer');

  await api()
    .post('/api/orders')
    .set(auth(alice.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 1 }],
      address: 'Alice Street',
      paymentMethod: 'cod',
    })
    .expect(201);

  const bobsView = await api().get('/api/orders').set(auth(bob.accessToken));
  assert.equal(bobsView.status, 200);
  assert.equal(bobsView.body.data.length, 0, "another customer's orders must not be visible");

  const alicesView = await api().get('/api/orders').set(auth(alice.accessToken));
  assert.equal(alicesView.body.data.length, 1);
});

test('a customer cannot mark their own order Delivered', async () => {
  const product = await seedProduct({ stock: 10 });
  const { accessToken } = await authenticatedUser('customer');

  const created = await api()
    .post('/api/orders')
    .set(auth(accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 1 }],
      address: 'Test Street',
      paymentMethod: 'cod',
    });

  const res = await api()
    .patch(`/api/orders/${created.body.data.id}/status`)
    .set(auth(accessToken))
    .send({ status: 'Delivered' });

  assert.equal(res.status, 403);
});

test('illegal status transitions are rejected', async () => {
  const product = await seedProduct({ stock: 10 });
  const customer = await authenticatedUser('customer');
  const shopkeeper = await authenticatedUser('shopkeeper');

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 1 }],
      address: 'Test Street',
      paymentMethod: 'cod',
    });

  // Pending → Out for Delivery skips Preparing.
  const res = await api()
    .patch(`/api/orders/${created.body.data.id}/status`)
    .set(auth(shopkeeper.accessToken))
    .send({ status: 'Out for Delivery' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INVALID_TRANSITION');
});

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

test('a new wallet starts at zero and cannot be set by the client', async () => {
  const { accessToken } = await authenticatedUser('customer');

  const res = await api().get('/api/wallet').set(auth(accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.balancePaise, 0);
});

test('paying with an empty wallet is refused', async () => {
  const product = await seedProduct({ stock: 10 });
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .post('/api/orders')
    .set(auth(accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 1 }],
      address: 'Test Street',
      paymentMethod: 'wallet',
    });

  assert.equal(res.status, 402);
  assert.equal(res.body.error.code, 'INSUFFICIENT_FUNDS');
});

test('a wallet credit is idempotent under replay', async () => {
  const { user } = await createUser();
  const walletService = require('../services/wallet');

  const first = await walletService.credit({
    userId: user._id,
    amountPaise: 50000,
    reason: 'razorpay_topup',
    idempotencyKey: 'razorpay:pay_replaytest',
  });
  const second = await walletService.credit({
    userId: user._id,
    amountPaise: 50000,
    reason: 'razorpay_topup',
    idempotencyKey: 'razorpay:pay_replaytest',
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.balancePaise, 50000, 'a replay must not credit twice');

  const entries = await WalletTransaction.countDocuments({ user: user._id });
  assert.equal(entries, 1);
});

test('a top-up cannot be verified against another user payment intent', async () => {
  const victim = await createUser({ role: 'customer' });
  const attacker = await authenticatedUser('customer');

  await PaymentIntent.create({
    razorpayOrderId: 'order_victim_123',
    user: victim.user._id,
    amountPaise: 100000,
    isMock: true,
  });

  const res = await api()
    .post('/api/wallet/topup/verify')
    .set(auth(attacker.accessToken))
    .send({
      razorpay_order_id: 'order_victim_123',
      razorpay_payment_id: 'pay_attacker_123',
      razorpay_signature: 'a'.repeat(64),
    });

  assert.equal(res.status, 404, "another user's payment must not be claimable");

  const balance = await api().get('/api/wallet').set(auth(attacker.accessToken));
  assert.equal(balance.body.data.balancePaise, 0);
});

test('the credited amount comes from the recorded intent, not the request', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const created = await api()
    .post('/api/wallet/topup/create')
    .set(auth(accessToken))
    .send({ amount: 100 }); // ₹100
  assert.equal(created.status, 201);
  assert.equal(created.body.data.amountPaise, 10000);

  const res = await api()
    .post('/api/wallet/topup/verify')
    .set(auth(accessToken))
    .send({
      razorpay_order_id: created.body.data.razorpayOrderId,
      razorpay_payment_id: 'pay_mock_abc123',
      razorpay_signature: 'x'.repeat(64),
      amount: 999999,
    });

  // The inflated `amount` key is not part of the schema.
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');

  const honest = await api()
    .post('/api/wallet/topup/verify')
    .set(auth(accessToken))
    .send({
      razorpay_order_id: created.body.data.razorpayOrderId,
      razorpay_payment_id: 'pay_mock_abc123',
      razorpay_signature: 'x'.repeat(64),
    });

  assert.equal(honest.status, 200);
  assert.equal(honest.body.data.balancePaise, 10000, 'credited exactly the intent amount');
});
