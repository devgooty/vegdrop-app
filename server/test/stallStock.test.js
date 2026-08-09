'use strict';

/**
 * The stall's stock screen, and the photographs behind it.
 *
 * Two things are being proved. First, that a shopkeeper can declare what they
 * are holding one product at a time without disturbing the rest — the upsert
 * contract the whole screen is built on. Second, that a photograph of the real
 * produce reaches the customer's catalog, is the freshest one in the market,
 * and stops being shown once it is no longer today's.
 *
 * The price is never the stall's to set. Every assertion about price here is
 * really an assertion that MarketPrice won over Product.pricePaise.
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

const config = require('../config/env');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const StallPhoto = require('../models/StallPhoto');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/**
 * The smallest real JPEG that exists — a 1x1 pixel, base64.
 *
 * Real bytes rather than a made-up string, because the route decodes and
 * re-encodes to verify the payload round-trips.
 */
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const jpegUri = (payload = TINY_JPEG) => `data:image/jpeg;base64,${payload}`;

/** A JPEG data URI whose decoded size is at least `bytes`. */
function oversizedJpeg(bytes) {
  const filler = Buffer.alloc(bytes, 0x41).toString('base64');
  return `data:image/jpeg;base64,${filler}`;
}

async function seedMarket() {
  return Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
  });
}

/**
 * A product priced differently by the platform and by the market.
 *
 * The gap is the point: every price the stall screen shows must be the market's
 * 6000, never the platform's 4000.
 */
async function seedPricedProduct(market, { name = 'Tomato', marketPaise = 6000 } = {}) {
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name,
    pricePaise: 4000,
    stock: 500,
  });
  await MarketPrice.create({ market: market._id, product: product._id, pricePaise: marketPaise });
  return product;
}

async function seedStall(market, stallNumber = 'A-1') {
  const session = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: session.user._id,
    status: 'approved',
  });
  return { ...session, stall };
}

// ---------------------------------------------------------------------------
// Declaring stock
// ---------------------------------------------------------------------------

test('declaring one product leaves the other rows alone', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market, { name: 'Tomato' });
  const onion = await seedPricedProduct(market, { name: 'Onion' });
  const shop = await seedStall(market);

  await api()
    .put('/api/stalls/me/inventory')
    .set(auth(shop.accessToken))
    .send({ items: [{ productId: tomato._id.toHexString(), stock: 12 }] });

  // The screen adds products one at a time from the picker. If this were a
  // replace rather than an upsert, the second add would wipe the first.
  await api()
    .put('/api/stalls/me/inventory')
    .set(auth(shop.accessToken))
    .send({ items: [{ productId: onion._id.toHexString(), stock: 5 }] });

  const rows = await StallInventory.find({ stall: shop.stall._id }).lean();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => String(r.product) === tomato._id.toHexString()).stock, 12);
  assert.equal(rows.find((r) => String(r.product) === onion._id.toHexString()).stock, 5);
});

test('the stock list shows every priced product, at the market price', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market, { name: 'Tomato', marketPaise: 6000 });
  await seedPricedProduct(market, { name: 'Onion', marketPaise: 3300 });
  const shop = await seedStall(market);

  await api()
    .put('/api/stalls/me/inventory')
    .set(auth(shop.accessToken))
    .send({ items: [{ productId: tomato._id.toHexString(), stock: 12 }] });

  const res = await api().get('/api/stalls/me/stock').set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2, 'undeclared products are what the picker offers');

  const held = res.body.data.find((p) => p.name === 'Tomato');
  const notHeld = res.body.data.find((p) => p.name === 'Onion');

  assert.equal(held.stock, 12);
  assert.equal(held.pricePaise, 6000, 'the market price, not Product.pricePaise (4000)');
  assert.equal(held.price, 60);
  assert.equal(notHeld.stock, 0, 'undeclared reads as zero rather than being absent');
  assert.equal(notHeld.pricePaise, 3300);

  assert.equal(res.body.data[0].name, 'Tomato', 'what you hold sorts first');
});

test('a product the market has withdrawn drops off the list', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market, { name: 'Tomato' });
  const shop = await seedStall(market);

  await MarketPrice.updateOne({ market: market._id, product: tomato._id }, { $set: { isAvailable: false } });

  const res = await api().get('/api/stalls/me/stock').set(auth(shop.accessToken));
  assert.equal(res.body.data.length, 0, 'a stall cannot stock what the market is not selling');
});

test('only a stall holder can read a stock list', async () => {
  const customer = await authenticatedUser('customer');
  const res = await api().get('/api/stalls/me/stock').set(auth(customer.accessToken));
  assert.equal(res.status, 403);

  const stallless = await authenticatedUser('shopkeeper');
  const none = await api().get('/api/stalls/me/stock').set(auth(stallless.accessToken));
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, 'NO_STALL');
});

// ---------------------------------------------------------------------------
// Photographs — what is accepted
// ---------------------------------------------------------------------------

test('a JPEG is stored, and reported back with its size', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);

  const res = await api()
    .put(`/api/stalls/me/photos/${tomato._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.takenAt);
  assert.ok(res.body.data.bytes > 0);

  const stored = await StallPhoto.findOne({ stall: shop.stall._id, product: tomato._id }).lean();
  assert.equal(stored.mimeType, 'image/jpeg');
  assert.equal(stored.image, TINY_JPEG, 'the data: prefix is stripped, the payload is not');
  assert.equal(String(stored.market), market._id.toHexString(), 'denormalised for the catalog lookup');
});

test('a photo over the cap is refused', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);

  const res = await api()
    .put(`/api/stalls/me/photos/${tomato._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: oversizedJpeg(config.freshPhoto.maxBytes + 1024) });

  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'PHOTO_TOO_LARGE');
  assert.equal(await StallPhoto.countDocuments({}), 0);
});

test('SVG and PNG are refused, whatever the client claims', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);
  const url = `/api/stalls/me/photos/${tomato._id.toHexString()}`;

  // An SVG is a script container, and this file is served back to customers.
  const svg = await api()
    .put(url)
    .set(auth(shop.accessToken))
    .send({ image: `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}` });
  assert.equal(svg.status, 400);
  assert.equal(svg.body.error.code, 'UNSUPPORTED_IMAGE');

  const png = await api()
    .put(url)
    .set(auth(shop.accessToken))
    .send({ image: `data:image/png;base64,${TINY_JPEG}` });
  assert.equal(png.status, 400);

  const notAnImage = await api()
    .put(url)
    .set(auth(shop.accessToken))
    .send({ image: 'https://example.com/tomato.jpg' });
  assert.equal(notAnImage.status, 400);

  assert.equal(await StallPhoto.countDocuments({}), 0);
});

test('a photo for a product this market does not sell is refused', async () => {
  const market = await seedMarket();
  const shop = await seedStall(market);
  // Priced by the platform, but never put on this market's sheet.
  const elsewhere = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Durian',
    pricePaise: 9000,
    stock: 10,
  });

  const res = await api()
    .put(`/api/stalls/me/photos/${elsewhere._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PRODUCT_UNAVAILABLE');
});

test('a second photo replaces the first', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);
  const url = `/api/stalls/me/photos/${tomato._id.toHexString()}`;

  await api().put(url).set(auth(shop.accessToken)).send({ image: jpegUri() });
  await api().put(url).set(auth(shop.accessToken)).send({ image: jpegUri() });

  assert.equal(
    await StallPhoto.countDocuments({ stall: shop.stall._id, product: tomato._id }),
    1,
    'today overwrites yesterday rather than accumulating a gallery'
  );
});

test('one stall cannot touch another stall photo', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const mine = await seedStall(market, 'A-1');
  const theirs = await seedStall(market, 'A-2');
  const url = `/api/stalls/me/photos/${tomato._id.toHexString()}`;

  await api().put(url).set(auth(mine.accessToken)).send({ image: jpegUri() });

  // The route is scoped to the caller's own stall, so a delete cannot reach
  // across — the product id in the URL is the only thing they control.
  const theirDelete = await api().delete(url).set(auth(theirs.accessToken));
  assert.equal(theirDelete.status, 200);
  assert.equal(theirDelete.body.data.removed, false, 'nothing of theirs to remove');

  assert.equal(await StallPhoto.countDocuments({ stall: mine.stall._id }), 1, 'mine survives');

  // And their own upload creates a second row rather than overwriting mine.
  await api().put(url).set(auth(theirs.accessToken)).send({ image: jpegUri() });
  assert.equal(await StallPhoto.countDocuments({ product: tomato._id }), 2);
});

test('a shopkeeper can remove their own photo', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);
  const url = `/api/stalls/me/photos/${tomato._id.toHexString()}`;

  await api().put(url).set(auth(shop.accessToken)).send({ image: jpegUri() });
  const res = await api().delete(url).set(auth(shop.accessToken));

  assert.equal(res.body.data.removed, true);
  assert.equal(await StallPhoto.countDocuments({}), 0);
});

test('the stock list reports whether this stall has photographed each product', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market, { name: 'Tomato' });
  await seedPricedProduct(market, { name: 'Onion' });
  const shop = await seedStall(market);

  await api()
    .put(`/api/stalls/me/photos/${tomato._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  const res = await api().get('/api/stalls/me/stock').set(auth(shop.accessToken));
  const withPhoto = res.body.data.find((p) => p.name === 'Tomato');
  const without = res.body.data.find((p) => p.name === 'Onion');

  assert.ok(withPhoto.photoTakenAt);
  assert.equal(without.photoTakenAt, null);
  assert.equal(
    JSON.stringify(res.body).includes(TINY_JPEG),
    false,
    'the list carries timestamps only — inlining images would make it megabytes'
  );
});

// ---------------------------------------------------------------------------
// What the customer sees
// ---------------------------------------------------------------------------

test('the catalog reports the newest photo in the market', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const older = await seedStall(market, 'A-1');
  const newer = await seedStall(market, 'A-2');
  const url = `/api/stalls/me/photos/${tomato._id.toHexString()}`;

  await api().put(url).set(auth(older.accessToken)).send({ image: jpegUri() });
  await api().put(url).set(auth(newer.accessToken)).send({ image: jpegUri() });

  // Age the first one so "newest" is unambiguous rather than a millisecond race.
  await StallPhoto.updateOne(
    { stall: older.stall._id },
    { $set: { takenAt: new Date(Date.now() - 60 * 60 * 1000) } }
  );

  const res = await api().get(`/api/markets/${market._id.toHexString()}/catalog`);
  const row = res.body.data.find((p) => p.id === tomato._id.toHexString());

  const newest = await StallPhoto.findOne({ stall: newer.stall._id }).lean();
  assert.equal(
    new Date(row.freshPhotoAt).getTime(),
    new Date(newest.takenAt).getTime(),
    'several stalls hold the same product; the most recent picture is the useful one'
  );
});

test('a photo past the freshness window is not offered as today', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);

  await api()
    .put(`/api/stalls/me/photos/${tomato._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  // Retained for a week, but shown for a day.
  await StallPhoto.updateOne(
    { stall: shop.stall._id },
    { $set: { takenAt: new Date(Date.now() - (config.freshPhoto.freshForHours + 1) * 60 * 60 * 1000) } }
  );

  const res = await api().get(`/api/markets/${market._id.toHexString()}/catalog`);
  const row = res.body.data.find((p) => p.id === tomato._id.toHexString());

  assert.equal(row.freshPhotoAt, null, 'a stale photo is worse than the stock image');

  const bytes = await api().get(
    `/api/markets/${market._id.toHexString()}/products/${tomato._id.toHexString()}/fresh-photo`
  );
  assert.equal(bytes.status, 404, 'and the image itself stops being served');
});

test('the photo route serves real bytes with the right type', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);

  await api()
    .put(`/api/stalls/me/photos/${tomato._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  const res = await api().get(
    `/api/markets/${market._id.toHexString()}/products/${tomato._id.toHexString()}/fresh-photo`
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['cache-control'], /public/, '/api is no-store by default; this opts out');
  assert.deepEqual(res.body, Buffer.from(TINY_JPEG, 'base64'), 'the actual image comes back');
});

test('a product nobody photographed serves a 404, not an empty image', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);

  const res = await api().get(
    `/api/markets/${market._id.toHexString()}/products/${tomato._id.toHexString()}/fresh-photo`
  );
  assert.equal(res.status, 404);
});

test('a photo does not escape its own market', async () => {
  const here = await seedMarket();
  const elsewhere = await seedMarket();
  const tomato = await seedPricedProduct(here);
  await MarketPrice.create({ market: elsewhere._id, product: tomato._id, pricePaise: 7000 });
  const shop = await seedStall(here);

  await api()
    .put(`/api/stalls/me/photos/${tomato._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  const other = await api().get(`/api/markets/${elsewhere._id.toHexString()}/catalog`);
  const row = other.body.data.find((p) => p.id === tomato._id.toHexString());
  assert.equal(row.freshPhotoAt, null, 'a photo is evidence about one market, not the product');
});

// ---------------------------------------------------------------------------
// The sourcing hot path is untouched
// ---------------------------------------------------------------------------

test('photos are not in the collection the cascade reads', async () => {
  const market = await seedMarket();
  const tomato = await seedPricedProduct(market);
  const shop = await seedStall(market);

  await api()
    .put('/api/stalls/me/inventory')
    .set(auth(shop.accessToken))
    .send({ items: [{ productId: tomato._id.toHexString(), stock: 10 }] });
  await api()
    .put(`/api/stalls/me/photos/${tomato._id.toHexString()}`)
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  /**
   * planRound aggregates StallInventory on every sourcing round and projects
   * only at the end, so anything stored on those documents is read first and
   * discarded after. Keeping images in their own collection is what stops fifty
   * kilobytes per row being dragged through the hot path of every order.
   */
  const row = await StallInventory.findOne({ stall: shop.stall._id }).lean();
  assert.deepEqual(
    Object.keys(row).sort(),
    ['__v', '_id', 'createdAt', 'market', 'product', 'stall', 'stock', 'updatedAt'],
    'a photo field appearing here would be a performance regression, not a feature'
  );
});
