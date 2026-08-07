'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  createUser,
  api,
  auth,
  authenticatedUser,
} = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const StallEarning = require('../models/StallEarning');
const WalletTransaction = require('../models/WalletTransaction');
const wallet = require('../services/wallet');
const sourcing = require('../services/sourcing');
const sweeper = require('../services/sweeper');
const config = require('../config/env');

/**
 * The ranked stall cascade.
 *
 * An order is offered to the stalls that can cover the MOST of it, least busy
 * first, with a clock. Silence or a refusal moves those lines to the next-best
 * stall. When the ranking is spent the market opens a free-for-all pool, and
 * only when that lapses does the order leave the market at all — either hopping
 * to another market, or stopping to ask the customer whether a smaller basket
 * is still worth having.
 *
 * Time is driven by backdating deadlines and calling the sweeper, never by
 * sleeping: a two-minute window is not something a test can wait out.
 */

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

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

/** A stall, optionally owned by an already-signed-in shopkeeper. */
async function seedStall(market, { stallNumber = 'A-1', autoAccept = false, activeLoad = 0, owner } = {}) {
  const stallOwner = owner || (await newUser('shopkeeper'));
  return Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: stallOwner._id,
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

async function seedOrder({
  customer,
  market,
  lines,
  paymentMethod = 'cod',
  paymentStatus = 'pending',
  deliveryFeePaise = 0,
  deliveryLocation = undefined,
}) {
  const items = lines.map(({ product, quantity = 1, unitPricePaise }) => ({
    product: product._id,
    name: product.name,
    unitPricePaise: unitPricePaise ?? product.pricePaise,
    quantity,
    lineTotalPaise: (unitPricePaise ?? product.pricePaise) * quantity,
    lineId: new mongoose.Types.ObjectId(),
    sourcePricePaise: unitPricePaise ?? product.pricePaise,
    claim: sourcing.emptyClaim(),
    offer: sourcing.emptyOffer(),
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
    deliveryFeePaise,
    totalAmountPaise: subtotalPaise + deliveryFeePaise,
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

/** Force the current round's clock to have already run out, then sweep. */
async function expireRound(order) {
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.stallOffer.expiresAt': new Date(Date.now() - 1000) } }
  );
  await sweeper.sweepStallRounds();
}

const offeredTo = (fresh, stall) =>
  fresh.items.filter((i) => String(i.offer?.stall) === String(stall._id)).length;

const claimedBy = (fresh, stall) =>
  fresh.items.filter((i) => String(i.claim?.stall) === String(stall._id)).length;

// ---------------------------------------------------------------------------
// The ranking
// ---------------------------------------------------------------------------

test('coverage beats load: the stall that can supply the most wins', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const products = await Promise.all(
    ['Tomato', 'Onion', 'Potato', 'Chilli', 'Ginger'].map((name) => seedProduct({ name }))
  );
  const order = await seedOrder({ customer, market, lines: products.map((product) => ({ product })) });

  // A-1 is completely idle but can only supply four of the five.
  const partial = await seedStall(market, { stallNumber: 'A-1', activeLoad: 0 });
  // B-2 is already carrying work, but has the whole order.
  const complete = await seedStall(market, { stallNumber: 'B-2', activeLoad: 3 });

  await Promise.all(products.slice(0, 4).map((p) => stock(partial, p, 50)));
  await Promise.all(products.map((p) => stock(complete, p, 50)));

  await sourcing.offerRound(order._id);

  const fresh = await Order.findById(order._id);
  assert.equal(offeredTo(fresh, complete), 5, 'the stall holding everything takes the whole order');
  assert.equal(offeredTo(fresh, partial), 0, 'a busier stall that covers more still beats an idle one');
});

test('load breaks a tie on coverage', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const busy = await seedStall(market, { stallNumber: 'A-1', activeLoad: 9 });
  const quiet = await seedStall(market, { stallNumber: 'Z-9', activeLoad: 1 });
  await Promise.all([stock(busy, tomato, 50), stock(quiet, tomato, 50)]);

  await sourcing.offerRound(order._id);

  const fresh = await Order.findById(order._id);
  assert.equal(offeredTo(fresh, quiet), 1, 'the quieter stall wins despite sorting later by number');
  assert.equal(offeredTo(fresh, busy), 0);
});

test('a stall is never offered more of a product than it declared', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const onion = await seedProduct({ name: 'Onion' });

  // Two lines of tomato, 3kg each, against a stall holding only 4kg.
  const order = await seedOrder({
    customer,
    market,
    lines: [{ product: tomato, quantity: 3 }, { product: tomato, quantity: 3 }, { product: onion }],
  });

  const short = await seedStall(market, { stallNumber: 'A-1' });
  await Promise.all([stock(short, tomato, 4), stock(short, onion, 10)]);

  await sourcing.offerRound(order._id);

  const fresh = await Order.findById(order._id);
  assert.equal(
    offeredTo(fresh, short),
    2,
    'one tomato line and the onion — the second tomato line would exceed the declared 4kg'
  );
});

test('an order is split across at most maxStallsPerOrder stalls in one round', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  // Six products, six stalls, each holding exactly one.
  const products = await Promise.all(
    Array.from({ length: 6 }, (_, i) => seedProduct({ name: `Veg${i}` }))
  );
  const order = await seedOrder({ customer, market, lines: products.map((product) => ({ product })) });

  const stalls = [];
  for (let i = 0; i < 6; i += 1) {
    const stall = await seedStall(market, { stallNumber: `S-${i}` });
    await stock(stall, products[i], 50);
    stalls.push(stall);
  }

  await sourcing.offerRound(order._id);

  const fresh = await Order.findById(order._id);
  const distinct = new Set(
    fresh.items.filter((i) => i.offer?.stall).map((i) => String(i.offer.stall))
  );
  assert.equal(
    distinct.size,
    config.marketplace.maxStallsPerOrder,
    'the round is capped so a rider never walks the whole market'
  );
});

// ---------------------------------------------------------------------------
// Offers are targeted
// ---------------------------------------------------------------------------

test('a stall outside the plan cannot see or claim the order', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const chosen = await seedStall(market, { stallNumber: 'A-1', activeLoad: 0 });
  const outsider = await authenticatedUser('shopkeeper');
  const other = await seedStall(market, { stallNumber: 'B-2', activeLoad: 8, owner: outsider.user });
  await Promise.all([stock(chosen, tomato, 50), stock(other, tomato, 50)]);

  await sourcing.offerRound(order._id);

  const feed = await api().get('/api/stalls/me/orders').set(auth(outsider.accessToken)).expect(200);
  assert.equal(feed.body.data.offers.length, 0, 'an order offered elsewhere is invisible');

  const fresh = await Order.findById(order._id);
  const claim = await api()
    .post(`/api/stalls/orders/${order._id}/claim`)
    .set(auth(outsider.accessToken))
    .send({ lineIds: [String(fresh.items[0].lineId)] })
    .expect(409);

  assert.equal(claim.body.error.code, 'NOT_OFFERED');
  assert.equal((await Order.findById(order._id)).items[0].claim.stall, null);
});

test('the stall that was asked sees only its own lines, and can claim them', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const [tomato, onion] = await Promise.all([
    seedProduct({ name: 'Tomato' }),
    seedProduct({ name: 'Onion' }),
  ]);
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }, { product: onion }] });

  const keeper = await authenticatedUser('shopkeeper');
  const mine = await seedStall(market, { stallNumber: 'A-1', owner: keeper.user });
  const theirs = await seedStall(market, { stallNumber: 'B-2' });
  // A-1 only has the tomato, so the onion has to go to B-2.
  await Promise.all([stock(mine, tomato, 50), stock(theirs, onion, 50)]);

  await sourcing.offerRound(order._id);

  const feed = await api().get('/api/stalls/me/orders').set(auth(keeper.accessToken)).expect(200);
  assert.equal(feed.body.data.offers.length, 1);

  const offer = feed.body.data.offers[0];
  assert.equal(offer.openLines.length, 1, 'only the line I was asked about');
  assert.equal(offer.openLines[0].name, 'Tomato');
  assert.ok(offer.offerExpiresAt, 'and a clock to answer within');

  await api()
    .post(`/api/stalls/orders/${order._id}/claim`)
    .set(auth(keeper.accessToken))
    .send({ lineIds: [offer.openLines[0].lineId] })
    .expect(200);

  const fresh = await Order.findById(order._id);
  assert.equal(claimedBy(fresh, mine), 1);
  assert.equal(fresh.items[0].offer.stall, null, 'the answered offer is cleared');
});

// ---------------------------------------------------------------------------
// Declining and timing out
// ---------------------------------------------------------------------------

test('declining re-plans onto the next stall immediately, and never asks again', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const first = await authenticatedUser('shopkeeper');
  const chosen = await seedStall(market, { stallNumber: 'A-1', activeLoad: 0, owner: first.user });
  const backup = await seedStall(market, { stallNumber: 'B-2', activeLoad: 5 });
  await Promise.all([stock(chosen, tomato, 50), stock(backup, tomato, 50)]);

  await sourcing.offerRound(order._id);
  assert.equal(offeredTo(await Order.findById(order._id), chosen), 1);

  await api()
    .post(`/api/stalls/orders/${order._id}/decline`)
    .set(auth(first.accessToken))
    .expect(200);

  const fresh = await Order.findById(order._id);
  assert.equal(offeredTo(fresh, backup), 1, 'the next-ranked stall is asked without waiting for the clock');
  assert.equal(offeredTo(fresh, chosen), 0);
  assert.ok(
    fresh.fulfillment.stallOffer.declinedBy.some((id) => String(id) === String(chosen._id)),
    'the refusal is remembered'
  );

  // And a second round never circles back to them.
  await expireRound(fresh);
  assert.equal(offeredTo(await Order.findById(order._id), chosen), 0);
});

test('a stall that never answers is treated exactly like one that declined', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const silent = await seedStall(market, { stallNumber: 'A-1', activeLoad: 0 });
  const backup = await seedStall(market, { stallNumber: 'B-2', activeLoad: 5 });
  await Promise.all([stock(silent, tomato, 50), stock(backup, tomato, 50)]);

  await sourcing.offerRound(order._id);
  await expireRound(order);

  const fresh = await Order.findById(order._id);
  assert.ok(
    fresh.fulfillment.stallOffer.declinedBy.some((id) => String(id) === String(silent._id)),
    'silence is a refusal, or the cascade loops on an unattended phone'
  );
  assert.equal(offeredTo(fresh, backup), 1);
  assert.equal(fresh.fulfillment.stallOffer.round, 2);
});

test('the ranked rounds run out into a market-wide open pool', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  // One stocked stall that never answers, and a bystander with nothing declared
  // — invisible to the ranking, but able to answer once the pool opens.
  const silent = await seedStall(market, { stallNumber: 'A-1' });
  await stock(silent, tomato, 50);
  const bystander = await authenticatedUser('shopkeeper');
  await seedStall(market, { stallNumber: 'B-2', owner: bystander.user });

  await sourcing.offerRound(order._id);

  const before = await api().get('/api/stalls/me/orders').set(auth(bystander.accessToken)).expect(200);
  assert.equal(before.body.data.offers.length, 0, 'not ranked, so not asked');

  // A-1 goes silent, and it was the only ranked candidate — so the pool opens.
  await expireRound(order);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.stallOffer.openPool, true);
  assert.equal(fresh.fulfillment.status, 'sourcing', 'still in this market, not hopped');

  const after = await api().get('/api/stalls/me/orders').set(auth(bystander.accessToken)).expect(200);
  assert.equal(after.body.data.offers.length, 1, 'the pool is visible to every approved stall');
  assert.equal(after.body.data.offers[0].openPool, true);

  // And anyone may take it now, without having been offered it.
  await api()
    .post(`/api/stalls/orders/${order._id}/claim`)
    .set(auth(bystander.accessToken))
    .send({ lineIds: [String(fresh.items[0].lineId)] })
    .expect(200);

  assert.equal((await Order.findById(order._id)).fulfillment.status, 'packing');
});

// ---------------------------------------------------------------------------
// Leaving the market
// ---------------------------------------------------------------------------

test('an open pool that lapses with nothing claimed hops to the next market', async () => {
  const customer = await newUser('customer');
  const near = await seedMarket({ name: 'Near', lng: 78.4867, lat: 17.385 });
  const next = await seedMarket({ name: 'Next', lng: 78.4967, lat: 17.395 });
  const tomato = await seedProduct({ name: 'Tomato' });
  await Promise.all([priceAt(near, tomato, 4000), priceAt(next, tomato, 4000)]);

  const order = await seedOrder({
    customer,
    market: near,
    lines: [{ product: tomato }],
    deliveryLocation: { type: 'Point', coordinates: [78.4867, 17.385] },
  });

  const silent = await seedStall(near, { stallNumber: 'A-1' });
  await stock(silent, tomato, 50);
  // Somewhere for the order to actually land, so the hop is observable as a
  // fresh cascade rather than another immediate fall-through to a pool.
  const waiting = await seedStall(next, { stallNumber: 'N-1' });
  await stock(waiting, tomato, 50);

  await sourcing.offerRound(order._id);
  await expireRound(order); // ranked round lapses -> pool
  assert.equal((await Order.findById(order._id)).fulfillment.stallOffer.openPool, true);

  await expireRound(await Order.findById(order._id)); // pool lapses -> market spent

  const fresh = await Order.findById(order._id);
  assert.equal(String(fresh.market), String(next._id), 'the order moved market');
  assert.equal(fresh.fulfillment.attempt, 2);
  assert.equal(fresh.fulfillment.stallOffer.openPool, false, 'the new market starts clean');
  assert.equal(
    fresh.fulfillment.stallOffer.declinedBy.length,
    0,
    'a refusal in the last market says nothing about this one'
  );
  assert.equal(offeredTo(fresh, waiting), 1, 'and the cascade starts over there');
});

test('an open pool that lapses with SOME lines claimed asks the customer instead', async () => {
  const customer = await newUser('customer');
  const near = await seedMarket({ name: 'Near', lng: 78.4867, lat: 17.385 });
  const next = await seedMarket({ name: 'Next', lng: 78.4967, lat: 17.395 });
  const [tomato, truffle] = await Promise.all([
    seedProduct({ name: 'Tomato' }),
    seedProduct({ name: 'Truffle' }),
  ]);
  for (const m of [near, next]) {
    await priceAt(m, tomato, 4000);
    await priceAt(m, truffle, 4000);
  }

  const order = await seedOrder({
    customer,
    market: near,
    lines: [{ product: tomato }, { product: truffle }],
    deliveryLocation: { type: 'Point', coordinates: [78.4867, 17.385] },
  });

  // Only the tomato is available anywhere in this market.
  const stall = await seedStall(near, { stallNumber: 'A-1', autoAccept: true });
  await stock(stall, tomato, 50);

  await sourcing.offerRound(order._id); // auto-accepts the tomato
  assert.equal(claimedBy(await Order.findById(order._id), stall), 1);

  await expireRound(await Order.findById(order._id)); // -> pool
  await expireRound(await Order.findById(order._id)); // -> market spent

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'partial_review', 'not a hop — the progress is worth keeping');
  assert.equal(String(fresh.market), String(near._id), 'still here, waiting on an answer');
  assert.equal(fresh.status, 'Pending', 'the coarse status must not suggest it is being packed');
  assert.ok(fresh.fulfillment.partialDeadline > new Date());
  assert.equal(claimedBy(fresh, stall), 1, 'the claimed line is held, not released');
});

// ---------------------------------------------------------------------------
// The customer's decision
// ---------------------------------------------------------------------------

/** Drive an order to `partial_review` with one line claimed and one unfillable. */
async function seedPartialReview({ paymentMethod = 'cod', paymentStatus = 'pending', deliveryFeePaise = 0 } = {}) {
  const signedIn = await authenticatedUser('customer');
  const near = await seedMarket({ name: 'Near', lng: 78.4867, lat: 17.385 });
  const next = await seedMarket({ name: 'Next', lng: 78.4967, lat: 17.395 });
  const [tomato, truffle] = await Promise.all([
    seedProduct({ name: 'Tomato', pricePaise: 4000 }),
    seedProduct({ name: 'Truffle', pricePaise: 9000 }),
  ]);
  for (const m of [near, next]) {
    await priceAt(m, tomato, 4000);
    await priceAt(m, truffle, 9000);
  }

  const order = await seedOrder({
    customer: signedIn.user,
    market: near,
    lines: [{ product: tomato }, { product: truffle }],
    paymentMethod,
    paymentStatus,
    deliveryFeePaise,
    deliveryLocation: { type: 'Point', coordinates: [78.4867, 17.385] },
  });

  const stall = await seedStall(near, { stallNumber: 'A-1', autoAccept: true });
  await stock(stall, tomato, 50);

  await sourcing.offerRound(order._id);
  await expireRound(await Order.findById(order._id));
  await expireRound(await Order.findById(order._id));

  assert.equal((await Order.findById(order._id)).fulfillment.status, 'partial_review');
  return { signedIn, order, stall, near, next, tomato, truffle };
}

test('accepting a partial drops the missing lines, refunds them, and locks the rest', async () => {
  const { signedIn, order, stall } = await seedPartialReview({
    paymentMethod: 'wallet',
    paymentStatus: 'paid',
    deliveryFeePaise: 2000,
  });

  const res = await api()
    .post(`/api/orders/${order._id}/partial/accept`)
    .set(auth(signedIn.accessToken))
    .expect(200);

  assert.equal(res.body.data.refundPaise, 9000, 'exactly the value of the truffle');
  assert.equal(res.body.data.droppedCount, 1);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.items.length, 1, 'the unfilled line is gone from items');
  assert.equal(fresh.items[0].name, 'Tomato');
  assert.equal(fresh.fulfillment.droppedItems.length, 1, 'but recorded, not erased');
  assert.equal(fresh.fulfillment.droppedItems[0].name, 'Truffle');
  assert.equal(fresh.fulfillment.droppedItems[0].refundedPaise, 9000);

  assert.equal(fresh.subtotalPaise, 4000);
  assert.equal(fresh.totalAmountPaise, 6000, 'the delivery fee they agreed to is unchanged');
  assert.equal(fresh.fulfillment.status, 'packing');
  assert.equal(fresh.status, 'Preparing');
  assert.ok(fresh.fulfillment.lockedAt);
  assert.equal(claimedBy(fresh, stall), 1);

  assert.equal(await wallet.getBalancePaise(signedIn.user._id), 9000);
});

test('the delivery fee never rises when the basket shrinks below the free threshold', async () => {
  const { signedIn, order } = await seedPartialReview({
    paymentMethod: 'wallet',
    paymentStatus: 'paid',
    deliveryFeePaise: 0, // the original basket earned free delivery
  });

  await api().post(`/api/orders/${order._id}/partial/accept`).set(auth(signedIn.accessToken)).expect(200);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.deliveryFeePaise, 0);
  assert.equal(
    fresh.totalAmountPaise,
    4000,
    'we failed to supply an item; charging them delivery for it would be perverse'
  );
});

test('accepting twice refunds exactly once', async () => {
  const { signedIn, order } = await seedPartialReview({ paymentMethod: 'wallet', paymentStatus: 'paid' });

  await api().post(`/api/orders/${order._id}/partial/accept`).set(auth(signedIn.accessToken)).expect(200);
  await api().post(`/api/orders/${order._id}/partial/accept`).set(auth(signedIn.accessToken)).expect(409);

  const credits = await WalletTransaction.find({ user: signedIn.user._id, reason: 'order_refund' });
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amountPaise, 9000);
  assert.equal(await wallet.getBalancePaise(signedIn.user._id), 9000);
});

test('a COD partial refunds nothing and simply collects less at the door', async () => {
  const { signedIn, order } = await seedPartialReview({ paymentMethod: 'cod', paymentStatus: 'pending' });

  const res = await api()
    .post(`/api/orders/${order._id}/partial/accept`)
    .set(auth(signedIn.accessToken))
    .expect(200);

  assert.equal(res.body.data.refundPaise, 0);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.totalAmountPaise, 4000, 'they pay for what they actually get');
  assert.equal(fresh.fulfillment.droppedItems[0].refundedPaise, 0);
  assert.equal(await WalletTransaction.countDocuments({ user: signedIn.user._id }), 0);
});

test('the dropped produce goes back on the shelf', async () => {
  const { signedIn, order, truffle } = await seedPartialReview();
  const before = (await Product.findById(truffle._id)).stock;

  await api().post(`/api/orders/${order._id}/partial/accept`).set(auth(signedIn.accessToken)).expect(200);

  assert.equal((await Product.findById(truffle._id)).stock, before + 1);
});

test('choosing another market releases the claims and re-sources', async () => {
  const { signedIn, order, stall, next } = await seedPartialReview();
  assert.equal((await Stall.findById(stall._id)).activeLoad, 1);

  await api().post(`/api/orders/${order._id}/partial/retry`).set(auth(signedIn.accessToken)).expect(200);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'sourcing');
  assert.equal(String(fresh.market), String(next._id));
  assert.equal(fresh.items.length, 2, 'nothing was dropped — we are looking for all of it again');
  assert.equal(fresh.items.filter((i) => i.claim.stall).length, 0);
  assert.equal(
    (await Stall.findById(stall._id)).activeLoad,
    0,
    'the stall must not stay busy for an order that left'
  );
  assert.equal(await WalletTransaction.countDocuments({ user: signedIn.user._id }), 0, 'nothing refunded yet');
});

test('a customer may still cancel outright rather than accept a smaller order', async () => {
  const { signedIn, order, stall } = await seedPartialReview({
    paymentMethod: 'wallet',
    paymentStatus: 'paid',
  });

  await api()
    .patch(`/api/orders/${order._id}/status`)
    .set(auth(signedIn.accessToken))
    .send({ status: 'Cancelled' })
    .expect(200);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'cancelled');
  assert.equal(fresh.paymentStatus, 'refunded');
  assert.equal(await wallet.getBalancePaise(signedIn.user._id), 13000, 'the whole order comes back, not part of it');
  assert.equal((await Stall.findById(stall._id)).activeLoad, 0);
});

test('nobody else can answer for the customer', async () => {
  const { order } = await seedPartialReview();
  const owner = await authenticatedUser('market_owner');

  await api()
    .post(`/api/orders/${order._id}/partial/accept`)
    .set(auth(owner.accessToken))
    .expect(404);

  assert.equal((await Order.findById(order._id)).fulfillment.status, 'partial_review');
});

test('silence is taken as yes once the decision window lapses', async () => {
  const { signedIn, order } = await seedPartialReview({ paymentMethod: 'wallet', paymentStatus: 'paid' });

  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.partialDeadline': new Date(Date.now() - 1000) } }
  );
  const swept = await sweeper.sweepPartialDecisions();
  assert.equal(swept.settled, 1);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'packing');
  assert.equal(fresh.items.length, 1);
  assert.equal(await wallet.getBalancePaise(signedIn.user._id), 9000);
});

// ---------------------------------------------------------------------------
// Downstream
// ---------------------------------------------------------------------------

test('a settled partial pays the stall only for what it actually supplied', async () => {
  const { signedIn, order, stall } = await seedPartialReview();

  await api().post(`/api/orders/${order._id}/partial/accept`).set(auth(signedIn.accessToken)).expect(200);

  const rider = await newUser('delivery');
  await Order.updateOne(
    { _id: order._id },
    { $set: { assignedTo: rider._id, 'fulfillment.status': 'dispatched', status: 'Out for Delivery' } }
  );
  await require('../services/dispatch').deliverOrder({ orderId: order._id, riderId: rider._id });

  const earnings = await StallEarning.find({ stall: stall._id });
  assert.equal(earnings.length, 1);
  assert.equal(earnings[0].grossPaise, 4000, 'the tomato only — never the truffle nobody supplied');
});

// ---------------------------------------------------------------------------
// Nothing that worked before may stop working
// ---------------------------------------------------------------------------

test('a fully-stocked auto-accept market still locks instantly, in one round', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const products = await Promise.all(
    ['Tomato', 'Onion', 'Potato'].map((name) => seedProduct({ name }))
  );
  const order = await seedOrder({ customer, market, lines: products.map((product) => ({ product })) });

  const stall = await seedStall(market, { stallNumber: 'A-1', autoAccept: true });
  await Promise.all(products.map((p) => stock(stall, p, 50)));

  const result = await sourcing.offerRound(order._id);
  assert.equal(result.claimed, 3);
  assert.ok(result.promoted, 'no clock, no waiting, no sweeper tick needed');

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.status, 'packing');
  assert.equal(fresh.fulfillment.stallOffer.round, 1);
  assert.equal(claimedBy(fresh, stall), 3);
  assert.equal(
    (await StallInventory.findOne({ stall: stall._id, product: products[0]._id })).stock,
    49,
    'declared stock is drawn down for what was taken'
  );
});

test('an order whose first round never opened is picked up by the sweeper', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const stall = await seedStall(market, { stallNumber: 'A-1' });
  await stock(stall, tomato, 50);

  // Checkout swallows a failure to open the first round rather than failing a
  // paid order, so this is the safety net that must exist.
  assert.equal((await Order.findById(order._id)).fulfillment.stallOffer.expiresAt, null);

  const swept = await sweeper.sweepStallRounds();
  assert.equal(swept.opened, 1);
  assert.equal(offeredTo(await Order.findById(order._id), stall), 1);
});

test('two sweepers expiring the same round produce one set of offers', async () => {
  const customer = await newUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct({ name: 'Tomato' });
  const order = await seedOrder({ customer, market, lines: [{ product: tomato }] });

  const first = await seedStall(market, { stallNumber: 'A-1', activeLoad: 0 });
  const second = await seedStall(market, { stallNumber: 'B-2', activeLoad: 5 });
  await Promise.all([stock(first, tomato, 50), stock(second, tomato, 50)]);

  await sourcing.offerRound(order._id);
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.stallOffer.expiresAt': new Date(Date.now() - 1000) } }
  );

  const [a, b] = await Promise.all([
    sourcing.expireStallRound(order._id),
    sourcing.expireStallRound(order._id),
  ]);

  const acted = [a, b].filter((r) => r.action === 'reoffered');
  assert.equal(acted.length, 1, 'exactly one instance advances the round');

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.fulfillment.stallOffer.round, 2, 'not 3');
  assert.equal(offeredTo(fresh, second), 1);
});

test('a legacy marketless order is still untouched by the cascade', async () => {
  const customer = await newUser('customer');
  const tomato = await seedProduct({ name: 'Tomato' });

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
    deliveryFeePaise: 0,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Pending',
  });

  assert.equal((await sourcing.offerRound(legacy._id)).reason, 'NOT_SOURCING');
  const swept = await sweeper.sweepStallRounds();
  assert.equal(swept.opened, 0, 'a marketless order must never enter the cascade');
  assert.equal((await Order.findById(legacy._id)).status, 'Pending');
});
