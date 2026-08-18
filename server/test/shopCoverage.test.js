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
  verifyVendor,
} = require('./helpers');

const Market = require('../models/Market');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

// Hyderabad. Roughly 1 km north is +0.009 latitude.
const HYD = { lat: 17.385, lng: 78.4867 };

/** A shared-catalog item: `owner: null` is what makes it the canonical row. */
async function seedCatalogItem(name) {
  return Product.create({
    sku: `CAT-${uniq()}`,
    categoryId: 1,
    name,
    pricePaise: 4000,
    stock: 500,
    owner: null,
    createdBy: null,
  });
}

/** A KYC-verified shop with a pin — everything needed to be listed at all. */
async function seedListedShop({ lat = HYD.lat, lng = HYD.lng, name = 'Ravi Vegetables' } = {}) {
  const shop = await authenticatedUser('shopkeeper');
  await verifyVendor(shop.user);
  const res = await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ lat, lng, name, address: '12 Main Road' });
  assert.equal(res.status, 200, 'shop location should save');
  return shop;
}

/**
 * One of a shop's own listings, linked to the catalog item it is an instance of.
 * `catalogItem: null` reproduces a listing nobody has linked yet.
 */
async function stockItem(shop, catalogItem, { stock = 50, linked = true } = {}) {
  return Product.create({
    sku: `SHOP-${uniq()}`,
    categoryId: 1,
    name: catalogItem.name,
    pricePaise: 4200,
    stock,
    owner: shop.user._id,
    createdBy: shop.user._id,
    catalogItem: linked ? catalogItem._id : null,
  });
}

function coverage(items, { lat = HYD.lat, lng = HYD.lng, token } = {}) {
  const req = api().post('/api/shops/nearby/coverage');
  if (token) req.set(auth(token));
  return req.send({ lat, lng, items });
}

const basketOf = (catalogItems, quantity = 1) =>
  catalogItems.map((item) => ({ productId: item._id.toHexString(), quantity }));

// ---------------------------------------------------------------------------
// The ranking this endpoint exists for
// ---------------------------------------------------------------------------

/**
 * The whole point: five items wanted, three shops holding different amounts of
 * them, and the one holding all five comes first.
 */
test('shops are ranked by how much of the basket they can supply', async () => {
  const catalog = await Promise.all(
    ['Tomato', 'Onion', 'Potato', 'Carrot', 'Spinach'].map(seedCatalogItem)
  );

  const all5 = await seedListedShop({ name: 'Anand Veg' });
  const only4 = await seedListedShop({ name: 'Ravi Store' });
  const only3 = await seedListedShop({ name: 'Sri Fresh' });

  await Promise.all(catalog.map((item) => stockItem(all5, item)));
  await Promise.all(catalog.slice(0, 4).map((item) => stockItem(only4, item)));
  await Promise.all(catalog.slice(0, 3).map((item) => stockItem(only3, item)));

  const res = await coverage(basketOf(catalog));
  assert.equal(res.status, 200);

  const byName = new Map(res.body.data.map((s) => [s.name, s]));
  assert.equal(byName.get('Anand Veg').covered, 5);
  assert.equal(byName.get('Ravi Store').covered, 4);
  assert.equal(byName.get('Sri Fresh').covered, 3);
  assert.equal(byName.get('Anand Veg').total, 5);

  assert.equal(res.body.data[0].canFillBasket, true);
  assert.equal(byName.get('Ravi Store').canFillBasket, false);
  assert.equal(byName.get('Sri Fresh').canFillBasket, false);

  /**
   * Steadily fewer items down the list, including among the shops that cannot
   * fill it. None of those is selectable, but "has 3 of your 5" listed above
   * "has 4 of your 5" reads as a broken ranking rather than a fact about which
   * is nearer.
   */
  assert.deepEqual(
    res.body.data.map((s) => s.name),
    ['Anand Veg', 'Ravi Store', 'Sri Fresh']
  );
});

/**
 * Distance is the LAST word, not the first. A nearer shop that cannot complete
 * the order is not a better answer than a further one that can — it cannot be
 * ordered from at all, because checkout requires every line to be its own.
 */
test('a full basket beats a closer shop that is missing something', async () => {
  const catalog = await Promise.all(['Tomato', 'Onion'].map(seedCatalogItem));

  // ~1.1 km north, versus right on top of the customer.
  const farButComplete = await seedListedShop({ name: 'Complete', lat: HYD.lat + 0.01 });
  const nearButPartial = await seedListedShop({ name: 'Partial' });

  await Promise.all(catalog.map((item) => stockItem(farButComplete, item)));
  await stockItem(nearButPartial, catalog[0]);

  const res = await coverage(basketOf(catalog));
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].name, 'Complete');
  assert.ok(
    res.body.data[0].distanceMeters > res.body.data[1].distanceMeters,
    'and it really is the further of the two'
  );
});

// ---------------------------------------------------------------------------
// What counts as covered
// ---------------------------------------------------------------------------

/**
 * Listing an item is not the same as having enough of it. A shop with one tomato
 * does not cover a line of three, and counting it would route the order
 * somewhere that cannot fill it — the failure this endpoint exists to prevent.
 */
test('stock must cover the quantity, not merely exist', async () => {
  const [tomato, onion] = await Promise.all([seedCatalogItem('Tomato'), seedCatalogItem('Onion')]);
  const shop = await seedListedShop();

  await stockItem(shop, tomato, { stock: 1 });
  await stockItem(shop, onion, { stock: 10 });

  const res = await coverage([
    { productId: tomato._id.toHexString(), quantity: 3 },
    { productId: onion._id.toHexString(), quantity: 3 },
  ]);

  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].covered, 1, 'only the line it holds enough of');
  assert.equal(res.body.data[0].canFillBasket, false);
});

/**
 * An unlinked listing is invisible here, by design. Matching on names at request
 * time is what this field exists to avoid — a wrong match is worse than a miss,
 * because it promises produce the shop may not have.
 */
test('a listing with no catalogItem does not count, even with a matching name', async () => {
  const tomato = await seedCatalogItem('Tomato');
  const shop = await seedListedShop();

  // Same name, deliberately unlinked.
  await stockItem(shop, tomato, { linked: false });

  const res = await coverage(basketOf([tomato]));
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].covered, 0);
});

/** Another shop's listing is not this shop's coverage. */
test('coverage is scoped to each shop, never pooled', async () => {
  const [tomato, onion] = await Promise.all([seedCatalogItem('Tomato'), seedCatalogItem('Onion')]);
  const a = await seedListedShop({ name: 'A Store' });
  const b = await seedListedShop({ name: 'B Store' });

  await stockItem(a, tomato);
  await stockItem(b, onion);

  const res = await coverage(basketOf([tomato, onion]));
  const byName = new Map(res.body.data.map((s) => [s.name, s]));
  assert.equal(byName.get('A Store').covered, 1);
  assert.equal(byName.get('B Store').covered, 1);
  assert.equal(byName.get('A Store').canFillBasket, false);
  assert.equal(byName.get('B Store').canFillBasket, false);
});

/**
 * The mapping is the reason checkout needs no change: the client posts the
 * SHOP's product ids, so the `MIXED_SELLERS` guard passes as written.
 */
test('each shop reports its own product id for every covered line', async () => {
  const tomato = await seedCatalogItem('Tomato');
  const shop = await seedListedShop();
  const listing = await stockItem(shop, tomato);

  const res = await coverage([{ productId: tomato._id.toHexString(), quantity: 2 }]);
  assert.equal(res.status, 200);

  assert.deepEqual(res.body.data[0].lines, [
    {
      catalogItemId: tomato._id.toHexString(),
      productId: listing._id.toHexString(),
      quantity: 2,
      /**
       * The shop's price, not the catalog's — `stockItem` lists at 4200 against
       * a 4000 catalog row. The basket is re-priced from this the moment a shop
       * is chosen, so that the number shown and the number charged agree.
       */
      pricePaise: 4200,
      price: 42,
    },
  ]);
});

/** Repeats collapse and their quantities add, exactly as checkout does it. */
test('the same item listed twice counts once, with the quantities summed', async () => {
  const tomato = await seedCatalogItem('Tomato');
  const shop = await seedListedShop();
  await stockItem(shop, tomato, { stock: 4 });

  const id = tomato._id.toHexString();
  const res = await coverage([
    { productId: id, quantity: 3 },
    { productId: id, quantity: 3 },
  ]);

  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].total, 1, 'one distinct item, not two');
  assert.equal(
    res.body.data[0].covered,
    0,
    'and 6 is what has to be covered, which 4 in stock does not'
  );
});

// ---------------------------------------------------------------------------
// Who is eligible to be listed at all
// ---------------------------------------------------------------------------

/**
 * The same exclusions as `/nearby`, and for the same reasons — a shop that
 * trades at a market is reached through that market, and an unverified one has
 * had no human or penny drop stand behind it.
 */
test('shops excluded from /nearby are excluded here too', async () => {
  const tomato = await seedCatalogItem('Tomato');

  const listed = await seedListedShop({ name: 'Listed' });
  const closed = await seedListedShop({ name: 'Closed' });
  const joined = await seedListedShop({ name: 'Joined a market' });
  const unverified = await authenticatedUser('shopkeeper');

  await api()
    .put('/api/shops/me/location')
    .set(auth(unverified.accessToken))
    .send({ lat: HYD.lat, lng: HYD.lng, name: 'Unverified', address: '9 Side Lane' });

  await Promise.all([
    stockItem(listed, tomato),
    stockItem(closed, tomato),
    stockItem(joined, tomato),
    stockItem(unverified, tomato),
  ]);

  await User.updateOne({ _id: closed.user._id }, { $set: { 'shop.isOpen': false } });

  const marketOwner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [HYD.lng, HYD.lat] },
    owner: marketOwner.user._id,
  });
  await Stall.create({
    market: market._id,
    stallNumber: 'A-1',
    name: 'Joined stall',
    owner: joined.user._id,
    status: 'approved',
  });

  const res = await coverage(basketOf([tomato]));
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.data.map((s) => s.name),
    ['Listed'],
    'only the open, verified, market-free shop is offered'
  );
});

/** No shops in range is an empty list, not an error — the client says so. */
test('nowhere near anything answers with an empty list', async () => {
  const tomato = await seedCatalogItem('Tomato');
  const shop = await seedListedShop();
  await stockItem(shop, tomato);

  // Mumbai, far outside the default 15 km radius.
  const res = await coverage(basketOf([tomato]), { lat: 19.076, lng: 72.8777 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('the basket may not be empty', async () => {
  const res = await coverage([]);
  assert.equal(res.status, 400);
});

test('an unknown body field is refused rather than ignored', async () => {
  const tomato = await seedCatalogItem('Tomato');
  const res = await api()
    .post('/api/shops/nearby/coverage')
    .send({
      lat: HYD.lat,
      lng: HYD.lng,
      items: basketOf([tomato]),
      shopId: '507f1f77bcf86cd799439011',
    });
  assert.equal(res.status, 400, '.strict() is what blocks mass assignment');
});

test('a basket line must carry a real product id', async () => {
  const res = await coverage([{ productId: 'not-an-id', quantity: 1 }]);
  assert.equal(res.status, 400);
});
