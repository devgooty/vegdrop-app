'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { startTestServer, stopTestServer, resetDatabase, createUser } = require('./helpers');

const config = require('../config/env');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const sourcing = require('../services/sourcing');
const dispatch = require('../services/dispatch');
const pickupCode = require('../services/pickupCode');
const sweeper = require('../services/sweeper');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function newUser(role) {
  const { user } = await createUser({ role });
  return user;
}

async function seedProduct(name = 'Tomato') {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise: 4000, stock: 500 });
}

async function seedMarket({ lng = 78.4867, lat = 17.385 } = {}) {
  return Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [lng, lat] },
  });
}

async function seedStall(market, stallNumber) {
  const owner = await newUser('shopkeeper');
  return Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: owner._id,
    status: 'approved',
  });
}

/**
 * A rider standing at a given point, on duty and freshly pinged.
 * `metresEast` offsets from the market so distance ordering is predictable.
 */
async function seedRider({ market, metresEast = 0, dutyStatus = 'online', ageSeconds = 0 }) {
  const rider = await newUser('delivery');
  const [lng, lat] = market.location.coordinates;
  // ~111,320 m per degree of longitude at the equator; close enough near 17°N
  // for "this one is further than that one" to hold.
  const offsetDeg = metresEast / (111320 * Math.cos((lat * Math.PI) / 180));

  await User.updateOne(
    { _id: rider._id },
    {
      $set: {
        'rider.dutyStatus': dutyStatus,
        'rider.lastLocation': { type: 'Point', coordinates: [lng + offsetDeg, lat] },
        'rider.lastLocationAt': new Date(Date.now() - ageSeconds * 1000),
      },
    }
  );

  return rider;
}

/** An order already claimed by one stall and therefore sitting in `packing`. */
async function seedPackingOrder({ market, stall, lineCount = 1 }) {
  const customer = await newUser('customer');
  const products = await Promise.all(
    Array.from({ length: lineCount }, (_, i) => seedProduct(`Item ${i}`))
  );

  const items = products.map((p) => ({
    product: p._id,
    name: p.name,
    unitPricePaise: 4000,
    quantity: 1,
    lineTotalPaise: 4000,
    lineId: new mongoose.Types.ObjectId(),
    sourcePricePaise: 4000,
    claim: sourcing.emptyClaim(),
  }));

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Test Lane',
    items,
    subtotalPaise: 4000 * lineCount,
    totalAmountPaise: 4000 * lineCount,
    paymentMethod: 'cod',
    status: 'Pending',
    market: market._id,
    marketName: market.name,
    fulfillment: sourcing.initialFulfillment(market._id),
  });

  await sourcing.claimLines({
    orderId: order._id,
    stallId: stall._id,
    stallNumber: stall.stallNumber,
    lineIds: items.map((i) => i.lineId),
  });

  // Locking an order calls a rider without blocking the shopkeeper, so the
  // offer lands a moment later. Wait for the system to go quiet rather than
  // sleeping and hoping.
  await sourcing.settlePending();

  return Order.findById(order._id);
}

// ---------------------------------------------------------------------------
// Choosing a rider
// ---------------------------------------------------------------------------

test('the pickup goes to the rider nearest the market', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');

  const far = await seedRider({ market, metresEast: 3000 });
  const near = await seedRider({ market, metresEast: 200 });

  const order = await seedPackingOrder({ market, stall });
  // Promotion already fired dispatch; clear it so this test drives the choice.
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer': { rider: null, expiresAt: null, count: 0, declinedBy: [], openPool: false } } }
  );

  const result = await dispatch.offerToNearestRider(order._id);

  assert.equal(result.offered, true);
  assert.equal(String(result.rider._id), String(near._id), 'the closer rider should be asked first');
  assert.notEqual(String(result.rider._id), String(far._id));
});

test('an off-duty rider is never offered a pickup', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  await seedRider({ market, metresEast: 100, dutyStatus: 'offline' });

  const order = await seedPackingOrder({ market, stall });
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer': { rider: null, expiresAt: null, count: 0, declinedBy: [], openPool: false } } }
  );

  const result = await dispatch.offerToNearestRider(order._id);
  assert.equal(result.offered, false);
  assert.equal(result.reason, 'NO_RIDER_AVAILABLE');
});

test('a rider whose position has gone stale is treated as gone', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');

  // Online, but last heard from well beyond the freshness window.
  await seedRider({
    market,
    metresEast: 100,
    ageSeconds: config.marketplace.riderStaleLocationSeconds + 60,
  });

  const order = await seedPackingOrder({ market, stall });
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer': { rider: null, expiresAt: null, count: 0, declinedBy: [], openPool: false } } }
  );

  const result = await dispatch.offerToNearestRider(order._id);
  assert.equal(result.offered, false, 'a killed app never gets to say it went offline');
});

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

test('declining passes the pickup to the next nearest rider', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const near = await seedRider({ market, metresEast: 100 });
  const next = await seedRider({ market, metresEast: 900 });

  const order = await seedPackingOrder({ market, stall });
  const offered = await Order.findById(order._id);
  assert.equal(String(offered.fulfillment.riderOffer.rider), String(near._id));

  const result = await dispatch.declineOffer({ orderId: order._id, riderId: near._id });
  assert.equal(result.declined, true);

  const after = await Order.findById(order._id);
  assert.equal(String(after.fulfillment.riderOffer.rider), String(next._id));
  assert.equal(after.fulfillment.riderOffer.declinedBy.length, 1);
  assert.equal(String(after.fulfillment.riderOffer.declinedBy[0]), String(near._id));
});

test('an unanswered offer expires and moves on, and never returns to that rider', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const near = await seedRider({ market, metresEast: 100 });
  const next = await seedRider({ market, metresEast: 900 });

  const order = await seedPackingOrder({ market, stall });
  assert.equal(String((await Order.findById(order._id)).fulfillment.riderOffer.rider), String(near._id));

  // Force the offer shut rather than waiting out the real timeout.
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer.expiresAt': new Date(Date.now() - 1000) } }
  );

  const result = await dispatch.expireOffer(order._id);
  assert.equal(result.action, 'reoffered');

  const after = await Order.findById(order._id);
  assert.equal(String(after.fulfillment.riderOffer.rider), String(next._id));
  assert.ok(
    after.fulfillment.riderOffer.declinedBy.some((id) => String(id) === String(near._id)),
    'a rider who did not answer must not be asked again'
  );
});

test('the cascade gives up after enough refusals and opens the order to anyone', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider({ market, metresEast: 100 });

  const order = await seedPackingOrder({ market, stall });

  // Burn through the offer budget.
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        'fulfillment.riderOffer.count': config.marketplace.riderMaxOffers,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
      },
    }
  );

  const result = await dispatch.offerToNearestRider(order._id);
  assert.equal(result.reason, 'OPEN_POOL');

  const after = await Order.findById(order._id);
  assert.equal(after.fulfillment.riderOffer.openPool, true);

  // And now anyone may take it, including a rider who was never offered it.
  const accepted = await dispatch.acceptOffer({ orderId: order._id, riderId: rider._id });
  assert.equal(accepted.accepted, true);
});

/**
 * The thin-coverage case the open pool was actually written for.
 *
 * The test above forces `count` to the cap, which is the one way to reach the
 * pool that never exercises the path a real market takes. Walk it properly with
 * a single rider and the backstop used to be unreachable: an expiry adds that
 * rider to `declinedBy`, so they are excluded from every later search, while
 * `count` only advances when an offer is actually made. It froze at one, the
 * candidate list stayed empty, and the order sat until the sourcing window
 * expired — in exactly the sparsely covered area the pool exists to rescue.
 */
test('one rider who lets the offer lapse still gets it back through the open pool', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider({ market, metresEast: 100 });

  const order = await seedPackingOrder({ market, stall });

  // The offer already went out when the stall claimed the last line. Let it die.
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer.expiresAt': new Date(Date.now() - 1000) } }
  );
  await dispatch.expireOffer(order._id);

  const afterExpiry = await Order.findById(order._id).lean();
  assert.equal(afterExpiry.fulfillment.riderOffer.declinedBy.length, 1);
  assert.ok(
    afterExpiry.fulfillment.riderOffer.count < config.marketplace.riderMaxOffers,
    'the count must still be short of the cap — that is the whole trap'
  );

  // The sweeper tries again. There is nobody new to ask, so it must give up on
  // cascading rather than spin for ever.
  const retry = await dispatch.offerToNearestRider(order._id);
  assert.equal(retry.reason, 'OPEN_POOL');

  const pooled = await Order.findById(order._id).lean();
  assert.equal(pooled.fulfillment.riderOffer.openPool, true);

  // And the rider who missed it can now take it.
  const accepted = await dispatch.acceptOffer({ orderId: order._id, riderId: rider._id });
  assert.equal(accepted.accepted, true, 'the only rider in town must be able to pick it back up');
});

/**
 * The other side of that branch: an order with nobody online yet must NOT be
 * dumped straight into the pool, or the nearest-first ordering is thrown away
 * before a single rider has been asked.
 */
test('an order waiting for the first rider to come online is not pooled', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const order = await seedPackingOrder({ market, stall });

  const result = await dispatch.offerToNearestRider(order._id);
  assert.equal(result.reason, 'NO_RIDER_AVAILABLE');

  const after = await Order.findById(order._id).lean();
  assert.equal(after.fulfillment.riderOffer.openPool, false);

  // A rider arriving now gets a targeted offer, nearest first, as intended.
  const rider = await seedRider({ market, metresEast: 100 });
  const offered = await dispatch.offerToNearestRider(order._id);
  assert.equal(offered.offered, true);
  assert.equal(String(offered.rider._id), String(rider._id));
});

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

test('two riders accepting the same open pickup: exactly one wins', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const a = await seedRider({ market, metresEast: 100 });
  const b = await seedRider({ market, metresEast: 200 });

  const order = await seedPackingOrder({ market, stall });
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        'fulfillment.riderOffer.openPool': true,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
      },
    }
  );

  const [r1, r2] = await Promise.all([
    dispatch.acceptOffer({ orderId: order._id, riderId: a._id }),
    dispatch.acceptOffer({ orderId: order._id, riderId: b._id }),
  ]);

  const winners = [r1, r2].filter((r) => r.accepted);
  assert.equal(winners.length, 1, 'one rider, one order');

  const after = await Order.findById(order._id);
  assert.ok(after.assignedTo);
});

test('a rider who was not offered the pickup cannot take it', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  await seedRider({ market, metresEast: 100 });
  const outsider = await seedRider({ market, metresEast: 4000 });

  const order = await seedPackingOrder({ market, stall });

  const result = await dispatch.acceptOffer({ orderId: order._id, riderId: outsider._id });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'OFFER_GONE');
});

test('accepting while stalls are still packing waits, then starts collection when they finish', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider({ market, metresEast: 100 });

  const order = await seedPackingOrder({ market, stall, lineCount: 2 });
  assert.equal(order.fulfillment.status, 'packing');

  const accepted = await dispatch.acceptOffer({ orderId: order._id, riderId: rider._id });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.order.fulfillment.status, 'packing', 'the rider rides over while bags are filled');

  await sourcing.packLines({
    orderId: order._id,
    stallId: stall._id,
    lineIds: order.items.map((i) => i.lineId),
  });

  const after = await Order.findById(order._id);
  assert.equal(after.fulfillment.status, 'collecting', 'a rider already present starts collecting immediately');
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

test('the pickup list is grouped by stall and sorted for one walk round the market', async () => {
  const market = await seedMarket();
  const [s1, s2, s3] = await Promise.all([
    seedStall(market, 'A-10'),
    seedStall(market, 'A-2'),
    seedStall(market, 'B-1'),
  ]);

  const customer = await newUser('customer');
  const products = await Promise.all([seedProduct('P1'), seedProduct('P2'), seedProduct('P3')]);
  const items = products.map((p) => ({
    product: p._id,
    name: p.name,
    unitPricePaise: 4000,
    quantity: 1,
    lineTotalPaise: 4000,
    lineId: new mongoose.Types.ObjectId(),
    sourcePricePaise: 4000,
    claim: sourcing.emptyClaim(),
  }));

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Test Lane',
    items,
    subtotalPaise: 12000,
    totalAmountPaise: 12000,
    paymentMethod: 'cod',
    status: 'Pending',
    market: market._id,
    marketName: market.name,
    fulfillment: sourcing.initialFulfillment(market._id),
  });

  await sourcing.claimLines({ orderId: order._id, stallId: s1._id, stallNumber: 'A-10', lineIds: [items[0].lineId] });
  await sourcing.claimLines({ orderId: order._id, stallId: s2._id, stallNumber: 'A-2', lineIds: [items[1].lineId] });
  await sourcing.claimLines({ orderId: order._id, stallId: s3._id, stallNumber: 'B-1', lineIds: [items[2].lineId] });

  const fresh = await Order.findById(order._id).lean();
  const list = dispatch.buildPickupList(fresh);

  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((p) => p.stallNumber),
    ['A-2', 'A-10', 'B-1'],
    'A-2 before A-10: numeric ordering, not lexicographic'
  );
});

test('collecting the last stall sends the order out for delivery', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider({ market, metresEast: 100 });

  const order = await seedPackingOrder({ market, stall, lineCount: 2 });
  await dispatch.acceptOffer({ orderId: order._id, riderId: rider._id });
  await sourcing.packLines({
    orderId: order._id,
    stallId: stall._id,
    lineIds: order.items.map((i) => i.lineId),
  });

  assert.equal((await Order.findById(order._id)).fulfillment.status, 'collecting');

  const result = await dispatch.collectStall({
    orderId: order._id,
    riderId: rider._id,
    stallId: stall._id,
    code: pickupCode.codeFor(order._id, stall._id),
  });
  assert.equal(result.dispatched, true);

  const after = await Order.findById(order._id);
  assert.equal(after.fulfillment.status, 'dispatched');
  assert.equal(after.status, 'Out for Delivery', 'the coarse status the delivery app reads must follow');
  assert.equal((await Stall.findById(stall._id)).activeLoad, 0, 'the stall is free again');
});

test('a rider cannot collect from a stall on someone else\'s order', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const mine = await seedRider({ market, metresEast: 100 });
  const other = await seedRider({ market, metresEast: 200 });

  const order = await seedPackingOrder({ market, stall });
  await dispatch.acceptOffer({ orderId: order._id, riderId: mine._id });
  await sourcing.packLines({
    orderId: order._id,
    stallId: stall._id,
    lineIds: order.items.map((i) => i.lineId),
  });

  const result = await dispatch.collectStall({
    orderId: order._id,
    riderId: other._id,
    stallId: stall._id,
    // The RIGHT code: being assigned is checked first, so knowing it buys nothing.
    code: pickupCode.codeFor(order._id, stall._id),
  });
  assert.equal(result.order, null);
  assert.equal(result.reason, 'NOT_COLLECTING');
});

test('unpacked lines cannot be collected', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider({ market, metresEast: 100 });

  const order = await seedPackingOrder({ market, stall, lineCount: 2 });
  await dispatch.acceptOffer({ orderId: order._id, riderId: rider._id });

  // Only one of the two lines is bagged.
  await sourcing.packLines({ orderId: order._id, stallId: stall._id, lineIds: [order.items[0].lineId] });

  // Still `packing`, so there is nothing to collect yet.
  const result = await dispatch.collectStall({
    orderId: order._id,
    riderId: rider._id,
    stallId: stall._id,
    code: pickupCode.codeFor(order._id, stall._id),
  });
  assert.equal(result.order, null);
});

// ---------------------------------------------------------------------------
// The sweeper
// ---------------------------------------------------------------------------

test('the sweeper expires stale offers and finds riders for orders that had none', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');

  // No rider online when the order locks, so no offer is made.
  const order = await seedPackingOrder({ market, stall });
  let fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.riderOffer.rider, null);

  // A rider comes online. The sweeper is what notices.
  const rider = await seedRider({ market, metresEast: 100 });
  await sweeper.sweepRiderOffers();

  fresh = await Order.findById(order._id);
  assert.equal(String(fresh.fulfillment.riderOffer.rider), String(rider._id));

  // Now let that offer lapse and confirm the sweeper cascades it.
  const second = await seedRider({ market, metresEast: 900 });
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer.expiresAt': new Date(Date.now() - 1000) } }
  );

  await sweeper.sweepRiderOffers();
  fresh = await Order.findById(order._id);
  assert.equal(String(fresh.fulfillment.riderOffer.rider), String(second._id));
});

test('the sweeper closes an expired sourcing window', async () => {
  const market = await seedMarket();
  const customer = await newUser('customer');
  const product = await seedProduct();

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Test Lane',
    items: [
      {
        product: product._id,
        name: product.name,
        unitPricePaise: 4000,
        quantity: 1,
        lineTotalPaise: 4000,
        lineId: new mongoose.Types.ObjectId(),
        sourcePricePaise: 4000,
        claim: sourcing.emptyClaim(),
      },
    ],
    subtotalPaise: 4000,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Pending',
    market: market._id,
    marketName: market.name,
    fulfillment: sourcing.initialFulfillment(market._id),
  });

  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() - 1000) } }
  );

  const result = await sweeper.sweepSourcing();
  assert.equal(result.failed, 1, 'no other market exists, so it must fail rather than hang');
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'failed');
});

test('a sweeper tick does not run on top of itself', async () => {
  // Two ticks fired together: the second must bow out rather than double the
  // load at exactly the moment the first is struggling.
  const [a, b] = await Promise.all([sweeper.tick(), sweeper.tick()]);
  const ran = [a, b].filter(Boolean);
  assert.equal(ran.length, 1);
});
