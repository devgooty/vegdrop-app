'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
} = require('./helpers');

const config = require('../config/env');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallEarning = require('../models/StallEarning');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const sourcing = require('../services/sourcing');
const settlement = require('../services/settlement');
const sweeper = require('../services/sweeper');
const wallet = require('../services/wallet');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedProduct(name = 'Tomato') {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise: 4000, stock: 500 });
}

async function seedMarket() {
  return Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
  });
}

async function seedStallWithOwner(market, stallNumber = 'A-1') {
  const session = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: session.user._id,
  });
  return { ...session, stall };
}

async function seedRider(market) {
  const session = await authenticatedUser('delivery');
  await User.updateOne(
    { _id: session.user._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: market.location.coordinates },
        'rider.lastLocationAt': new Date(),
      },
    }
  );
  return session;
}

/**
 * Drive one order all the way from checkout to the customer's door.
 *
 * @returns the order id, plus everyone involved.
 */
async function completeDelivery({ unitPricePaise = 4000, quantity = 2, stallCount = 1 } = {}) {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();

  const products = await Promise.all(
    Array.from({ length: stallCount }, (_, i) => seedProduct(`Item ${i}`))
  );
  await MarketPrice.insertMany(
    products.map((p) => ({ market: market._id, product: p._id, pricePaise: unitPricePaise }))
  );

  const shops = [];
  for (let i = 0; i < stallCount; i += 1) {
    shops.push(await seedStallWithOwner(market, `A-${i + 1}`));
  }
  const rider = await seedRider(market);

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: products.map((p) => ({ productId: p._id.toHexString(), quantity })),
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  const orderId = created.body.data.id;
  const lines = created.body.data.items;

  // Each stall takes one line.
  for (let i = 0; i < stallCount; i += 1) {
    await api()
      .post(`/api/stalls/orders/${orderId}/claim`)
      .set(auth(shops[i].accessToken))
      .send({ lineIds: [lines[i].lineId] });
  }
  await sourcing.settlePending();

  await api().post(`/api/rider/orders/${orderId}/accept`).set(auth(rider.accessToken));
  for (const shop of shops) {
    await api().post(`/api/stalls/orders/${orderId}/pack`).set(auth(shop.accessToken)).send({});
  }
  for (const shop of shops) {
    await api()
      .post(`/api/rider/orders/${orderId}/collect`)
      .set(auth(rider.accessToken))
      .send({ stallId: shop.stall._id.toHexString() });
  }
  await api().post(`/api/rider/orders/${orderId}/deliver`).set(auth(rider.accessToken));

  return { orderId, customer, market, shops, rider, products };
}

// ---------------------------------------------------------------------------
// Nothing moves before delivery
// ---------------------------------------------------------------------------

test('a stall is owed nothing until the customer actually has the goods', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market);

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  await api()
    .post(`/api/stalls/orders/${created.body.data.id}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });
  await api().post(`/api/stalls/orders/${created.body.data.id}/pack`).set(auth(shop.accessToken)).send({});

  // Accepted and packed — but not delivered.
  assert.equal(await StallEarning.countDocuments({ owner: shop.user._id }), 0);
  assert.equal(await wallet.getBalancePaise(shop.user._id), 0);

  const earnings = await api().get('/api/stalls/me/earnings').set(auth(shop.accessToken));
  assert.equal(earnings.body.data.pendingPaise, 0);
  assert.equal(earnings.body.data.releasedPaise, 0);
});

test('a stall that packed an order that was then cancelled is paid nothing', async () => {
  const customer = await authenticatedUser('customer');
  const owner = await authenticatedUser('market_owner');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market);

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  await api()
    .post(`/api/stalls/orders/${created.body.data.id}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });

  await api()
    .patch(`/api/orders/${created.body.data.id}/status`)
    .set(auth(owner.accessToken))
    .send({ status: 'Cancelled' });

  await sweeper.sweepSettlements();

  assert.equal(await StallEarning.countDocuments({ owner: shop.user._id }), 0, 'no sale, no payout');
  assert.equal(await wallet.getBalancePaise(shop.user._id), 0);
});

// ---------------------------------------------------------------------------
// Delivery records the debt, but holds the money
// ---------------------------------------------------------------------------

test('delivery records what is owed and starts a 24 hour hold, wallet untouched', async () => {
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 2 });
  const shop = shops[0];

  const earning = await StallEarning.findOne({ owner: shop.user._id });
  assert.ok(earning, 'the obligation is recorded at delivery');
  assert.equal(earning.status, 'pending');
  assert.equal(earning.grossPaise, 8000, '2 × ₹40');
  assert.equal(earning.netPaise, 8000);

  const holdMs = earning.releaseAt.getTime() - earning.earnedAt.getTime();
  assert.equal(holdMs, config.settlement.holdHours * 3600 * 1000);

  // And crucially: not a rupee in the wallet yet.
  assert.equal(await wallet.getBalancePaise(shop.user._id), 0, 'held, not paid');

  const summary = await api().get('/api/stalls/me/earnings').set(auth(shop.accessToken));
  assert.equal(summary.body.data.pendingPaise, 8000);
  assert.equal(summary.body.data.releasedPaise, 0);
  assert.equal(summary.body.data.holdHours, 24);
  assert.ok(summary.body.data.nextReleaseAt);
});

test('each stall on a shared order is paid only for its own lines', async () => {
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 3, stallCount: 2 });

  const [a, b] = await Promise.all([
    StallEarning.findOne({ owner: shops[0].user._id }),
    StallEarning.findOne({ owner: shops[1].user._id }),
  ]);

  assert.equal(a.netPaise, 12000, '3 × ₹40 for its one line');
  assert.equal(b.netPaise, 12000);
  assert.equal(a.lines.length, 1);
  assert.notEqual(String(a.order), null);
  assert.equal(String(a.order), String(b.order), 'same order, two obligations');
});

// ---------------------------------------------------------------------------
// The hold expiring
// ---------------------------------------------------------------------------

test('once the hold expires the money lands in the wallet on its own', async () => {
  const { shops } = await completeDelivery();
  const shop = shops[0];

  // Nothing due yet.
  let swept = await sweeper.sweepSettlements();
  assert.equal(swept.released, 0);
  assert.equal(await wallet.getBalancePaise(shop.user._id), 0);

  // Wind the clock past the hold rather than waiting a day.
  await StallEarning.updateMany(
    { owner: shop.user._id },
    { $set: { releaseAt: new Date(Date.now() - 1000) } }
  );

  swept = await sweeper.sweepSettlements();
  assert.equal(swept.released, 1);
  assert.equal(swept.paidPaise, 8000);

  assert.equal(await wallet.getBalancePaise(shop.user._id), 8000, 'paid without anyone asking');

  const earning = await StallEarning.findOne({ owner: shop.user._id });
  assert.equal(earning.status, 'released');
  assert.equal(earning.releasedEarly, false);
  assert.ok(earning.releasedAt);
  assert.ok(earning.walletTransaction);
});

test('running the release twice pays exactly once', async () => {
  const { shops } = await completeDelivery();
  const shop = shops[0];

  await StallEarning.updateMany(
    { owner: shop.user._id },
    { $set: { releaseAt: new Date(Date.now() - 1000) } }
  );

  await sweeper.sweepSettlements();
  const afterFirst = await wallet.getBalancePaise(shop.user._id);

  // Force the obligation back to pending, as a crashed worker would leave it,
  // and sweep again. The wallet's idempotency key is the real guard.
  await StallEarning.updateMany({ owner: shop.user._id }, { $set: { status: 'pending' } });
  await sweeper.sweepSettlements();

  assert.equal(await wallet.getBalancePaise(shop.user._id), afterFirst, 'no double payout');
  assert.equal(
    await WalletTransaction.countDocuments({ user: shop.user._id, reason: 'stall_settlement' }),
    1
  );
});

test('two workers releasing the same earning at once pay once', async () => {
  const { shops } = await completeDelivery();
  const shop = shops[0];

  await StallEarning.updateMany(
    { owner: shop.user._id },
    { $set: { releaseAt: new Date(Date.now() - 1000) } }
  );

  await Promise.all([settlement.releaseDue(), settlement.releaseDue()]);

  assert.equal(await wallet.getBalancePaise(shop.user._id), 8000);
  assert.equal(
    await WalletTransaction.countDocuments({ user: shop.user._id, reason: 'stall_settlement' }),
    1
  );
});

test('a delivery whose payout record was lost is picked up by the backfill', async () => {
  const { orderId, shops } = await completeDelivery();
  const shop = shops[0];

  // Simulate a crash between confirming delivery and recording the obligation.
  await StallEarning.deleteMany({});
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.settledAt': null } });

  const swept = await sweeper.sweepSettlements();
  assert.equal(swept.backfilled, 1);

  const earning = await StallEarning.findOne({ owner: shop.user._id });
  assert.ok(earning, 'the obligation is reconstructed rather than silently lost');
  assert.equal(earning.netPaise, 8000);
});

// ---------------------------------------------------------------------------
// Taking it early — the ₹200 floor
// ---------------------------------------------------------------------------

test('withdrawing early is refused below ₹200, and says how short they are', async () => {
  // ₹40 × 2 = ₹80, well under the floor.
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 2 });
  const shop = shops[0];

  const res = await api().post('/api/stalls/me/earnings/withdraw').set(auth(shop.accessToken));

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'BELOW_MINIMUM');
  assert.match(res.body.error.message, /at least ₹200/);
  assert.match(res.body.error.message, /₹80\.00/, 'tells them what they actually have');

  assert.equal(await wallet.getBalancePaise(shop.user._id), 0);
  assert.equal((await StallEarning.findOne({ owner: shop.user._id })).status, 'pending');
});

test('withdrawing early works at ₹200 and pays out everything pending', async () => {
  // ₹40 × 6 = ₹240, over the floor.
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 6 });
  const shop = shops[0];

  const before = await api().get('/api/stalls/me/earnings').set(auth(shop.accessToken));
  assert.equal(before.body.data.pendingPaise, 24000);
  assert.equal(before.body.data.canWithdrawNow, true);
  assert.equal(before.body.data.minEarlyPayoutPaise, 20000);

  const res = await api().post('/api/stalls/me/earnings/withdraw').set(auth(shop.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.paidPaise, 24000, 'everything, not just the ₹200 floor');
  assert.equal(res.body.data.pendingPaise, 0);
  assert.equal(res.body.data.releasedPaise, 24000);

  assert.equal(await wallet.getBalancePaise(shop.user._id), 24000);

  const earning = await StallEarning.findOne({ owner: shop.user._id });
  assert.equal(earning.status, 'released');
  assert.equal(earning.releasedEarly, true, 'recorded as an early payout, not an automatic one');
});

test('an early payout is not paid a second time when the hold later expires', async () => {
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 6 });
  const shop = shops[0];

  await api().post('/api/stalls/me/earnings/withdraw').set(auth(shop.accessToken));
  assert.equal(await wallet.getBalancePaise(shop.user._id), 24000);

  // The hold expires afterwards. The sweeper must not find anything to do.
  await StallEarning.updateMany({ owner: shop.user._id }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
  const swept = await sweeper.sweepSettlements();

  assert.equal(swept.released, 0);
  assert.equal(await wallet.getBalancePaise(shop.user._id), 24000);
});

test('a shopkeeper can only ever withdraw their own earnings', async () => {
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 6, stallCount: 2 });
  const [a, b] = shops;

  await api().post('/api/stalls/me/earnings/withdraw').set(auth(a.accessToken));

  assert.equal(await wallet.getBalancePaise(a.user._id), 24000);
  assert.equal(await wallet.getBalancePaise(b.user._id), 0, "another stall's money is untouched");
  assert.equal((await StallEarning.findOne({ owner: b.user._id })).status, 'pending');
});

test('the money a shopkeeper is paid can be spent like any other wallet balance', async () => {
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 6 });
  const shop = shops[0];

  await api().post('/api/stalls/me/earnings/withdraw').set(auth(shop.accessToken));

  const statement = await api().get('/api/wallet').set(auth(shop.accessToken));
  assert.equal(statement.status, 200);
  assert.equal(statement.body.data.balancePaise, 24000);

  const entry = statement.body.data.transactions.find((t) => t.reason === 'stall_settlement');
  assert.ok(entry, 'it shows up as a normal statement line');
  assert.equal(entry.type, 'credit');
  assert.match(entry.note, /stall A-1/);
});

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

test('commission is zero by default, so the stall receives the full market price', async () => {
  const { shops } = await completeDelivery({ unitPricePaise: 4000, quantity: 2 });
  const earning = await StallEarning.findOne({ owner: shops[0].user._id });

  assert.equal(earning.commissionPaise, 0);
  assert.equal(earning.netPaise, earning.grossPaise);
});
