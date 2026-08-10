'use strict';

/**
 * The handover code, and what it is worth.
 *
 * A rider used to tick a stall off by tapping "collected". Nothing checked that
 * they were anywhere near the market, and the customer's address unlocked on
 * acceptance regardless — so the two weakest points in the market leg were the
 * same point: a tap.
 *
 * Now the shopkeeper reads a four-digit code off their screen and the rider
 * types it in. It is only visible to the stall holding the bags, so entering it
 * is evidence of being at that stall, and it is what unlocks the customer's
 * name, phone and pin.
 *
 * These tests hold three things: the code reaches the right stall and only the
 * right stall, it cannot be guessed at leisure, and a lock has a way out that
 * does not involve a database edit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  createUser,
  authenticatedUser,
} = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const sourcing = require('../services/sourcing');
const pickupCode = require('../services/pickupCode');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedMarket() {
  return Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Ring Road, Mehdipatnam, Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
  });
}

/** A stall with a signed-in shopkeeper behind it, so it can be polled over HTTP. */
async function seedStall(market, stallNumber) {
  const owner = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: owner.user._id,
    status: 'approved',
  });
  return { stall, owner };
}

async function seedRider(market, { metresEast = 200 } = {}) {
  const rider = await authenticatedUser('delivery');
  const [lng, lat] = market.location.coordinates;
  const offsetDeg = metresEast / (111320 * Math.cos((lat * Math.PI) / 180));

  await User.updateOne(
    { _id: rider.user._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: [lng + offsetDeg, lat] },
        'rider.lastLocationAt': new Date(),
      },
    }
  );

  return rider;
}

/**
 * An order split across the given stalls, one line each, every line claimed —
 * so it is sitting in `packing` with a code waiting at each stall.
 */
async function seedClaimedOrder({ market, stalls }) {
  const { user: customer } = await createUser({ role: 'customer' });

  const items = [];
  for (let i = 0; i < stalls.length; i += 1) {
    const product = await Product.create({
      sku: `SKU-${uniq()}`,
      categoryId: 1,
      name: `Tomato ${i}`,
      pricePaise: 4000,
      stock: 500,
    });
    items.push({
      product: product._id,
      name: product.name,
      unitPricePaise: 4000,
      quantity: 3,
      lineTotalPaise: 12000,
      lineId: new mongoose.Types.ObjectId(),
      sourcePricePaise: 4000,
      claim: sourcing.emptyClaim(),
    });
  }

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Banjara Hills, Hyderabad',
    deliveryLocation: {
      type: 'Point',
      coordinates: [market.location.coordinates[0] + 0.02, market.location.coordinates[1]],
    },
    items,
    subtotalPaise: 12000 * stalls.length,
    totalAmountPaise: 12000 * stalls.length,
    paymentMethod: 'cod',
    status: 'Pending',
    market: market._id,
    marketName: market.name,
    fulfillment: sourcing.initialFulfillment(market._id),
  });

  // Each stall takes exactly its own line.
  for (let i = 0; i < stalls.length; i += 1) {
    await sourcing.claimLines({
      orderId: order._id,
      stallId: stalls[i].stall._id,
      stallNumber: stalls[i].stall.stallNumber,
      lineIds: [items[i].lineId],
    });
  }
  await sourcing.settlePending();

  return { order: await Order.findById(order._id), customer };
}

/** Accept, then bag everything, leaving the order in `collecting`. */
async function reachCollecting({ order, rider, stalls }) {
  await api().post(`/api/rider/orders/${order._id}/accept`).set(auth(rider.accessToken));
  for (const { owner } of stalls) {
    await api()
      .post(`/api/stalls/orders/${order._id}/pack`)
      .set(auth(owner.accessToken))
      .send({});
  }
}

// ---------------------------------------------------------------------------
// Who can see the code
// ---------------------------------------------------------------------------

test('a stall sees its handover code the moment it claims a line', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  await seedClaimedOrder({ market, stalls: [a] });

  const res = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));

  assert.equal(res.status, 200);
  const [job] = res.body.data.packing;
  assert.ok(job, 'the claimed order should be in the packing list');
  assert.match(job.pickupCode, /^\d{4}$/, 'a four-digit code to read out');
  assert.equal(job.pickupAttemptsRemaining, pickupCode.MAX_ATTEMPTS);
});

test('the code does not change between polls', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  await seedClaimedOrder({ market, stalls: [a] });

  const first = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));
  const second = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));

  assert.equal(
    first.body.data.packing[0].pickupCode,
    second.body.data.packing[0].pickupCode,
    'a shopkeeper who refreshes must not start reading out a different number'
  );
});

test('two stalls on one order get different codes, and see only their own', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const b = await seedStall(market, 'B-2');
  const { order } = await seedClaimedOrder({ market, stalls: [a, b] });

  const resA = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));
  const resB = await api().get('/api/stalls/me/orders').set(auth(b.owner.accessToken));

  const codeA = resA.body.data.packing[0].pickupCode;
  const codeB = resB.body.data.packing[0].pickupCode;

  assert.match(codeA, /^\d{4}$/);
  assert.match(codeB, /^\d{4}$/);
  assert.notEqual(codeA, codeB, 'one stall must not be able to release another stall’s bags');

  assert.equal(codeA, pickupCode.codeFor(order._id, a.stall._id));
  assert.equal(codeB, pickupCode.codeFor(order._id, b.stall._id));
});

test('a stall offered an order it has not claimed is given no code', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const bystander = await seedStall(market, 'B-2');
  await seedClaimedOrder({ market, stalls: [a] });

  const res = await api().get('/api/stalls/me/orders').set(auth(bystander.owner.accessToken));

  for (const job of [...res.body.data.offers, ...res.body.data.packing]) {
    assert.equal(job.pickupCode, null, 'a code is only for the stall holding the bags');
  }
});

test('the rider is never sent the code in any form', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));
  const expected = pickupCode.codeFor(order._id, a.stall._id);

  assert.ok(
    !JSON.stringify(res.body).includes(expected),
    'shipping the answer to the person being asked would make the check theatre'
  );
});

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

test('the right code collects the bags and sends the order out', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const res = await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({
      stallId: a.stall._id.toHexString(),
      code: pickupCode.codeFor(order._id, a.stall._id),
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.dispatched, true);
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'dispatched');
});

test('a wrong code collects nothing and says how many tries are left', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const wrong = String((Number(pickupCode.codeFor(order._id, a.stall._id)) + 1) % 10000).padStart(4, '0');

  const res = await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: a.stall._id.toHexString(), code: wrong });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PICKUP_CODE_INVALID');
  assert.match(res.body.error.message, /4 attempts remaining/);

  const after = await Order.findById(order._id);
  assert.equal(after.fulfillment.status, 'collecting', 'nothing moved');
  assert.equal(after.items[0].claim.collectedAt, null);
});

test('one stall’s code will not collect another stall’s bags', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const b = await seedStall(market, 'B-2');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a, b] });

  await reachCollecting({ order, rider, stalls: [a, b] });

  const res = await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({
      stallId: b.stall._id.toHexString(),
      // A's code, presented at B.
      code: pickupCode.codeFor(order._id, a.stall._id),
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PICKUP_CODE_INVALID');
});

test('the handover locks after enough wrong codes', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const right = pickupCode.codeFor(order._id, a.stall._id);
  const wrong = String((Number(right) + 1) % 10000).padStart(4, '0');

  for (let i = 0; i < pickupCode.MAX_ATTEMPTS; i += 1) {
    await api()
      .post(`/api/rider/orders/${order._id}/collect`)
      .set(auth(rider.accessToken))
      .send({ stallId: a.stall._id.toHexString(), code: wrong });
  }

  // Even the correct code is refused once the cap is spent — otherwise the cap
  // would only slow a guesser down rather than stop them.
  const res = await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: a.stall._id.toHexString(), code: right });

  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'PICKUP_ATTEMPTS_EXCEEDED');
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'collecting');
});

test('a correct code clears the failures behind it', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const b = await seedStall(market, 'B-2');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a, b] });

  await reachCollecting({ order, rider, stalls: [a, b] });

  const right = pickupCode.codeFor(order._id, a.stall._id);
  const wrong = String((Number(right) + 1) % 10000).padStart(4, '0');

  await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: a.stall._id.toHexString(), code: wrong });

  await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: a.stall._id.toHexString(), code: right });

  const res = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));
  const job = res.body.data.packing[0];

  assert.equal(
    job.pickupAttemptsRemaining,
    pickupCode.MAX_ATTEMPTS,
    'a rider who mishears once at every stall of a long round must not creep into a lock'
  );
});

test('a rider who was never assigned cannot burn another rider’s attempts', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const mine = await seedRider(market, { metresEast: 100 });
  const other = await seedRider(market, { metresEast: 4000 });
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider: mine, stalls: [a] });

  const res = await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(other.accessToken))
    .send({ stallId: a.stall._id.toHexString(), code: '0000' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'NOT_COLLECTING');

  const stallView = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));
  assert.equal(
    stallView.body.data.packing[0].pickupAttemptsRemaining,
    pickupCode.MAX_ATTEMPTS,
    'a stranger must not be able to lock a handover they are no part of'
  );
});

test('a malformed code is rejected without costing an attempt', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  for (const code of ['12', 'abcd', '123456', '']) {
    const res = await api()
      .post(`/api/rider/orders/${order._id}/collect`)
      .set(auth(rider.accessToken))
      .send({ stallId: a.stall._id.toHexString(), code });
    assert.equal(res.status, 400, `"${code}" should not reach the comparison`);
  }

  const stallView = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));
  assert.equal(
    stallView.body.data.packing[0].pickupAttemptsRemaining,
    pickupCode.MAX_ATTEMPTS,
    'a typo is not a guess'
  );
});

// ---------------------------------------------------------------------------
// What the code unlocks
// ---------------------------------------------------------------------------

test('the customer’s address and pin arrive with the first verified pickup', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const b = await seedStall(market, 'B-2');
  const rider = await seedRider(market);
  const { order, customer } = await seedClaimedOrder({ market, stalls: [a, b] });

  await reachCollecting({ order, rider, stalls: [a, b] });

  const before = await api().get('/api/rider/orders').set(auth(rider.accessToken));
  assert.equal(before.body.data.assigned[0].customerUnlocked, false);
  assert.equal(before.body.data.assigned[0].address, null);

  const collected = await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({
      stallId: a.stall._id.toHexString(),
      code: pickupCode.codeFor(order._id, a.stall._id),
    });

  assert.equal(collected.status, 200);
  assert.equal(collected.body.data.dispatched, false, 'one of two stalls done');

  // The first stall, not the last: a rider walking a round needs to know where
  // they are heading before they finish walking it.
  assert.equal(collected.body.data.customerUnlocked, true);
  assert.equal(collected.body.data.customerName, customer.name);
  assert.equal(collected.body.data.phone, customer.phone);
  assert.equal(collected.body.data.address, '12 Banjara Hills, Hyderabad');
  assert.equal(collected.body.data.deliveryLat, 17.385, 'lat and lng must not be swapped');
  assert.ok(collected.body.data.deliveryLng > 78, 'the pin the map navigates to');
});

test('the unlock survives the next poll', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const b = await seedStall(market, 'B-2');
  const rider = await seedRider(market);
  const { order, customer } = await seedClaimedOrder({ market, stalls: [a, b] });

  await reachCollecting({ order, rider, stalls: [a, b] });
  await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({
      stallId: a.stall._id.toHexString(),
      code: pickupCode.codeFor(order._id, a.stall._id),
    });

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));

  assert.equal(res.body.data.assigned[0].customerUnlocked, true);
  assert.equal(res.body.data.assigned[0].phone, customer.phone);
});

test('a locked-out rider never learns the address', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order, customer } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const wrong = String((Number(pickupCode.codeFor(order._id, a.stall._id)) + 1) % 10000).padStart(4, '0');
  for (let i = 0; i < pickupCode.MAX_ATTEMPTS + 2; i += 1) {
    await api()
      .post(`/api/rider/orders/${order._id}/collect`)
      .set(auth(rider.accessToken))
      .send({ stallId: a.stall._id.toHexString(), code: wrong });
  }

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));
  const job = res.body.data.assigned[0];

  assert.equal(job.customerUnlocked, false);
  assert.equal(job.address, null);
  assert.ok(
    !JSON.stringify(job).includes(customer.phone),
    'guessing at the gate must not be a way through it'
  );
});

// ---------------------------------------------------------------------------
// Clearing a lock
// ---------------------------------------------------------------------------

test('the shopkeeper can clear a locked handover, and the code still works', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const right = pickupCode.codeFor(order._id, a.stall._id);
  const wrong = String((Number(right) + 1) % 10000).padStart(4, '0');

  for (let i = 0; i < pickupCode.MAX_ATTEMPTS; i += 1) {
    await api()
      .post(`/api/rider/orders/${order._id}/collect`)
      .set(auth(rider.accessToken))
      .send({ stallId: a.stall._id.toHexString(), code: wrong });
  }

  const reset = await api()
    .post(`/api/stalls/orders/${order._id}/pickup/reset`)
    .set(auth(a.owner.accessToken));

  assert.equal(reset.status, 200);
  assert.equal(reset.body.data.attemptsRemaining, pickupCode.MAX_ATTEMPTS);
  assert.equal(reset.body.data.pickupCode, right, 'read it out again rather than hunting for it');

  const collected = await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: a.stall._id.toHexString(), code: right });

  assert.equal(collected.status, 200);
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'dispatched');
});

test('a stall cannot clear a lock on an order it has no part in', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const bystander = await seedStall(market, 'B-2');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const res = await api()
    .post(`/api/stalls/orders/${order._id}/pickup/reset`)
    .set(auth(bystander.owner.accessToken));

  assert.equal(res.status, 404, 'vouching for a handover you cannot see is not vouching');
});

test('a rider cannot clear their own lock', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a] });

  await reachCollecting({ order, rider, stalls: [a] });

  const res = await api()
    .post(`/api/stalls/orders/${order._id}/pickup/reset`)
    .set(auth(rider.accessToken));

  assert.equal(
    res.status,
    403,
    'self-service resets would hand the guesser unlimited attempts and delete the mechanism'
  );
});

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

test('the code is stable, four digits, and differs per order and per stall', async () => {
  const orderA = new mongoose.Types.ObjectId();
  const orderB = new mongoose.Types.ObjectId();
  const stallA = new mongoose.Types.ObjectId();
  const stallB = new mongoose.Types.ObjectId();

  assert.equal(pickupCode.codeFor(orderA, stallA), pickupCode.codeFor(orderA, stallA));
  assert.match(pickupCode.codeFor(orderA, stallA), /^\d{4}$/);

  assert.notEqual(
    pickupCode.codeFor(orderA, stallA),
    pickupCode.codeFor(orderB, stallA),
    'a stall’s code must not be reusable across its orders'
  );
  assert.notEqual(
    pickupCode.codeFor(orderA, stallA),
    pickupCode.codeFor(orderA, stallB),
    'an order’s code must not be shared between its stalls'
  );
});

test('a spent code is dropped from the stall screen', async () => {
  const market = await seedMarket();
  const a = await seedStall(market, 'A-1');
  const b = await seedStall(market, 'B-2');
  const rider = await seedRider(market);
  const { order } = await seedClaimedOrder({ market, stalls: [a, b] });

  await reachCollecting({ order, rider, stalls: [a, b] });
  await api()
    .post(`/api/rider/orders/${order._id}/collect`)
    .set(auth(rider.accessToken))
    .send({
      stallId: a.stall._id.toHexString(),
      code: pickupCode.codeFor(order._id, a.stall._id),
    });

  const res = await api().get('/api/stalls/me/orders').set(auth(a.owner.accessToken));
  const job = res.body.data.packing.find((o) => o.id === order._id.toHexString());

  if (job) {
    assert.equal(job.pickupCode, null, 'a spent code on screen is a number waiting to be overheard');
  }
});
