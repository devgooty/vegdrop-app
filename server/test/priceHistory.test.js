'use strict';

/**
 * The record behind the customer-facing Price Tracker.
 *
 * That chart used to be a random walk generated in the browser: a different
 * thirty-day history on every render, showing rises and falls that had never
 * happened, for a shopper deciding whether to buy now or wait. Nothing recorded
 * a past price anywhere. These cover the record that replaced it, and the two
 * properties that make it worth trusting — a point exists only where the price
 * genuinely moved, and a window that opens mid-series still knows the price in
 * force when it opened.
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
const MarketPriceHistory = require('../models/MarketPriceHistory');
const Product = require('../models/Product');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedOwnedMarket() {
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
    owner: owner.user._id,
  });
  return { owner, market };
}

async function seedProduct(name = 'Tomato') {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise: 4000, stock: 500 });
}

async function setPrice(owner, market, product, rupees, isAvailable = true) {
  return api()
    .put(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .send({ prices: [{ productId: product._id.toHexString(), price: rupees, isAvailable }] });
}

/** insertMany is fire-and-forget on the route; give it a tick to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test('the first price a market sets is recorded', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  const res = await setPrice(owner, market, tomato, 42);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.changed, 1);

  await settle();
  const rows = await MarketPriceHistory.find({ market: market._id }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pricePaise, 4200, 'rupees convert once, at the boundary');
});

/**
 * The property the whole record rests on. The price sheet is saved as a batch,
 * so an owner editing one line re-sends the others untouched. Recording those
 * would draw a flat line densely dotted with re-affirmations of the same number
 * — volatility that never happened, which is what this replaced.
 */
test('saving the same price again records nothing', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  await setPrice(owner, market, tomato, 42);
  await settle();

  const second = await setPrice(owner, market, tomato, 42);
  assert.equal(second.body.data.changed, 0, 'nothing moved, so nothing to record');

  await settle();
  const rows = await MarketPriceHistory.find({ market: market._id }).lean();
  assert.equal(rows.length, 1);
});

test('a real change is recorded, and the old price is kept', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  await setPrice(owner, market, tomato, 42);
  await settle();
  await setPrice(owner, market, tomato, 55.5);
  await settle();

  const rows = await MarketPriceHistory.find({ market: market._id }).sort({ at: 1 }).lean();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pricePaise, 4200, 'the price it was must survive the change');
  assert.equal(rows[1].pricePaise, 5550);
});

/**
 * Withdrawing a line is a change worth plotting: without `isAvailable` a chart
 * cannot tell "the price held steady" from "the market stopped selling it".
 */
test('taking a line off sale is recorded even at the same price', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  await setPrice(owner, market, tomato, 42);
  await settle();
  const off = await setPrice(owner, market, tomato, 42, false);
  assert.equal(off.body.data.changed, 1);

  await settle();
  const rows = await MarketPriceHistory.find({ market: market._id }).sort({ at: 1 }).lean();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].isAvailable, false);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the series comes back oldest first, and is public', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  await setPrice(owner, market, tomato, 42);
  await settle();
  await setPrice(owner, market, tomato, 48);
  await settle();

  // No Authorization header: a shopper deciding when to buy may have no account.
  const res = await api().get(`/api/markets/${market._id}/price-history`);

  assert.equal(res.status, 200);
  const series = res.body.data.series[tomato._id.toHexString()];
  assert.equal(series.length, 2);
  assert.equal(series[0].pricePaise, 4200);
  assert.equal(series[1].pricePaise, 4800);
});

/**
 * A window that opens after the last change must still know the current price.
 * Without the carried opening point, a product repriced once a month ago would
 * appear to have had no price at all for the whole window.
 */
test('a window opening after the last change still carries the price in force', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  await setPrice(owner, market, tomato, 42);
  await settle();

  // Backdate the only change to well before the window.
  await MarketPriceHistory.updateMany(
    { market: market._id },
    { $set: { at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } }
  );

  const res = await api().get(`/api/markets/${market._id}/price-history?days=30`);
  const series = res.body.data.series[tomato._id.toHexString()];

  assert.equal(series.length, 1);
  assert.equal(series[0].pricePaise, 4200);
  assert.equal(series[0].carried, true, 'flagged so the client knows it is not a change');
});

test('a product that has never been repriced returns no series rather than an invented one', async () => {
  const { market } = await seedOwnedMarket();
  const tomato = await seedProduct();

  const res = await api().get(`/api/markets/${market._id}/price-history`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.series, {});
  assert.equal(res.body.data.series[tomato._id.toHexString()], undefined);
});

test('history is scoped to the market that set it', async () => {
  const mine = await seedOwnedMarket();
  const theirs = await seedOwnedMarket();
  const tomato = await seedProduct();

  await setPrice(mine.owner, mine.market, tomato, 42);
  await setPrice(theirs.owner, theirs.market, tomato, 99);
  await settle();

  const res = await api().get(`/api/markets/${mine.market._id}/price-history`);
  const series = res.body.data.series[tomato._id.toHexString()];

  assert.equal(series.length, 1);
  assert.equal(series[0].pricePaise, 4200, "another market's price must not appear here");
});

test('the series can be narrowed to specific products', async () => {
  const { owner, market } = await seedOwnedMarket();
  const tomato = await seedProduct('Tomato');
  const onion = await seedProduct('Onion');

  await setPrice(owner, market, tomato, 42);
  await setPrice(owner, market, onion, 30);
  await settle();

  const res = await api().get(
    `/api/markets/${market._id}/price-history?productIds=${tomato._id.toHexString()}`
  );

  assert.equal(Object.keys(res.body.data.series).length, 1);
  assert.ok(res.body.data.series[tomato._id.toHexString()]);
});
