'use strict';

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
const StallEarning = require('../models/StallEarning');
const { migrateStallApproval } = require('../db/migrations');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedProduct(name = 'Tomato', pricePaise = 9900) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise, stock: 500 });
}

/** A market and the owner who runs it, already signed in. */
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

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

test('a shopkeeper can ask to join a market, and starts out pending', async () => {
  const { market } = await seedOwnedMarket();
  const shop = await authenticatedUser('shopkeeper');

  const res = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(shop.accessToken))
    .send({ name: 'Ramesh Vegetables', stallNumber: 'A-7' });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'pending');

  const stall = await Stall.findOne({ owner: shop.user._id }).lean();
  assert.equal(stall.status, 'pending');
  assert.equal(stall.isActive, false, 'a pending stall must be inert, not merely unlisted');
});

test('a second application while one is pending is refused', async () => {
  const { market } = await seedOwnedMarket();
  const other = await seedOwnedMarket({ name: 'Other Bazaar' });
  const shop = await authenticatedUser('shopkeeper');

  await api().post(`/api/markets/${market._id}/join`).set(auth(shop.accessToken)).send({});

  const res = await api()
    .post(`/api/markets/${other.market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ALREADY_APPLIED');
});

test('a shopkeeper can withdraw and then apply somewhere else', async () => {
  const first = await seedOwnedMarket();
  const second = await seedOwnedMarket({ name: 'Other Bazaar' });
  const shop = await authenticatedUser('shopkeeper');

  await api().post(`/api/markets/${first.market._id}/join`).set(auth(shop.accessToken)).send({});

  const withdrawn = await api().delete('/api/markets/me/join').set(auth(shop.accessToken));
  assert.equal(withdrawn.status, 204);

  const res = await api()
    .post(`/api/markets/${second.market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});
  assert.equal(res.status, 201);
});

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

test('the market owner sees the request and can accept it', async () => {
  const { owner, market } = await seedOwnedMarket();
  const shop = await authenticatedUser('shopkeeper');

  await api().post(`/api/markets/${market._id}/join`).set(auth(shop.accessToken)).send({});

  const queue = await api()
    .get(`/api/markets/${market._id}/stall-requests`)
    .set(auth(owner.accessToken));
  assert.equal(queue.status, 200);
  assert.equal(queue.body.data.length, 1);
  assert.equal(queue.body.data[0].applicant.name, shop.user.name);

  const approved = await api()
    .post(`/api/markets/${market._id}/stall-requests/${queue.body.data[0].id}/approve`)
    .set(auth(owner.accessToken))
    .send({ stallNumber: 'B-3' });

  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.status, 'approved');

  const stall = await Stall.findOne({ owner: shop.user._id }).lean();
  assert.equal(stall.status, 'approved');
  assert.equal(stall.isActive, true);
  assert.equal(stall.stallNumber, 'B-3', 'the owner sets the real pitch number');
});

test('a rejection frees the shopkeeper to apply to another market', async () => {
  const first = await seedOwnedMarket();
  const second = await seedOwnedMarket({ name: 'Other Bazaar' });
  const shop = await authenticatedUser('shopkeeper');

  const applied = await api()
    .post(`/api/markets/${first.market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});

  const rejected = await api()
    .post(`/api/markets/${first.market._id}/stall-requests/${applied.body.data.id}/reject`)
    .set(auth(first.owner.accessToken))
    .send({ reason: 'No pitches free this season.' });

  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.status, 'rejected');

  /**
   * The point of the partial unique index. Under the previous sparse-unique
   * index on `owner`, this second application would have collided with the
   * rejected row and barred the shopkeeper from the platform for good.
   */
  const retry = await api()
    .post(`/api/markets/${second.market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});
  assert.equal(retry.status, 201, 'a refusal must not be a life sentence');
});

test('a market owner cannot decide requests in a market they do not own', async () => {
  const mine = await seedOwnedMarket();
  const theirs = await seedOwnedMarket({ name: 'Not Mine' });
  const shop = await authenticatedUser('shopkeeper');

  const applied = await api()
    .post(`/api/markets/${theirs.market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});

  const res = await api()
    .post(`/api/markets/${theirs.market._id}/stall-requests/${applied.body.data.id}/approve`)
    .set(auth(mine.owner.accessToken))
    .send({ stallNumber: 'A-1' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_YOUR_MARKET');
});

test('approving onto a number another stall already trades under is refused', async () => {
  const { owner, market } = await seedOwnedMarket();

  const sitting = await authenticatedUser('shopkeeper');
  await Stall.create({
    market: market._id,
    stallNumber: 'A-1',
    name: 'Sitting Tenant',
    owner: sitting.user._id,
    status: 'approved',
  });

  const shop = await authenticatedUser('shopkeeper');
  const applied = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});

  const res = await api()
    .post(`/api/markets/${market._id}/stall-requests/${applied.body.data.id}/approve`)
    .set(auth(owner.accessToken))
    .send({ stallNumber: 'A-1' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'STALL_NUMBER_TAKEN');
});

// ---------------------------------------------------------------------------
// What a pending stall may not do
// ---------------------------------------------------------------------------

test('a pending stall is never offered an order', async () => {
  const { market } = await seedOwnedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  const shop = await authenticatedUser('shopkeeper');
  const applied = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(shop.accessToken))
    .send({});

  /**
   * Declared stock plus auto-accept is exactly the combination that makes a
   * stall answer instantly. Forced on directly, so the only thing standing
   * between this stall and the order is its approval status.
   */
  const stallId = applied.body.data.id;
  await Stall.updateOne({ _id: stallId }, { $set: { autoAccept: true } });
  await StallInventory.create({
    stall: stallId,
    market: market._id,
    product: tomato._id,
    stock: 50,
  });

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
    'an unapproved stall must not be able to auto-accept'
  );
});

test('a pending shopkeeper is told they are waiting, not that they have no stall', async () => {
  const { market } = await seedOwnedMarket();
  const shop = await authenticatedUser('shopkeeper');

  await api().post(`/api/markets/${market._id}/join`).set(auth(shop.accessToken)).send({});

  const res = await api().get('/api/stalls/me/orders').set(auth(shop.accessToken));

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'STALL_PENDING');
});

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

test('a market owner sees only their own market in /mine, with a pending badge', async () => {
  const mine = await seedOwnedMarket({ name: 'Mine' });
  await seedOwnedMarket({ name: 'Theirs' });

  const shop = await authenticatedUser('shopkeeper');
  await api().post(`/api/markets/${mine.market._id}/join`).set(auth(shop.accessToken)).send({});

  const res = await api().get('/api/markets/mine').set(auth(mine.owner.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].name, 'Mine');
  assert.equal(res.body.data[0].pendingRequests, 1);
});

test('a market owner cannot read another market price sheet', async () => {
  const mine = await seedOwnedMarket();
  const theirs = await seedOwnedMarket({ name: 'Not Mine' });

  const res = await api()
    .get(`/api/markets/${theirs.market._id}/prices`)
    .set(auth(mine.owner.accessToken));

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_YOUR_MARKET');
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

test('analytics report sales per stall and count stalls by status', async () => {
  const { owner, market } = await seedOwnedMarket();

  const trader = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber: 'A-1',
    name: 'Ramesh Vegetables',
    owner: trader.user._id,
    status: 'approved',
  });

  // One shopkeeper still waiting, so the pending count has something to report.
  const waiting = await authenticatedUser('shopkeeper');
  await api().post(`/api/markets/${market._id}/join`).set(auth(waiting.accessToken)).send({});

  await StallEarning.create({
    stall: stall._id,
    stallNumber: 'A-1',
    owner: trader.user._id,
    market: market._id,
    order: market._id, // any ObjectId; analytics never dereferences it
    orderNumber: 'VB-TEST-1',
    lines: [{ name: 'Tomato', quantity: 2, unitPricePaise: 4000, lineTotalPaise: 8000 }],
    grossPaise: 8000,
    commissionPaise: 800,
    netPaise: 7200,
    earnedAt: new Date(),
    releaseAt: new Date(Date.now() + 86400000),
  });

  const res = await api()
    .get(`/api/markets/${market._id}/analytics`)
    .set(auth(owner.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.stalls.approved, 1);
  assert.equal(res.body.data.stalls.pending, 1);
  assert.equal(res.body.data.sales.grossPaise, 8000);
  assert.equal(res.body.data.sales.netPaise, 7200);
  assert.equal(res.body.data.sales.byStall.length, 1);
  assert.equal(res.body.data.sales.byStall[0].stallNumber, 'A-1');
  assert.equal(res.body.data.sales.byStall[0].ownerName, trader.user.name);
});

// ---------------------------------------------------------------------------
// Upgrading a database that predates any of this
// ---------------------------------------------------------------------------

/**
 * The failure this guards against is silent and total: every stall already
 * trading in production was written before `status` existed, and the sourcing
 * queries now insist on `status: 'approved'`. Without the backfill none of them
 * would match, every stall would stop being offered work, and nothing would
 * error — the market would simply go quiet.
 */
test('stalls written before the approval workflow keep trading after it lands', async () => {
  const { market } = await seedOwnedMarket();
  const shop = await authenticatedUser('shopkeeper');

  // Inserted through the driver rather than the model, so Mongoose cannot
  // helpfully apply the new schema default and hide the very gap being tested.
  await Stall.collection.insertOne({
    market: market._id,
    stallNumber: 'L-1',
    name: 'Legacy Stall',
    owner: shop.user._id,
    autoAccept: false,
    isOpen: true,
    isActive: true,
    activeLoad: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const before = await Stall.collection.findOne({ stallNumber: 'L-1' });
  assert.equal(before.status, undefined, 'the fixture must genuinely lack the field');

  const { backfilled } = await migrateStallApproval();
  assert.ok(backfilled >= 1, 'the legacy row should have been rewritten');

  const after = await Stall.collection.findOne({ stallNumber: 'L-1' });
  assert.equal(after.status, 'approved', 'a stall that was trading must keep trading');

  // Idempotent: it runs on every boot, including boots after it has already run.
  const second = await migrateStallApproval();
  assert.equal(second.backfilled, 0, 'a second run must find nothing left to do');
});

test('analytics never include another market takings', async () => {
  const mine = await seedOwnedMarket();
  const theirs = await seedOwnedMarket({ name: 'Not Mine' });

  const trader = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: theirs.market._id,
    stallNumber: 'Z-9',
    name: 'Their Trader',
    owner: trader.user._id,
    status: 'approved',
  });

  await StallEarning.create({
    stall: stall._id,
    stallNumber: 'Z-9',
    owner: trader.user._id,
    market: theirs.market._id,
    order: theirs.market._id,
    orderNumber: 'VB-TEST-2',
    lines: [{ name: 'Tomato', quantity: 1, unitPricePaise: 4000, lineTotalPaise: 4000 }],
    grossPaise: 4000,
    commissionPaise: 0,
    netPaise: 4000,
    earnedAt: new Date(),
    releaseAt: new Date(Date.now() + 86400000),
  });

  const res = await api()
    .get(`/api/markets/${mine.market._id}/analytics`)
    .set(auth(mine.owner.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.sales.grossPaise, 0, 'a competitor takings are not mine to see');
  assert.equal(res.body.data.sales.byStall.length, 0);
});
