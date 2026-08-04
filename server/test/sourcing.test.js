'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, createUser } = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const WalletTransaction = require('../models/WalletTransaction');
const wallet = require('../services/wallet');
const sourcing = require('../services/sourcing');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/** `createUser` hands back `{ user }`; these tests want the document itself. */
async function newUser(role) {
  const { user } = await createUser({ role });
  return user;
}

async function seedProduct({ name = 'Tomato', pricePaise = 4000, stock = 1000 } = {}) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise, stock });
}

async function seedMarket({ name = 'Rythu Bazaar', lng = 78.4867, lat = 17.385 } = {}) {
  return Market.create({
    name,
    slug: `mkt-${uniq()}`,
    address: 'Somewhere in Hyderabad',
    location: { type: 'Point', coordinates: [lng, lat] },
  });
}

async function priceAt(market, product, pricePaise) {
  return MarketPrice.create({ market: market._id, product: product._id, pricePaise });
}

async function seedStall(market, { stallNumber = 'A-1', autoAccept = false, activeLoad = 0 } = {}) {
  const owner = await newUser('shopkeeper');
  return Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: owner._id,
    autoAccept,
    activeLoad,
    status: 'approved',
  });
}

async function stock(stall, product, amount) {
  return StallInventory.create({
    stall: stall._id,
    market: stall.market,
    product: product._id,
    stock: amount,
  });
}

/**
 * Build a market order sitting in `sourcing`, the state the engine operates on.
 * Bypasses the checkout route deliberately — these tests exercise the engine,
 * not the HTTP surface.
 */
async function seedOrder({
  customer,
  market,
  lines,
  paymentMethod = 'cod',
  paymentStatus = 'pending',
  deliveryLocation = undefined,
}) {
  const items = lines.map(({ product, quantity = 1, unitPricePaise, sourcePricePaise }) => ({
    product: product._id,
    name: product.name,
    unitPricePaise: unitPricePaise ?? product.pricePaise,
    quantity,
    lineTotalPaise: (unitPricePaise ?? product.pricePaise) * quantity,
    lineId: new (require('mongoose').Types.ObjectId)(),
    sourcePricePaise: sourcePricePaise ?? product.pricePaise,
    claim: sourcing.emptyClaim(),
  }));

  const subtotalPaise = items.reduce((sum, i) => sum + i.lineTotalPaise, 0);

  return Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Test Lane',
    deliveryLocation,
    items,
    subtotalPaise,
    deliveryFeePaise: 0,
    totalAmountPaise: subtotalPaise,
    paymentMethod,
    paymentStatus,
    status: 'Pending',
    market: market._id,
    marketName: market.name,
    fulfillment: {
      ...sourcing.initialFulfillment(market._id),
      sourceSubtotalPaise: subtotalPaise,
    },
  });
}

// ---------------------------------------------------------------------------
// The claim race — the whole reason this engine is written the way it is
// ---------------------------------------------------------------------------

test('two stalls racing for the same line: exactly one wins', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  const order = await seedOrder({ customer, market, lines: [{ product: tomato, quantity: 2 }] });

  const a = await seedStall(market, { stallNumber: 'A-1' });
  const b = await seedStall(market, { stallNumber: 'B-2' });
  const lineId = order.items[0].lineId;

  const [resA, resB] = await Promise.all([
    sourcing.claimLines({ orderId: order._id, stallId: a._id, stallNumber: a.stallNumber, lineIds: [lineId] }),
    sourcing.claimLines({ orderId: order._id, stallId: b._id, stallNumber: b.stallNumber, lineIds: [lineId] }),
  ]);

  const winners = [resA, resB].filter((r) => r.won.length === 1);
  const losers = [resA, resB].filter((r) => r.won.length === 0);

  assert.equal(winners.length, 1, 'exactly one stall should win the line');
  assert.equal(losers.length, 1, 'the other stall should win nothing');
  assert.equal(losers[0].lost.length, 1);

  // And the database agrees — the line has one owner, not two.
  const fresh = await Order.findById(order._id).lean();
  assert.ok(fresh.items[0].claim.stall, 'line should be claimed');
  const owner = String(fresh.items[0].claim.stall);
  assert.ok(owner === String(a._id) || owner === String(b._id));

  // The winner's busy count went up by one; the loser's did not move.
  const [freshA, freshB] = await Promise.all([Stall.findById(a._id), Stall.findById(b._id)]);
  assert.equal(freshA.activeLoad + freshB.activeLoad, 1, 'exactly one claim should be counted');
});

test('a stall asking for four lines gets only the ones still free', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const [p1, p2, p3] = await Promise.all([
    seedProduct({ name: 'Tomato' }),
    seedProduct({ name: 'Onion' }),
    seedProduct({ name: 'Okra' }),
  ]);
  const order = await seedOrder({
    customer,
    market,
    lines: [{ product: p1 }, { product: p2 }, { product: p3 }],
  });

  const a = await seedStall(market, { stallNumber: 'A-1' });
  const b = await seedStall(market, { stallNumber: 'B-2' });
  const ids = order.items.map((i) => i.lineId);

  // A takes the first line.
  await sourcing.claimLines({ orderId: order._id, stallId: a._id, stallNumber: 'A-1', lineIds: [ids[0]] });

  // B asks for all three and should be awarded only the two that remain.
  const resB = await sourcing.claimLines({
    orderId: order._id,
    stallId: b._id,
    stallNumber: 'B-2',
    lineIds: ids,
  });

  assert.equal(resB.won.length, 2);
  assert.equal(resB.lost.length, 1);
  assert.equal(String(resB.lost[0]), String(ids[0]));
});

test('claiming the last line locks the order for packing', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const [p1, p2] = await Promise.all([seedProduct({ name: 'Tomato' }), seedProduct({ name: 'Onion' })]);
  const order = await seedOrder({ customer, market, lines: [{ product: p1 }, { product: p2 }] });

  const a = await seedStall(market, { stallNumber: 'A-1' });
  const ids = order.items.map((i) => i.lineId);

  const first = await sourcing.claimLines({ orderId: order._id, stallId: a._id, stallNumber: 'A-1', lineIds: [ids[0]] });
  assert.equal(first.promoted, null, 'one line short — must stay in sourcing');
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'sourcing');

  const second = await sourcing.claimLines({ orderId: order._id, stallId: a._id, stallNumber: 'A-1', lineIds: [ids[1]] });
  assert.ok(second.promoted, 'the final claim should promote the order');

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'packing');
  assert.ok(fresh.fulfillment.lockedAt, 'the cancellation cutoff must be stamped');
  assert.equal(fresh.status, 'Preparing', 'coarse status must mirror the fulfillment status');
});

test('a claim on an order that is no longer sourcing is refused', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const p1 = await seedProduct();
  const order = await seedOrder({ customer, market, lines: [{ product: p1 }] });
  const a = await seedStall(market, { stallNumber: 'A-1' });
  const b = await seedStall(market, { stallNumber: 'B-2' });

  await sourcing.claimLines({
    orderId: order._id,
    stallId: a._id,
    stallNumber: 'A-1',
    lineIds: [order.items[0].lineId],
  });

  const late = await sourcing.claimLines({
    orderId: order._id,
    stallId: b._id,
    stallNumber: 'B-2',
    lineIds: [order.items[0].lineId],
  });

  assert.equal(late.won.length, 0);
  assert.equal(late.reason, 'NOT_SOURCING');
});

// ---------------------------------------------------------------------------
// The cancellation cutoff
// ---------------------------------------------------------------------------

test('a customer cancel racing the final claim resolves to one winner', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const p1 = await seedProduct();
  const order = await seedOrder({ customer, market, lines: [{ product: p1 }] });
  const a = await seedStall(market, { stallNumber: 'A-1' });

  // The cancel is the same conditional shape the route uses.
  const cancel = () =>
    Order.findOneAndUpdate(
      { _id: order._id, customer: customer._id, 'fulfillment.status': 'sourcing' },
      { $set: { 'fulfillment.status': 'cancelled', status: 'Cancelled' } },
      { new: true }
    );

  const [claimResult, cancelResult] = await Promise.all([
    sourcing.claimLines({
      orderId: order._id,
      stallId: a._id,
      stallNumber: 'A-1',
      lineIds: [order.items[0].lineId],
    }),
    cancel(),
  ]);

  const fresh = await Order.findById(order._id);
  assert.ok(
    ['packing', 'cancelled'].includes(fresh.fulfillment.status),
    `expected packing or cancelled, got ${fresh.fulfillment.status}`
  );

  // Exactly one of the two outcomes actually happened.
  const lockedIn = Boolean(claimResult.promoted);
  const cancelled = Boolean(cancelResult);
  assert.ok(lockedIn !== cancelled, 'the order must be either locked or cancelled, never both or neither');

  if (lockedIn) assert.equal(fresh.fulfillment.status, 'packing');
  if (cancelled) assert.equal(fresh.fulfillment.status, 'cancelled');
});

test('a cancel arriving after the lock is refused', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const p1 = await seedProduct();
  const order = await seedOrder({ customer, market, lines: [{ product: p1 }] });
  const a = await seedStall(market, { stallNumber: 'A-1' });

  await sourcing.claimLines({
    orderId: order._id,
    stallId: a._id,
    stallNumber: 'A-1',
    lineIds: [order.items[0].lineId],
  });

  const late = await Order.findOneAndUpdate(
    { _id: order._id, customer: customer._id, 'fulfillment.status': 'sourcing' },
    { $set: { 'fulfillment.status': 'cancelled', status: 'Cancelled' } },
    { new: true }
  );

  assert.equal(late, null, 'the cancel must not match a locked order');
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'packing');
});

// ---------------------------------------------------------------------------
// Auto-accept
// ---------------------------------------------------------------------------

test('auto-accept fires only for stalls that declared stock', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato, quantity: 3 }] });

  // Auto-accept on, but nothing declared — must not fire.
  await seedStall(market, { stallNumber: 'A-1', autoAccept: true });

  const nothing = await sourcing.runAutoAccept(order._id);
  assert.equal(nothing.claimed, 0);
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'sourcing');

  // Now a stall that has actually declared the goods.
  const stocked = await seedStall(market, { stallNumber: 'B-2', autoAccept: true });
  await stock(stocked, tomato, 10);

  const result = await sourcing.runAutoAccept(order._id);
  assert.equal(result.claimed, 1);

  const fresh = await Order.findById(order._id);
  assert.equal(String(fresh.items[0].claim.stall), String(stocked._id));
  assert.equal(fresh.items[0].claim.auto, true);
  assert.equal(fresh.fulfillment.status, 'packing', 'the only line is claimed, so it locks');

  // Declared stock was drawn down by what was taken.
  const inv = await StallInventory.findOne({ stall: stocked._id, product: tomato._id });
  assert.equal(inv.stock, 7);
});

test('auto-accept ignores a stall that has not opted in', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const manual = await seedStall(market, { stallNumber: 'A-1', autoAccept: false });
  await stock(manual, tomato, 50);

  const result = await sourcing.runAutoAccept(order._id);
  assert.equal(result.claimed, 0);
});

test('auto-accept prefers the least busy stall', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const busy = await seedStall(market, { stallNumber: 'A-1', autoAccept: true, activeLoad: 9 });
  const quiet = await seedStall(market, { stallNumber: 'Z-9', autoAccept: true, activeLoad: 1 });
  await Promise.all([stock(busy, tomato, 50), stock(quiet, tomato, 50)]);

  await sourcing.runAutoAccept(order._id);

  const fresh = await Order.findById(order._id);
  assert.equal(
    String(fresh.items[0].claim.stall),
    String(quiet._id),
    'the quieter stall should win despite sorting later by number'
  );
});

test('auto-accept spreads a multi-line order rather than piling it on one stall', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const [p1, p2] = await Promise.all([seedProduct({ name: 'Tomato' }), seedProduct({ name: 'Onion' })]);
  const order = await seedOrder({ customer, market, lines: [{ product: p1 }, { product: p2 }] });

  const a = await seedStall(market, { stallNumber: 'A-1', autoAccept: true, activeLoad: 0 });
  const b = await seedStall(market, { stallNumber: 'B-2', autoAccept: true, activeLoad: 0 });
  await Promise.all([stock(a, p1, 10), stock(a, p2, 10), stock(b, p1, 10), stock(b, p2, 10)]);

  await sourcing.runAutoAccept(order._id);

  const fresh = await Order.findById(order._id);
  const stalls = new Set(fresh.items.map((i) => String(i.claim.stall)));
  assert.equal(stalls.size, 2, 'two equally quiet stalls should take one line each');
});

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

test('an order is fully packed only when every stall has bagged its lines', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const [p1, p2] = await Promise.all([seedProduct({ name: 'Tomato' }), seedProduct({ name: 'Onion' })]);
  const order = await seedOrder({ customer, market, lines: [{ product: p1 }, { product: p2 }] });

  const a = await seedStall(market, { stallNumber: 'A-1' });
  const b = await seedStall(market, { stallNumber: 'B-2' });
  const ids = order.items.map((i) => i.lineId);

  await sourcing.claimLines({ orderId: order._id, stallId: a._id, stallNumber: 'A-1', lineIds: [ids[0]] });
  await sourcing.claimLines({ orderId: order._id, stallId: b._id, stallNumber: 'B-2', lineIds: [ids[1]] });
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'packing');

  await sourcing.packLines({ orderId: order._id, stallId: a._id, lineIds: [ids[0]] });
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'packing', 'one stall still bagging');

  await sourcing.packLines({ orderId: order._id, stallId: b._id, lineIds: [ids[1]] });
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'awaiting_rider');
  assert.equal(fresh.status, 'Preparing');
});

test('a stall cannot mark another stall\'s lines packed', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const [p1, p2] = await Promise.all([seedProduct({ name: 'Tomato' }), seedProduct({ name: 'Onion' })]);
  const order = await seedOrder({ customer, market, lines: [{ product: p1 }, { product: p2 }] });

  const a = await seedStall(market, { stallNumber: 'A-1' });
  const b = await seedStall(market, { stallNumber: 'B-2' });
  const ids = order.items.map((i) => i.lineId);

  await sourcing.claimLines({ orderId: order._id, stallId: a._id, stallNumber: 'A-1', lineIds: [ids[0]] });
  await sourcing.claimLines({ orderId: order._id, stallId: b._id, stallNumber: 'B-2', lineIds: [ids[1]] });

  // A tries to pack everything, including B's line.
  await sourcing.packLines({ orderId: order._id, stallId: a._id, lineIds: ids });

  const fresh = await Order.findById(order._id);
  assert.ok(fresh.items[0].claim.packedAt, "A's own line is packed");
  assert.equal(fresh.items[1].claim.packedAt, null, "B's line must be untouched");
  assert.equal(fresh.fulfillment.status, 'packing');
});

// ---------------------------------------------------------------------------
// Pricing a market
// ---------------------------------------------------------------------------

test('a market that does not carry every line cannot be priced', async () => {
  const market = await seedMarket();
  const [p1, p2] = await Promise.all([seedProduct(), seedProduct()]);
  await priceAt(market, p1, 3000);

  const priced = await sourcing.priceLinesAtMarket(market._id, [
    { product: p1._id, quantity: 1, lineId: 'x' },
    { product: p2._id, quantity: 1, lineId: 'y' },
  ]);

  assert.equal(priced, null, 'a missing line disqualifies the market outright');
});

test('a line the market has marked unavailable disqualifies it', async () => {
  const market = await seedMarket();
  const p1 = await seedProduct();
  await MarketPrice.create({ market: market._id, product: p1._id, pricePaise: 3000, isAvailable: false });

  const priced = await sourcing.priceLinesAtMarket(market._id, [{ product: p1._id, quantity: 1, lineId: 'x' }]);
  assert.equal(priced, null);
});

test('pricing sums the market sheet, not the catalog', async () => {
  const market = await seedMarket();
  const p1 = await seedProduct({ pricePaise: 9999 });
  await priceAt(market, p1, 2500);

  const priced = await sourcing.priceLinesAtMarket(market._id, [{ product: p1._id, quantity: 4, lineId: 'x' }]);
  assert.equal(priced.sourceSubtotalPaise, 10000);
  assert.equal(priced.priced[0].sourcePricePaise, 2500);
});

// ---------------------------------------------------------------------------
// Hopping and failing
// ---------------------------------------------------------------------------

test('an expired window hops to the next nearest market and re-prices the lines', async () => {
  const customer = await newUser('customer');
  const near = await seedMarket({ name: 'Near Market', lng: 78.4867, lat: 17.385 });
  const next = await seedMarket({ name: 'Next Market', lng: 78.4967, lat: 17.395 });

  const tomato = await seedProduct({ pricePaise: 4000 });
  await priceAt(near, tomato, 4000);
  await priceAt(next, tomato, 3500); // cheaper, so within the ceiling

  const order = await seedOrder({
    customer,
    market: near,
    lines: [{ product: tomato, quantity: 2 }],
    deliveryLocation: { type: 'Point', coordinates: [78.4867, 17.385] },
  });

  // Force the window shut.
  await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() - 1000) } });

  const result = await sourcing.expireSourcing(order._id);
  assert.equal(result.action, 'hopped');

  const fresh = await Order.findById(order._id);
  assert.equal(String(fresh.market), String(next._id));
  assert.equal(fresh.marketName, 'Next Market');
  assert.equal(fresh.fulfillment.attempt, 2);
  assert.equal(fresh.fulfillment.triedMarkets.length, 2);
  assert.equal(fresh.fulfillment.status, 'sourcing');

  // The customer's price is untouched; only the market-facing price moved.
  assert.equal(fresh.items[0].unitPricePaise, 4000, 'what the customer pays must never move');
  assert.equal(fresh.items[0].sourcePricePaise, 3500, 'the new market sees its own price');
  assert.equal(fresh.fulfillment.sourceSubtotalPaise, 7000);
});

test('a hop never travels to a market that would cost more than the customer paid', async () => {
  const customer = await newUser('customer');
  const near = await seedMarket({ name: 'Near', lng: 78.4867, lat: 17.385 });
  const dear = await seedMarket({ name: 'Expensive', lng: 78.4967, lat: 17.395 });

  const tomato = await seedProduct({ pricePaise: 4000 });
  await priceAt(near, tomato, 4000);
  await priceAt(dear, tomato, 9000); // far above the locked total

  const order = await seedOrder({
    customer,
    market: near,
    lines: [{ product: tomato }],
    deliveryLocation: { type: 'Point', coordinates: [78.4867, 17.385] },
  });
  await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() - 1000) } });

  const result = await sourcing.expireSourcing(order._id);
  assert.equal(result.action, 'failed', 'better to refund than to fill at a loss');
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'failed');
});

test('a hop releases the busy count of stalls that had claimed lines', async () => {
  const customer = await newUser('customer');
  const near = await seedMarket({ name: 'Near', lng: 78.4867, lat: 17.385 });
  const next = await seedMarket({ name: 'Next', lng: 78.4967, lat: 17.395 });

  const [p1, p2] = await Promise.all([seedProduct({ name: 'Tomato' }), seedProduct({ name: 'Onion' })]);
  for (const m of [near, next]) {
    await priceAt(m, p1, 1000);
    await priceAt(m, p2, 1000);
  }

  const order = await seedOrder({
    customer,
    market: near,
    lines: [{ product: p1, unitPricePaise: 1000 }, { product: p2, unitPricePaise: 1000 }],
    deliveryLocation: { type: 'Point', coordinates: [78.4867, 17.385] },
  });

  const a = await seedStall(near, { stallNumber: 'A-1' });
  await sourcing.claimLines({
    orderId: order._id,
    stallId: a._id,
    stallNumber: 'A-1',
    lineIds: [order.items[0].lineId],
  });
  assert.equal((await Stall.findById(a._id)).activeLoad, 1);

  await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() - 1000) } });
  await sourcing.expireSourcing(order._id);

  assert.equal((await Stall.findById(a._id)).activeLoad, 0, 'a stall must not stay busy for work it never did');

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.items[0].claim.stall, null, 'claims are handed back on a hop');
});

test('running out of markets refunds a wallet order exactly once and restores stock', async () => {
  const customer = await newUser('customer');
  await wallet.credit({
    userId: customer._id,
    amountPaise: 50000,
    reason: 'promotional_credit',
    idempotencyKey: 'seed:refund-test',
  });

  const market = await seedMarket();
  const tomato = await seedProduct({ pricePaise: 4000, stock: 98 });
  await priceAt(market, tomato, 4000);

  const order = await seedOrder({
    customer,
    market,
    lines: [{ product: tomato, quantity: 2 }],
    paymentMethod: 'wallet',
    paymentStatus: 'paid',
  });
  // Only market in existence, so there is nowhere to hop.
  await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() - 1000) } });

  const first = await sourcing.expireSourcing(order._id);
  assert.equal(first.action, 'failed');

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'failed');
  assert.equal(fresh.status, 'Cancelled', 'the coarse status the apps read must follow');
  assert.equal(fresh.paymentStatus, 'refunded');

  assert.equal((await Product.findById(tomato._id)).stock, 100, 'reserved stock goes back to the catalog');

  const refunds = await WalletTransaction.find({ user: customer._id, reason: 'order_refund' });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amountPaise, 8000);

  // A second sweep must not pay the customer twice.
  await sourcing.failOrder(fresh, 'replay');
  const after = await WalletTransaction.find({ user: customer._id, reason: 'order_refund' });
  assert.equal(after.length, 1, 'the shared idempotency key makes the replay a no-op');
});

test('a failed COD order is marked failed, not refunded, and writes no ledger entry', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await priceAt(market, tomato, 4000);

  const order = await seedOrder({
    customer,
    market,
    lines: [{ product: tomato }],
    paymentMethod: 'cod',
    paymentStatus: 'pending',
  });
  await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() - 1000) } });

  await sourcing.expireSourcing(order._id);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'failed');
  assert.equal(fresh.paymentStatus, 'failed');
  assert.equal(await WalletTransaction.countDocuments({ user: customer._id }), 0);
});

test('a window that expires just as the last line lands promotes instead of hopping', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await priceAt(market, tomato, 4000);
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const a = await seedStall(market, { stallNumber: 'A-1' });
  await sourcing.claimLines({
    orderId: order._id,
    stallId: a._id,
    stallNumber: 'A-1',
    lineIds: [order.items[0].lineId],
  });

  // The order is already packing; a late sweep must leave it alone.
  const result = await sourcing.expireSourcing(order._id);
  assert.equal(result.action, 'skipped');
  assert.equal((await Order.findById(order._id)).fulfillment.status, 'packing');
});

test('two sweepers hitting the same expired order: only one acts', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await priceAt(market, tomato, 4000);

  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });
  await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() - 1000) } });

  const [r1, r2] = await Promise.all([
    sourcing.expireSourcing(order._id),
    sourcing.expireSourcing(order._id),
  ]);

  const acted = [r1, r2].filter((r) => r.action !== 'skipped');
  assert.equal(acted.length, 1, 'the deadline lease must let exactly one sweeper through');
});

// ---------------------------------------------------------------------------
// The legacy path must be untouched
// ---------------------------------------------------------------------------

test('an order with no market is invisible to the engine', async () => {
  const customer = await newUser('customer');
  const tomato = await seedProduct();

  const legacy = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Test Lane',
    items: [
      {
        product: tomato._id,
        name: tomato.name,
        unitPricePaise: 4000,
        quantity: 1,
        lineTotalPaise: 4000,
      },
    ],
    subtotalPaise: 4000,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Pending',
  });

  assert.equal(legacy.market, null);
  assert.equal(legacy.fulfillment.status, null, 'no fulfillment state at all');
  assert.equal(legacy.status, 'Pending', 'the old flow still starts Pending, not Preparing');

  const result = await sourcing.expireSourcing(legacy._id);
  assert.equal(result.action, 'skipped');
  assert.equal((await sourcing.runAutoAccept(legacy._id)).claimed, 0);
});
