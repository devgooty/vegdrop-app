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
const { findNearestRider } = require('../services/dispatch');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

// Hyderabad. Roughly 1 km north is +0.009 latitude; 30 km is +0.27.
const HYD = { lat: 17.385, lng: 78.4867 };

/**
 * A KYC-verified shopkeeper with a pin, i.e. one that should actually be listed.
 * Everything a shop needs to appear is background state for most of these tests;
 * the ones about the gates set it up by hand instead.
 */
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

async function seedProduct({ owner = null, name = 'Tomato', pricePaise = 9900 } = {}) {
  return Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name,
    pricePaise,
    stock: 500,
    owner,
  });
}

async function seedMarket() {
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [HYD.lng, HYD.lat] },
    owner: owner.user._id,
  });
  return { owner, market };
}

const nearby = (token) => {
  const req = api().get(`/api/shops/nearby?lat=${HYD.lat}&lng=${HYD.lng}`);
  return token ? req.set(auth(token)) : req;
};

// ---------------------------------------------------------------------------
// Setting the pin
// ---------------------------------------------------------------------------

test('a shop pin is stored as [lng, lat], not [lat, lng]', async () => {
  const shop = await seedListedShop({ lat: 17.4, lng: 78.5 });

  const stored = await User.findById(shop.user._id).lean();
  assert.deepEqual(
    stored.shop.location.coordinates,
    [78.5, 17.4],
    'GeoJSON is [longitude, latitude]; reversing it returns no results rather than erroring'
  );
});

test('the shop name falls back to the shopkeeper own name', async () => {
  const shop = await authenticatedUser('shopkeeper');
  await verifyVendor(shop.user);

  await api().put('/api/shops/me/location').set(auth(shop.accessToken)).send(HYD);

  const stored = await User.findById(shop.user._id).lean();
  assert.equal(stored.shop.name, shop.user.name, 'a blank name would list as an empty row');
});

test('only a shopkeeper may set a shop location', async () => {
  for (const role of ['customer', 'delivery']) {
    const actor = await authenticatedUser(role);
    const res = await api().put('/api/shops/me/location').set(auth(actor.accessToken)).send(HYD);
    assert.equal(res.status, 403, `${role} must not be able to set a shop pin`);
  }
});

test('an unknown field or an out-of-range coordinate is refused', async () => {
  const shop = await authenticatedUser('shopkeeper');

  const extra = await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ ...HYD, isOpen: true });
  assert.equal(extra.status, 400, 'strict schemas are what block mass assignment');

  const bad = await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ lat: 91, lng: 78 });
  assert.equal(bad.status, 400);
});

test('GET /shops/me reports why a shop is not listed', async () => {
  const shop = await authenticatedUser('shopkeeper');

  const before = await api().get('/api/shops/me').set(auth(shop.accessToken));
  assert.equal(before.status, 200);
  assert.equal(before.body.data.hasLocation, false);
  assert.equal(before.body.data.kycVerified, false);

  await verifyVendor(shop.user);
  await api().put('/api/shops/me/location').set(auth(shop.accessToken)).send(HYD);

  const after = await api().get('/api/shops/me').set(auth(shop.accessToken));
  assert.equal(after.body.data.hasLocation, true);
  assert.equal(after.body.data.kycVerified, true);
  assert.equal(after.body.data.hasStall, false);
  assert.equal(after.body.data.lat, HYD.lat, 'read back in lat/lng order, not GeoJSON order');
  assert.equal(after.body.data.lng, HYD.lng);
});

// ---------------------------------------------------------------------------
// Who appears in the list
// ---------------------------------------------------------------------------

test('shops come back nearest first, and one outside the radius is dropped', async () => {
  await seedListedShop({ lat: HYD.lat + 0.027, name: 'Three km away' }); // ~3 km
  await seedListedShop({ lat: HYD.lat + 0.009, name: 'One km away' }); // ~1 km
  await seedListedShop({ lat: HYD.lat + 0.27, name: 'Thirty km away' }); // ~30 km

  const res = await nearby();
  assert.equal(res.status, 200);

  const names = res.body.data.map((s) => s.name);
  assert.deepEqual(names, ['One km away', 'Three km away'], 'nearest first, far one excluded');
  assert.ok(res.body.data[0].distanceMeters < res.body.data[1].distanceMeters);
});

test('a shopkeeper who trades at a market is never listed as a shop', async () => {
  const { market } = await seedMarket();
  const shop = await seedListedShop({ name: 'Joined a market' });

  const stall = await Stall.create({
    market: market._id,
    stallNumber: 'A-7',
    name: 'Joined a market',
    owner: shop.user._id,
    status: 'approved',
  });

  const res = await nearby();
  assert.equal(res.body.data.length, 0, 'an approved stall is reached through its market');

  // A pending or rejected application does not put anyone in a market yet, so
  // they are still their own shop until an owner actually accepts them.
  for (const status of ['pending', 'rejected']) {
    await Stall.updateOne({ _id: stall._id }, { $set: { status } });
    const again = await nearby();
    assert.equal(again.body.data.length, 1, `a ${status} application must not delist a shop`);
  }
});

test('a shop with no completed KYC is not listed', async () => {
  const shop = await authenticatedUser('shopkeeper');
  await api().put('/api/shops/me/location').set(auth(shop.accessToken)).send(HYD);

  const res = await nearby();
  assert.equal(
    res.body.data.length,
    0,
    'nobody vets an independent shop, so the penny drop stands in for an approver'
  );
});

test('a shop with no pin, a closed shop, and a suspended one are all absent', async () => {
  // No pin at all.
  const noPin = await authenticatedUser('shopkeeper');
  await verifyVendor(noPin.user);

  const closed = await seedListedShop({ name: 'Shutters down' });
  await api().patch('/api/shops/me').set(auth(closed.accessToken)).send({ isOpen: false });

  const suspended = await seedListedShop({ name: 'Suspended' });
  await User.updateOne({ _id: suspended.user._id }, { $set: { status: 'suspended' } });

  const res = await nearby();
  assert.equal(res.body.data.length, 0);
});

test('a rider parked at the same spot is never mistaken for a shop', async () => {
  const rider = await authenticatedUser('delivery');
  await User.updateOne(
    { _id: rider.user._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: [HYD.lng, HYD.lat] },
        'rider.lastLocationAt': new Date(),
      },
    }
  );

  const res = await nearby();
  assert.equal(res.body.data.length, 0, 'the query is pinned to role: shopkeeper');
});

test('a shop beyond its own delivery range is shown, but flagged', async () => {
  const shop = await seedListedShop({ lat: HYD.lat + 0.045 }); // ~5 km
  await api()
    .patch('/api/shops/me')
    .set(auth(shop.accessToken))
    .send({ serviceRadiusMeters: 1000 });

  const res = await nearby();
  assert.equal(res.body.data.length, 1, 'hiding it silently just raises the question');
  assert.equal(res.body.data[0].deliverable, false);
});

test('the list never carries the shopkeeper name, phone or email', async () => {
  const shop = await seedListedShop({ name: 'Ravi Vegetables' });
  const stored = await User.findById(shop.user._id).lean();

  const res = await nearby();
  const body = JSON.stringify(res.body);

  assert.equal(res.body.data.length, 1);
  assert.ok(!body.includes(stored.name), 'a person name is not shop data');
  if (stored.phone) assert.ok(!body.includes(stored.phone));
  if (stored.email) assert.ok(!body.includes(stored.email));
  assert.ok(body.includes('Ravi Vegetables'), 'the shop display name is the public one');
});

test('an unauthenticated visitor can browse shops', async () => {
  await seedListedShop();
  const res = await nearby();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
});

// ---------------------------------------------------------------------------
// The two-2dsphere-index trap
// ---------------------------------------------------------------------------

test('adding shop.location does not break the nearest-rider search', async () => {
  const { market } = await seedMarket();
  await seedListedShop();

  const rider = await authenticatedUser('delivery');
  await User.updateOne(
    { _id: rider.user._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: [HYD.lng, HYD.lat] },
        'rider.lastLocationAt': new Date(),
      },
    }
  );

  /**
   * User now carries two 2dsphere indexes. A $geoNear that does not name its
   * `key` fails outright at query time — so this asserts both geo queries on the
   * collection still work, not just the new one.
   */
  const shops = await nearby();
  assert.equal(shops.status, 200, 'shop search must name key: shop.location');

  const nearest = await findNearestRider({ marketLocation: market.location, excludeIds: [] });
  assert.ok(nearest, 'rider dispatch must still name key: rider.lastLocation');
  assert.equal(String(nearest._id), String(rider.user._id));
});

test('markets near me still works alongside shops near me', async () => {
  await seedMarket();
  await seedListedShop();

  const res = await api().get(`/api/markets/nearby?lat=${HYD.lat}&lng=${HYD.lng}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1, 'the market path must be untouched');
});

// ---------------------------------------------------------------------------
// Ordering from a shop
// ---------------------------------------------------------------------------

/** A verified shop with one product of its own, plus a signed-in customer. */
async function seedShopWithStock() {
  const shop = await seedListedShop();
  const product = await seedProduct({ owner: shop.user._id });
  const customer = await authenticatedUser('customer');
  return { shop, product, customer };
}

const placeOrder = (customer, body) =>
  api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({ address: '5 Park Lane', paymentMethod: 'cod', ...body });

test('an order placed with a shop stays marketless and waits for that shop', async () => {
  const { shop, product, customer } = await seedShopWithStock();

  const res = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 2 }],
    shopId: String(shop.user._id),
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.market, null, 'no market means no sourcing window and no sweeper');
  assert.equal(String(res.body.data.shop), String(shop.user._id));
  assert.equal(res.body.data.shopName, 'Ravi Vegetables');
  assert.equal(res.body.data.status, 'Pending');
  assert.equal(res.body.data.fulfillment?.status ?? null, null);
  // Priced from the catalog, exactly as the legacy path.
  assert.equal(res.body.data.subtotalPaise, product.pricePaise * 2);
});

test('an order cannot name both a market and a shop', async () => {
  const { market } = await seedMarket();
  const { shop, product, customer } = await seedShopWithStock();

  const res = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
    marketId: String(market._id),
  });

  assert.equal(res.status, 400);
});

test('a shop that has since joined a market refuses direct orders', async () => {
  const { market } = await seedMarket();
  const { shop, product, customer } = await seedShopWithStock();

  await Stall.create({
    market: market._id,
    stallNumber: 'B-2',
    name: 'Ravi Vegetables',
    owner: shop.user._id,
    status: 'approved',
  });

  const res = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
  });

  assert.equal(res.status, 409, 'a stale card must not keep selling');
  assert.equal(res.body.error.code, 'SHOP_JOINED_MARKET');
});

test('a closed shop refuses orders', async () => {
  const { shop, product, customer } = await seedShopWithStock();
  await api().patch('/api/shops/me').set(auth(shop.accessToken)).send({ isOpen: false });

  const res = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'SHOP_UNAVAILABLE');
});

test('a basket cannot mix one shop items with another seller', async () => {
  const { shop, product, customer } = await seedShopWithStock();
  const shared = await seedProduct({ name: 'Platform Onion' });

  const res = await placeOrder(customer, {
    items: [
      { productId: String(product._id), quantity: 1 },
      { productId: String(shared._id), quantity: 1 },
    ],
    shopId: String(shop.user._id),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'MIXED_SELLERS');
});

// ---------------------------------------------------------------------------
// Who can see a shop order
// ---------------------------------------------------------------------------

test('one shop cannot see another shop orders', async () => {
  const { shop, product, customer } = await seedShopWithStock();
  const other = await seedListedShop({ name: 'Competitor' });

  const created = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
  });
  assert.equal(created.status, 201);

  const mine = await api().get('/api/orders').set(auth(shop.accessToken));
  assert.equal(mine.body.data.length, 1, 'the shop the order was placed with must see it');

  const theirs = await api().get('/api/orders').set(auth(other.accessToken));
  assert.equal(theirs.body.data.length, 0, 'a competitor must not see it at all');
});

test('a stall-holding shopkeeper does not see an independent shop order', async () => {
  const { market } = await seedMarket();
  const { shop, product, customer } = await seedShopWithStock();

  const stallHolder = await authenticatedUser('shopkeeper');
  await Stall.create({
    market: market._id,
    stallNumber: 'C-3',
    name: 'In the market',
    owner: stallHolder.user._id,
    status: 'approved',
  });

  await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
  });

  const res = await api().get('/api/orders').set(auth(stallHolder.accessToken));
  assert.equal(res.body.data.length, 0);
});

test('a legacy order with no seller is still shared by every shopkeeper', async () => {
  const { market } = await seedMarket();
  const shared = await seedProduct({ name: 'Platform Onion' });
  const customer = await authenticatedUser('customer');

  const shopA = await seedListedShop({ name: 'Shop A' });
  const shopB = await seedListedShop({ name: 'Shop B' });
  const stallHolder = await authenticatedUser('shopkeeper');
  await Stall.create({
    market: market._id,
    stallNumber: 'D-4',
    name: 'In the market',
    owner: stallHolder.user._id,
    status: 'approved',
  });

  // Neither marketId nor shopId: the original single-shop flow.
  const created = await placeOrder(customer, {
    items: [{ productId: String(shared._id), quantity: 1 }],
  });
  assert.equal(created.status, 201);

  for (const actor of [shopA, shopB, stallHolder]) {
    const res = await api().get('/api/orders').set(auth(actor.accessToken));
    assert.equal(res.body.data.length, 1, 'narrowing the filter must not strand legacy orders');
  }
});

test('only the shop an order belongs to can move it along', async () => {
  const { shop, product, customer } = await seedShopWithStock();
  const other = await seedListedShop({ name: 'Competitor' });

  const created = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
  });
  const orderId = created.body.data.id;

  const stranger = await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(other.accessToken))
    .send({ status: 'Preparing' });
  assert.equal(stranger.status, 404, 'and 404, not 403 — the id itself is not their business');

  const owner = await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.data.status, 'Preparing');
});

test('a rider can still claim a shop order from the open pool', async () => {
  const { shop, product, customer } = await seedShopWithStock();

  const created = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
  });
  const orderId = created.body.data.id;

  await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });

  // An independent shop has no market, so the nearest-rider cascade has no
  // origin to measure from; the legacy open pool is how it reaches a courier.
  const rider = await authenticatedUser('delivery');
  const res = await api().post(`/api/orders/${orderId}/claim`).set(auth(rider.accessToken));
  assert.equal(res.status, 200);
});

test('coordinates are stored on a marketless order too', async () => {
  const { shop, product, customer } = await seedShopWithStock();

  const res = await placeOrder(customer, {
    items: [{ productId: String(product._id), quantity: 1 }],
    shopId: String(shop.user._id),
    lat: 17.4,
    lng: 78.5,
  });

  assert.equal(res.status, 201);
  const Order = require('../models/Order');
  const stored = await Order.findById(res.body.data.id).lean();
  assert.deepEqual(stored.deliveryLocation.coordinates, [78.5, 17.4]);
});

// ---------------------------------------------------------------------------
// Per-shop catalogs
// ---------------------------------------------------------------------------

test('a shop catalog returns only that shop own listings', async () => {
  const shopA = await seedListedShop({ name: 'Shop A' });
  const shopB = await seedListedShop({ name: 'Shop B' });
  await seedProduct({ owner: shopA.user._id, name: 'A Tomato' });
  await seedProduct({ owner: shopB.user._id, name: 'B Potato' });
  await seedProduct({ name: 'Platform Onion' });

  const scoped = await api().get(`/api/products?shopId=${shopA.user._id}`);
  assert.deepEqual(scoped.body.data.map((p) => p.name), ['A Tomato']);

  const all = await api().get('/api/products');
  assert.equal(all.body.data.length, 3, 'an unscoped read is unchanged');
});

test('a product a shopkeeper adds is owned by them', async () => {
  const shop = await seedListedShop();

  const res = await api()
    .post('/api/products')
    .set(auth(shop.accessToken))
    .send({ sku: `SKU-${uniq()}`, categoryId: 1, name: 'Own Carrot', price: 40, stock: 10 });

  assert.equal(res.status, 201);
  const stored = await Product.findById(res.body.data.id).lean();
  assert.equal(String(stored.owner), String(shop.user._id));
});

test('a shopkeeper cannot edit or restock another shop product', async () => {
  const shopA = await seedListedShop({ name: 'Shop A' });
  const shopB = await seedListedShop({ name: 'Shop B' });
  const theirs = await seedProduct({ owner: shopB.user._id, name: 'B Potato' });

  const edit = await api()
    .patch(`/api/products/${theirs._id}`)
    .set(auth(shopA.accessToken))
    .send({ price: 1 });
  assert.equal(edit.status, 404);

  const restock = await api()
    .patch(`/api/products/${theirs._id}/stock`)
    .set(auth(shopA.accessToken))
    .send({ stock: 0 });
  assert.equal(restock.status, 404);

  const untouched = await Product.findById(theirs._id).lean();
  assert.equal(untouched.pricePaise, 9900);
  assert.equal(untouched.stock, 500);
});

test('mine returns the shared catalog plus my own, never a competitor listing', async () => {
  const shopA = await seedListedShop({ name: 'Shop A' });
  const shopB = await seedListedShop({ name: 'Shop B' });
  await seedProduct({ owner: shopA.user._id, name: 'A Tomato' });
  await seedProduct({ owner: shopB.user._id, name: 'B Potato' });
  await seedProduct({ name: 'Platform Onion' });

  const res = await api().get('/api/products?mine=true').set(auth(shopA.accessToken));

  const names = res.body.data.map((p) => p.name).sort();
  assert.deepEqual(
    names,
    ['A Tomato', 'Platform Onion'],
    'the shared rows are what the legacy single-shop flow manages; the competitor row is not'
  );
});

test('a mine listing is never stored in a shared cache', async () => {
  const shop = await seedListedShop();

  const scoped = await api().get('/api/products?mine=true').set(auth(shop.accessToken));
  assert.match(
    scoped.headers['cache-control'],
    /no-store/,
    'two shopkeepers get different answers from this URL'
  );

  const open = await api().get('/api/products');
  assert.match(open.headers['cache-control'], /public/, 'the plain catalog stays cacheable');
});

test('the shared catalog stays writable, which the single-shop flow depends on', async () => {
  const shop = await seedListedShop();
  const shared = await seedProduct({ name: 'Platform Onion' });

  const res = await api()
    .patch(`/api/products/${shared._id}/stock`)
    .set(auth(shop.accessToken))
    .send({ stock: 7 });

  assert.equal(res.status, 200, 'excluding it would log every existing vendor out of inventory');
  assert.equal(res.body.data.stock, 7);
});
