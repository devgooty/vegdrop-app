'use strict';

/**
 * Paying an independent shop.
 *
 * The market half of settlement had tests; this half had no code. A wallet-paid
 * order at an independent shop debited the customer and recorded no obligation
 * at all, so the shopkeeper was never paid and nothing anywhere reported a
 * problem — `recordDelivery` returned early on an order with no market, and the
 * release sweep can only pay what was recorded.
 *
 * These lean on the market suite for the parts that are shared (the hold, the
 * release, idempotency of the payout key) and cover only what differs: which
 * field says "delivered", who the obligation names, and the fact that it exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
  verifyVendor,
} = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const StallEarning = require('../models/StallEarning');
const settlement = require('../services/settlement');
const sweeper = require('../services/sweeper');
const wallet = require('../services/wallet');
const pickupCode = require('../services/pickupCode');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

const HYD = { lat: 17.385, lng: 78.4867 };

async function seedShop({ name = 'Ravi Vegetables' } = {}) {
  const shop = await authenticatedUser('shopkeeper');
  await verifyVendor(shop.user);
  await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ ...HYD, name, address: '12 Main Road' });
  return shop;
}

async function seedProduct(owner, { pricePaise = 9900 } = {}) {
  return Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise,
    stock: 500,
    owner: owner.user._id,
  });
}

/**
 * Buy from a shop and have a rider carry it to the door.
 *
 * A shopkeeper deliberately cannot mark an order Delivered — see
 * TRANSITION_PERMISSIONS in routes/orders.js — so this goes through a rider,
 * which is also why the platform ends up holding COD cash for a shop order and
 * therefore owes the shop either way.
 */
async function buyAndDeliver({ paymentMethod = 'wallet', pricePaise = 9900, quantity = 2 } = {}) {
  const shop = await seedShop();
  const product = await seedProduct(shop, { pricePaise });
  const customer = await authenticatedUser('customer');
  const rider = await authenticatedUser('delivery');
  const staff = await authenticatedUser('market_owner');

  if (paymentMethod === 'wallet') {
    await wallet.credit({
      userId: customer.user._id,
      amountPaise: 500000,
      reason: 'promotional_credit',
      idempotencyKey: `seed:${uniq()}`,
    });
  }

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity }],
      address: '12 Test Lane',
      paymentMethod,
      shopId: shop.user._id.toHexString(),
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const orderId = created.body.data.id;

  await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });
  await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Out for Delivery' });
  await api().post(`/api/orders/${orderId}/claim`).set(auth(rider.accessToken));

  // The rider proves the pickup at the shop before they can close it. Without
  // this the Delivered transition is refused with PICKUP_NOT_VERIFIED — you
  // cannot deliver what you never collected. See shopHandover.test.js.
  const stored = await Order.findById(orderId).lean();
  const pickedUp = await api()
    .post(`/api/orders/${orderId}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code: pickupCode.codeFor(orderId, pickupCode.sellerKeyFor(stored)) });
  assert.equal(pickedUp.status, 200, JSON.stringify(pickedUp.body));

  const delivered = await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(rider.accessToken))
    .send({ status: 'Delivered' });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

  return { shop, customer, rider, staff, orderId, product, pricePaise, quantity };
}

// ---------------------------------------------------------------------------
// The obligation exists at all
// ---------------------------------------------------------------------------

test('a wallet-paid shop order records what the shop is owed', async () => {
  const { shop, pricePaise, quantity } = await buyAndDeliver({ paymentMethod: 'wallet' });

  const earning = await StallEarning.findOne({ owner: shop.user._id });
  assert.ok(earning, 'this was the bug: the shopkeeper was paid nothing, for ever');
  assert.equal(earning.grossPaise, pricePaise * quantity);
  assert.equal(String(earning.shop), shop.user._id.toHexString());
  assert.equal(earning.stall, null, 'a shop sale has no stall');
  assert.equal(earning.market, null);
  assert.equal(earning.status, 'pending', 'it is held, exactly like a stall payout');
});

test('the delivery fee is the platform, not the shop', async () => {
  // ₹99 × 1 is under the free-delivery threshold, so a fee is charged.
  const { shop, orderId } = await buyAndDeliver({ quantity: 1, pricePaise: 9900 });

  const order = await Order.findById(orderId).lean();
  assert.ok(order.deliveryFeePaise > 0, 'the fixture needs an order that actually pays a fee');

  const earning = await StallEarning.findOne({ owner: shop.user._id });
  assert.equal(earning.grossPaise, order.subtotalPaise);
  assert.notEqual(earning.grossPaise, order.totalAmountPaise);
});

test('a COD shop order is recorded too, because the rider collected the cash', async () => {
  // Only a rider or an admin can mark an order Delivered, so the money reaches
  // the platform in both cases and the platform owes the shop in both cases.
  const { shop } = await buyAndDeliver({ paymentMethod: 'cod' });

  const earning = await StallEarning.findOne({ owner: shop.user._id });
  assert.ok(earning, 'COD is what hid this bug — it must be covered, not assumed');
});

test('a shop is owed nothing until the customer actually has the goods', async () => {
  const shop = await seedShop();
  const product = await seedProduct(shop);
  const customer = await authenticatedUser('customer');

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      shopId: shop.user._id.toHexString(),
    });

  await api()
    .patch(`/api/orders/${created.body.data.id}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });

  assert.equal(await StallEarning.countDocuments({ owner: shop.user._id }), 0);
});

// ---------------------------------------------------------------------------
// It is recorded once, and it reaches the wallet
// ---------------------------------------------------------------------------

test('recording twice leaves one obligation', async () => {
  const { shop, orderId } = await buyAndDeliver();

  // The unique (order, stall) index covers the shop case because `stall` is
  // null on both documents, so the second presents the same pair.
  const again = await settlement.recordDelivery(orderId);
  assert.equal(again.recorded, 0);
  assert.equal(await StallEarning.countDocuments({ owner: shop.user._id }), 1);
});

test('the held money reaches the shopkeeper wallet once the hold expires', async () => {
  const { shop, pricePaise, quantity } = await buyAndDeliver();

  assert.equal(await wallet.getBalancePaise(shop.user._id), 0, 'held, not paid');

  await StallEarning.updateOne(
    { owner: shop.user._id },
    { $set: { releaseAt: new Date(Date.now() - 1000) } }
  );
  await sweeper.tick();

  assert.equal(await wallet.getBalancePaise(shop.user._id), pricePaise * quantity);

  // And a second sweep must not pay it again.
  await sweeper.tick();
  assert.equal(await wallet.getBalancePaise(shop.user._id), pricePaise * quantity);
});

test('a delivery whose payout record was lost is caught by the backfill', async () => {
  const { shop, orderId } = await buyAndDeliver();

  // Simulate the crash between confirming delivery and recording the debt.
  await StallEarning.deleteMany({ owner: shop.user._id });
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.settledAt': null } });

  await sweeper.tick();

  assert.equal(
    await StallEarning.countDocuments({ owner: shop.user._id }),
    1,
    'the backfill only queried fulfillment.status, which a shop order never sets'
  );
});

// ---------------------------------------------------------------------------
// The shopkeeper can actually see and take it
// ---------------------------------------------------------------------------

test('a shopkeeper with no stall can read their earnings', async () => {
  const { shop, pricePaise, quantity } = await buyAndDeliver();

  // /api/stalls/me/earnings is gated on having a stall, so before this route
  // existed an independent shopkeeper had no way to reach their own money.
  const res = await api().get('/api/shops/me/earnings').set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pendingPaise, pricePaise * quantity);
  assert.equal(res.body.data.recent.length, 1);
  assert.equal(res.body.data.recent[0].seller, 'shop');

  const stallRoute = await api().get('/api/stalls/me/earnings').set(auth(shop.accessToken));
  assert.equal(stallRoute.status, 404, 'still not a stall');
});

test('a shopkeeper can withdraw early once past the floor', async () => {
  const { shop } = await buyAndDeliver({ pricePaise: 9900, quantity: 3 }); // ₹297

  const res = await api().post('/api/shops/me/earnings/withdraw').set(auth(shop.accessToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.released, 1);
  assert.equal(await wallet.getBalancePaise(shop.user._id), 29700);
  assert.equal(res.body.data.pendingPaise, 0);
});

test('below the floor the withdrawal is refused with the shortfall', async () => {
  const { shop } = await buyAndDeliver({ pricePaise: 1000, quantity: 1 }); // ₹10

  const res = await api().post('/api/shops/me/earnings/withdraw').set(auth(shop.accessToken));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'BELOW_MINIMUM');
  assert.equal(await wallet.getBalancePaise(shop.user._id), 0);
});

test('one shop never sees another takings', async () => {
  const { shop } = await buyAndDeliver();
  const other = await seedShop({ name: 'Someone Else' });

  const res = await api().get('/api/shops/me/earnings').set(auth(other.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pendingPaise, 0);
  assert.equal(res.body.data.recent.length, 0);

  const mine = await api().get('/api/shops/me/earnings').set(auth(shop.accessToken));
  assert.ok(mine.body.data.pendingPaise > 0);
});

test('a customer cannot read a shop earnings', async () => {
  const customer = await authenticatedUser('customer');
  const res = await api().get('/api/shops/me/earnings').set(auth(customer.accessToken));
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// The model refuses a half-built obligation
// ---------------------------------------------------------------------------

test('an earning must name exactly one seller', async () => {
  const owner = await authenticatedUser('shopkeeper');
  const base = {
    owner: owner.user._id,
    order: owner.user._id, // any ObjectId; the validator runs before the ref
    orderNumber: 'VB-TEST',
    lines: [{ name: 'Tomato', quantity: 1, unitPricePaise: 100, lineTotalPaise: 100 }],
    grossPaise: 100,
    netPaise: 100,
    earnedAt: new Date(),
    releaseAt: new Date(),
  };

  await assert.rejects(
    () => StallEarning.create(base),
    /exactly one/,
    'neither seller means nobody could ever be paid it'
  );

  await assert.rejects(
    () => StallEarning.create({ ...base, stall: owner.user._id, shop: owner.user._id }),
    /exactly one/,
    'both is ambiguous about which catalog priced it'
  );

  await assert.rejects(
    () => StallEarning.create({ ...base, stall: owner.user._id }),
    /market/,
    'a stall earning without its market cannot be reported to the market owner'
  );
});
