'use strict';

/**
 * The market owner's authority over a market they already run.
 *
 * Approval was a one-way door before any of this: an owner could accept a
 * shopkeeper and then had no way to put them out again, which makes accepting
 * somebody a decision nobody can afford to get wrong. These cover the other
 * direction, and the boundary of what an owner may reach — which is narrower
 * than "everything on the stall document", deliberately.
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
} = require('./helpers');

const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedProduct(name = 'Tomato', pricePaise = 9900) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise, stock: 500 });
}

async function seedOwnedMarket({ name = 'Rythu Bazaar' } = {}) {
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name,
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
    owner: owner.user._id,
  });
  return { owner, market };
}

/** An approved, trading stall, and the shopkeeper behind it. */
async function seedTrader(market, { stallNumber = 'A-1', name = 'Ramesh Vegetables' } = {}) {
  const trader = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber,
    name,
    owner: trader.user._id,
    status: 'approved',
  });
  return { trader, stall };
}

// ---------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------

test('a market owner can suspend a trader and reinstate them', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { stall } = await seedTrader(market);

  const off = await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: false });

  assert.equal(off.status, 200);
  assert.equal(off.body.data.isActive, false);
  assert.equal(off.body.data.stallNumber, 'A-1', 'suspending must not disturb the pitch');

  const on = await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: true });

  assert.equal(on.status, 200);
  assert.equal(on.body.data.isActive, true);
});

/**
 * The point of suspension. `isActive: false` is not a label — every sourcing
 * query filters on it, so a suspended stall must stop being asked, even with
 * auto-accept on and stock declared, which is otherwise the combination that
 * makes a stall answer instantly.
 */
test('a suspended stall is never offered an order', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  const { stall } = await seedTrader(market);
  await Stall.updateOne({ _id: stall._id }, { $set: { autoAccept: true } });
  await StallInventory.create({
    stall: stall._id,
    market: market._id,
    product: tomato._id,
    stock: 50,
  });

  await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: false });

  const customer = await authenticatedUser('customer');
  const order = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  assert.equal(order.status, 201);
  assert.equal(
    order.body.data.fulfillment.status,
    'sourcing',
    'a suspended stall must not be able to auto-accept'
  );
});

/**
 * What the suspended trader is told.
 *
 * The trap this guards against is a pair of contradictory answers. `NO_STALL`
 * says "ask to join a market to get one", and the partial unique index on
 * `owner` then refuses that with "you already run a stall" — so a suspended
 * trader following the first message lands on the second and has nowhere to go.
 */
test('a suspended shopkeeper is told they are suspended, not that they have no stall', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { trader, stall } = await seedTrader(market);

  await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: false });

  const res = await api().get('/api/stalls/me/orders').set(auth(trader.accessToken));

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'STALL_SUSPENDED');
  assert.match(res.body.error.message, /suspended/i);
  assert.doesNotMatch(
    res.body.error.message,
    /ask to join/i,
    'the unique index would refuse a second application, so this must not suggest one'
  );

  // And the advice it does not give would indeed have failed.
  const reapply = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(trader.accessToken))
    .send({});
  assert.equal(reapply.status, 409);
});

/**
 * The shopkeeper's own view has to be able to say "suspended" without guessing.
 * Approved and trading, and approved and switched off, are the same `status`.
 */
test('the shopkeeper own request reports whether the stall is actually trading', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { trader, stall } = await seedTrader(market);

  const trading = await api().get('/api/markets/me/join').set(auth(trader.accessToken));
  assert.equal(trading.body.data.status, 'approved');
  assert.equal(trading.body.data.isActive, true);

  await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: false });

  const suspended = await api().get('/api/markets/me/join').set(auth(trader.accessToken));
  assert.equal(suspended.body.data.status, 'approved', 'suspension is not a rejection');
  assert.equal(suspended.body.data.isActive, false);
});

test('a reinstated shopkeeper can work again immediately', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { trader, stall } = await seedTrader(market);

  await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: false });
  await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: true });

  const res = await api().get('/api/stalls/me').set(auth(trader.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.stallNumber, 'A-1');
});

test('a shopkeeper who never applied still gets the plain no-stall answer', async () => {
  const shop = await authenticatedUser('shopkeeper');

  const res = await api().get('/api/stalls/me').set(auth(shop.accessToken));

  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NO_STALL');
});

test('a suspended stall stops appearing as trading, and comes back on reinstatement', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { stall } = await seedTrader(market);

  await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: false });

  // Still on the roster — the owner has to be able to find them to reinstate
  // them — but plainly marked as not trading.
  const roster = await api()
    .get(`/api/markets/${market._id}/stalls`)
    .set(auth(owner.accessToken));

  assert.equal(roster.status, 200);
  assert.equal(roster.body.data.length, 1);
  assert.equal(roster.body.data[0].isActive, false);
});

// ---------------------------------------------------------------------------
// Moving a trader to a different pitch
// ---------------------------------------------------------------------------

test('a market owner can move a trader to a free pitch', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { stall } = await seedTrader(market);

  const res = await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ stallNumber: 'B-9' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.stallNumber, 'B-9');
  assert.equal(res.body.data.isActive, true, 'moving a pitch must not stop them trading');
});

test('moving a trader onto a number already trading is refused', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { stall } = await seedTrader(market, { stallNumber: 'A-1' });
  await seedTrader(market, { stallNumber: 'A-2', name: 'Sitting Tenant' });

  const res = await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({ stallNumber: 'A-2' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'STALL_NUMBER_TAKEN');

  const unchanged = await Stall.findById(stall._id).lean();
  assert.equal(unchanged.stallNumber, 'A-1', 'a refused move must leave the pitch alone');
});

// ---------------------------------------------------------------------------
// The boundary of what an owner may reach
// ---------------------------------------------------------------------------

/**
 * The shutter and auto-accept belong to the shopkeeper (PATCH /api/stalls/me).
 * A market owner reaching over to answer "am I behind the counter right now"
 * for somebody else would make the field mean two different things depending on
 * who wrote it last. `.strict()` is what enforces that, so it is worth a test:
 * the failure mode of losing it is silent.
 */
test('a market owner cannot flip a trader shutter or auto-accept', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { stall } = await seedTrader(market);

  for (const body of [{ isOpen: false }, { autoAccept: true }, { name: 'Renamed By Landlord' }]) {
    const res = await api()
      .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
      .set(auth(owner.accessToken))
      .send(body);

    assert.equal(res.status, 400, `${JSON.stringify(body)} should not be accepted`);
  }

  const untouched = await Stall.findById(stall._id).lean();
  assert.equal(untouched.isOpen, true);
  assert.equal(untouched.autoAccept, false);
  assert.equal(untouched.name, 'Ramesh Vegetables');
});

test('an empty change is refused rather than silently doing nothing', async () => {
  const { owner, market } = await seedOwnedMarket();
  const { stall } = await seedTrader(market);

  const res = await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(owner.accessToken))
    .send({});

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('a market owner cannot suspend a trader in a market they do not own', async () => {
  const mine = await seedOwnedMarket({ name: 'Mine' });
  const theirs = await seedOwnedMarket({ name: 'Theirs' });
  const { stall } = await seedTrader(theirs.market);

  const res = await api()
    .patch(`/api/markets/${theirs.market._id}/stalls/${stall._id}`)
    .set(auth(mine.owner.accessToken))
    .send({ isActive: false });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_YOUR_MARKET');

  const untouched = await Stall.findById(stall._id).lean();
  assert.equal(untouched.isActive, true);
});

/**
 * Quoting a stall id from another market must not reach into it, even when the
 * caller legitimately owns the market named in the path. The market filter on
 * the lookup is what stops that, exactly as on the approve route.
 */
test('a stall id from another market cannot be reached through a market you own', async () => {
  const mine = await seedOwnedMarket({ name: 'Mine' });
  const theirs = await seedOwnedMarket({ name: 'Theirs' });
  const { stall } = await seedTrader(theirs.market);

  const res = await api()
    .patch(`/api/markets/${mine.market._id}/stalls/${stall._id}`)
    .set(auth(mine.owner.accessToken))
    .send({ isActive: false });

  assert.equal(res.status, 404);

  const untouched = await Stall.findById(stall._id).lean();
  assert.equal(untouched.isActive, true);
});

test('an applicant still waiting is not a trading stall and cannot be suspended', async () => {
  const { owner, market } = await seedOwnedMarket();
  const shop = await authenticatedUser('shopkeeper');

  const applied = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});

  const res = await api()
    .patch(`/api/markets/${market._id}/stalls/${applied.body.data.id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: true });

  assert.equal(res.status, 404, 'accept them first — that is what the request queue is for');
});

test('a shopkeeper cannot suspend anybody, including themselves', async () => {
  const { market } = await seedOwnedMarket();
  const { trader, stall } = await seedTrader(market);

  const res = await api()
    .patch(`/api/markets/${market._id}/stalls/${stall._id}`)
    .set(auth(trader.accessToken))
    .send({ isActive: false });

  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// The settings an owner needs to read back
// ---------------------------------------------------------------------------

test('/markets/mine carries the settings the owner edits', async () => {
  const { owner, market } = await seedOwnedMarket();
  await Market.updateOne(
    { _id: market._id },
    { $set: { serviceRadiusMeters: 9000, contactPhone: '9876543210' } }
  );

  const res = await api().get('/api/markets/mine').set(auth(owner.accessToken));

  assert.equal(res.status, 200);
  const row = res.body.data[0];
  assert.equal(row.serviceRadiusMeters, 9000);
  assert.equal(row.contactPhone, '9876543210');
  // [lng, lat] on the way in; lat and lng named on the way out. Swapping these
  // puts a Hyderabad market in the Indian Ocean.
  assert.equal(row.lat, 17.385);
  assert.equal(row.lng, 78.4867);
});

/**
 * A market switched off must stay readable by the person who switched it off.
 *
 * GET /markets/:id filters on `isActive: true`, so a settings screen built on
 * that route could turn a market off and then never turn it back on — the
 * market would vanish from its own owner's dashboard.
 */
test('an owner can still see, and reopen, a market they took off the app', async () => {
  const { owner, market } = await seedOwnedMarket();

  const off = await api()
    .patch(`/api/markets/${market._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: false });
  assert.equal(off.status, 200);

  const mine = await api().get('/api/markets/mine').set(auth(owner.accessToken));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].isActive, false);

  const on = await api()
    .patch(`/api/markets/${market._id}`)
    .set(auth(owner.accessToken))
    .send({ isActive: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.data.isActive, true);
});

/**
 * The shopkeeper-facing market list must not start leaking the owner's settings
 * just because /mine now returns them — both are built from `publicMarket`.
 */
test('the joinable market list still withholds the owner settings', async () => {
  const { market } = await seedOwnedMarket();
  await Market.updateOne({ _id: market._id }, { $set: { contactPhone: '9876543210' } });

  const shop = await authenticatedUser('shopkeeper');
  const res = await api().get('/api/markets').set(auth(shop.accessToken));

  assert.equal(res.status, 200);
  const row = res.body.data.find((m) => m.id === market._id.toHexString());
  assert.equal(row.contactPhone, undefined);
  assert.equal(row.serviceRadiusMeters, undefined);
  assert.equal(row.lat, undefined);
});

// ---------------------------------------------------------------------------
// The price sheet, which is what the dashboard's Prices tab writes
// ---------------------------------------------------------------------------

test('an owner sets prices, and the customer catalog quotes them', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct('Tomato', 9900);

  const saved = await api()
    .put(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .send({ prices: [{ productId: tomato._id.toHexString(), price: 42.5, isAvailable: true }] });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.updated, 1);

  const sheet = await api()
    .get(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken));
  assert.equal(sheet.body.data[0].pricePaise, 4250, 'rupees convert once, at the boundary');

  const catalog = await api().get(`/api/markets/${market._id}/catalog`);
  assert.equal(catalog.body.data[0].pricePaise, 4250);
});

test('switching a line off pulls it from the customer catalog but keeps the price', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  await api()
    .put(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .send({ prices: [{ productId: tomato._id.toHexString(), price: 42.5 }] });

  await api()
    .put(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .send({ prices: [{ productId: tomato._id.toHexString(), price: 42.5, isAvailable: false }] });

  const catalog = await api().get(`/api/markets/${market._id}/catalog`);
  assert.equal(catalog.body.data.length, 0, 'a line that is off is not for sale');

  // The owner still sees it, so tomorrow it goes back on without retyping.
  const sheet = await api()
    .get(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken));
  assert.equal(sheet.body.data.length, 1);
  assert.equal(sheet.body.data[0].isAvailable, false);
  assert.equal(sheet.body.data[0].pricePaise, 4250);
});
