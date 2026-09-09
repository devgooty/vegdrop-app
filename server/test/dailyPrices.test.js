'use strict';

/**
 * The daily price round.
 *
 * The distinction under test throughout is between a price CHANGING and a price
 * being CONFIRMED. Most of a market's sheet holds steady day to day, so the
 * common morning action is "yesterday's numbers still stand" — and that has to
 * be recordable without either retyping every line or telling the customer's
 * price chart that a hundred prices moved to the values they already had.
 *
 * `updatedAt` is the price's history. `confirmedAt` is the owner's attention.
 * These pin that they never leak into one another.
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
const MarketPriceHistory = require('../models/MarketPriceHistory');
const Product = require('../models/Product');
const { startOfMarketDay } = require('../utils/marketDay');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedProduct(name = 'Tomato', pricePaise = 4000) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise, stock: 500 });
}

async function ownedMarket() {
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

const DAY_MS = 24 * 60 * 60 * 1000;

test('saving a price stamps both when it changed and that it was confirmed', async () => {
  const { owner, market } = await ownedMarket();
  const tomato = await seedProduct('Tomato');

  await api()
    .put(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .send({ prices: [{ productId: String(tomato._id), price: 40 }] })
    .expect(200);

  const row = await MarketPrice.findOne({ market: market._id }).lean();
  assert.equal(row.pricePaise, 4000);
  assert.ok(row.confirmedAt, 'a save is also a confirmation');
  assert.equal(String(row.confirmedBy), String(owner.user._id));
});

/**
 * The case the whole feature exists for.
 *
 * Confirming must mark the sheet as dealt with today WITHOUT touching
 * `updatedAt` — which is what the customer-facing "last changed" reading and
 * the sheet's own `changedToday` flag are computed from.
 */
test('confirming an unchanged price records attention without faking a change', async () => {
  const { owner, market } = await ownedMarket();
  const tomato = await seedProduct('Tomato');

  await MarketPrice.create({
    market: market._id,
    product: tomato._id,
    pricePaise: 4000,
    updatedAt: new Date(Date.now() - 30 * DAY_MS),
  });

  const before = await MarketPrice.findOne({ market: market._id }).lean();

  const confirmed = await api()
    .post(`/api/markets/${market._id}/prices/confirm`)
    .set(auth(owner.accessToken))
    .send({})
    .expect(200);

  assert.equal(confirmed.body.data.confirmed, 1);

  const after = await MarketPrice.findOne({ market: market._id }).lean();
  assert.ok(after.confirmedAt, 'confirmedAt is set');
  assert.equal(
    after.updatedAt.getTime(),
    before.updatedAt.getTime(),
    'updatedAt must not move — the price did not change'
  );
  assert.equal(after.pricePaise, 4000);

  // And nothing may reach the customer's price chart.
  assert.equal(await MarketPriceHistory.countDocuments({ market: market._id }), 0);
});

test('confirming can be scoped to the lines still outstanding', async () => {
  const { owner, market } = await ownedMarket();
  const tomato = await seedProduct('Tomato');
  const onion = await seedProduct('Onion');

  await MarketPrice.create([
    { market: market._id, product: tomato._id, pricePaise: 4000 },
    { market: market._id, product: onion._id, pricePaise: 3000 },
  ]);

  await api()
    .post(`/api/markets/${market._id}/prices/confirm`)
    .set(auth(owner.accessToken))
    .send({ productIds: [String(onion._id)] })
    .expect(200);

  const rows = await MarketPrice.find({ market: market._id }).lean();
  const byProduct = new Map(rows.map((r) => [String(r.product), r]));

  assert.ok(byProduct.get(String(onion._id)).confirmedAt);
  assert.equal(
    byProduct.get(String(tomato._id)).confirmedAt,
    null,
    'a line the owner is still thinking about must not be signed off'
  );
});

test('the price sheet reports what each line closed at yesterday', async () => {
  const { owner, market } = await ownedMarket();
  const tomato = await seedProduct('Tomato');

  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4500 });

  // Yesterday's close, and an older point that must not win.
  await MarketPriceHistory.create([
    {
      market: market._id,
      product: tomato._id,
      pricePaise: 3000,
      at: new Date(startOfMarketDay().getTime() - 5 * DAY_MS),
    },
    {
      market: market._id,
      product: tomato._id,
      pricePaise: 3800,
      at: new Date(startOfMarketDay().getTime() - 60 * 1000),
    },
  ]);

  const sheet = await api()
    .get(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .expect(200);

  const row = sheet.body.data[0];
  assert.equal(row.pricePaise, 4500);
  assert.equal(row.previousPricePaise, 3800, 'the latest point before today, not the oldest');
});

test('a line with no history is reported as new rather than as unchanged', async () => {
  const { owner, market } = await ownedMarket();
  const tomato = await seedProduct('Tomato');
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4500 });

  const sheet = await api()
    .get(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .expect(200);

  assert.equal(sheet.body.data[0].previousPricePaise, null);
});

/**
 * A price set this morning must not be reported as yesterday's close, or the
 * delta shown against it would be zero for every line the owner just edited.
 */
test("today's own history points are excluded from yesterday's close", async () => {
  const { owner, market } = await ownedMarket();
  const tomato = await seedProduct('Tomato');

  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 5000 });
  await MarketPriceHistory.create([
    {
      market: market._id,
      product: tomato._id,
      pricePaise: 4000,
      at: new Date(startOfMarketDay().getTime() - 60 * 1000),
    },
    {
      market: market._id,
      product: tomato._id,
      pricePaise: 5000,
      at: new Date(startOfMarketDay().getTime() + 60 * 1000),
    },
  ]);

  const sheet = await api()
    .get(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .expect(200);

  assert.equal(sheet.body.data[0].previousPricePaise, 4000);
});

test('the sheet distinguishes changed today from confirmed today', async () => {
  const { owner, market } = await ownedMarket();
  const tomato = await seedProduct('Tomato');
  const onion = await seedProduct('Onion');

  await MarketPrice.create([
    { market: market._id, product: tomato._id, pricePaise: 4000 },
    { market: market._id, product: onion._id, pricePaise: 3000 },
  ]);

  /**
   * Backdate the onion, so it represents a price set on an earlier day.
   *
   * `create` stamps `updatedAt` with now whatever is passed, so a row inserted
   * by a fixture is genuinely "changed today" — which is correct behaviour for
   * a line whose price really was first set this morning, and therefore the
   * wrong starting state for this test. Written through `updateOne` with
   * `timestamps: false` for the same reason the confirm route uses it.
   */
  await MarketPrice.updateOne(
    { market: market._id, product: onion._id },
    { $set: { updatedAt: new Date(startOfMarketDay().getTime() - 3 * DAY_MS) } },
    { timestamps: false }
  );

  // One changed through the sheet, one merely confirmed.
  await api()
    .put(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .send({ prices: [{ productId: String(tomato._id), price: 44 }] })
    .expect(200);

  await api()
    .post(`/api/markets/${market._id}/prices/confirm`)
    .set(auth(owner.accessToken))
    .send({ productIds: [String(onion._id)] })
    .expect(200);

  const sheet = await api()
    .get(`/api/markets/${market._id}/prices`)
    .set(auth(owner.accessToken))
    .expect(200);

  const byName = new Map(sheet.body.data.map((r) => [r.product.name, r]));

  assert.equal(byName.get('Tomato').changedToday, true);
  assert.equal(byName.get('Tomato').confirmedToday, true);

  assert.equal(byName.get('Onion').changedToday, false);
  assert.equal(byName.get('Onion').confirmedToday, true);
});

test('confirming another owner’s sheet is refused before anything is written', async () => {
  const { market } = await ownedMarket();
  const stranger = await authenticatedUser('market_owner');
  const tomato = await seedProduct('Tomato');
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  await api()
    .post(`/api/markets/${market._id}/prices/confirm`)
    .set(auth(stranger.accessToken))
    .send({})
    .expect(403);

  const row = await MarketPrice.findOne({ market: market._id }).lean();
  assert.equal(row.confirmedAt, null);
});

test('a shopkeeper cannot confirm a market’s prices', async () => {
  const { market } = await ownedMarket();
  const trader = await authenticatedUser('shopkeeper');

  await api()
    .post(`/api/markets/${market._id}/prices/confirm`)
    .set(auth(trader.accessToken))
    .send({})
    .expect(403);
});
