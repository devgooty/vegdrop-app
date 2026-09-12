'use strict';

/**
 * CatalogSuggestion — shopkeeper suggests a custom listing; market owner or
 * developer accepts (into shared catalog under a chosen category) or rejects.
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
  verifyVendor,
} = require('./helpers');

const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const CatalogSuggestion = require('../models/CatalogSuggestion');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function verifiedVendor() {
  const session = await authenticatedUser('shopkeeper');
  await verifyVendor(session.user);
  return session;
}

async function listProduct(session, { name = 'Tomato', catalogItem } = {}) {
  const body = {
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name,
    price: 40,
    stock: 100,
    weight: '1 Kg',
  };
  if (catalogItem) body.catalogItem = catalogItem;

  const res = await api()
    .post('/api/products')
    .set(auth(session.accessToken))
    .send(body);

  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function seedShared(name = 'Shared Tomato') {
  return Product.create({
    sku: `CAT-${uniq()}`,
    categoryId: 1,
    name,
    pricePaise: 0,
    stock: 0,
    weight: '1 Kg',
  });
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

async function seedTrader(market, { stallNumber = 'A-1', name = 'Ramesh Vegetables' } = {}) {
  const trader = await verifiedVendor();
  await Stall.create({
    market: market._id,
    stallNumber,
    name,
    owner: trader.user._id,
    status: 'approved',
    isActive: true,
  });
  return trader;
}

test('shopkeeper can suggest an unlinked listing', async () => {
  const vendor = await verifiedVendor();
  const product = await listProduct(vendor, { name: 'Country Tomato' });

  const res = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: product.id });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'pending');
  assert.equal(res.body.data.name, 'Country Tomato');
  assert.equal(String(res.body.data.listing), product.id);
});

test('cannot suggest a linked listing', async () => {
  const vendor = await verifiedVendor();
  const shared = await seedShared();
  const product = await listProduct(vendor, {
    name: 'Linked Tomato',
    catalogItem: shared._id.toHexString(),
  });

  const res = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: product.id });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'ALREADY_LINKED');
});

test('cannot suggest someone else’s listing', async () => {
  const alice = await verifiedVendor();
  const mallory = await verifiedVendor();
  const product = await listProduct(alice, { name: 'Alice Tomato' });

  const res = await api()
    .post('/api/catalog-suggestions')
    .set(auth(mallory.accessToken))
    .send({ listingId: product.id });

  assert.equal(res.status, 404);
});

test('second pending suggest for same listing is 409', async () => {
  const vendor = await verifiedVendor();
  const product = await listProduct(vendor);

  const first = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: product.id });
  assert.equal(first.status, 201);

  const second = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: product.id });

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'SUGGESTION_PENDING');
});

test('shopkeeper sees only their suggestions', async () => {
  const alice = await verifiedVendor();
  const bob = await verifiedVendor();
  const a = await listProduct(alice, { name: 'Alice Item' });
  const b = await listProduct(bob, { name: 'Bob Item' });

  await api().post('/api/catalog-suggestions').set(auth(alice.accessToken)).send({ listingId: a.id });
  await api().post('/api/catalog-suggestions').set(auth(bob.accessToken)).send({ listingId: b.id });

  const res = await api()
    .get('/api/catalog-suggestions')
    .set(auth(alice.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].name, 'Alice Item');
});

test('developer sees all pending suggestions', async () => {
  const vendor = await verifiedVendor();
  const product = await listProduct(vendor, { name: 'Dev Sees This' });
  await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: product.id });

  const developer = await authenticatedUser('developer');
  const res = await api()
    .get('/api/catalog-suggestions?status=pending')
    .set(auth(developer.accessToken));

  assert.equal(res.status, 200);
  assert.ok(res.body.data.some((s) => s.name === 'Dev Sees This'));
});

test('market owner sees suggestions from traders in their markets only', async () => {
  const { owner: ownerA, market: marketA } = await seedOwnedMarket({ name: 'Market A' });
  const { owner: ownerB, market: marketB } = await seedOwnedMarket({ name: 'Market B' });

  const traderA = await seedTrader(marketA, { stallNumber: 'A-1', name: 'Stall A' });
  const traderB = await seedTrader(marketB, { stallNumber: 'B-1', name: 'Stall B' });

  const listingA = await listProduct(traderA, { name: 'From A' });
  const listingB = await listProduct(traderB, { name: 'From B' });

  await api()
    .post('/api/catalog-suggestions')
    .set(auth(traderA.accessToken))
    .send({ listingId: listingA.id });
  await api()
    .post('/api/catalog-suggestions')
    .set(auth(traderB.accessToken))
    .send({ listingId: listingB.id });

  const resA = await api()
    .get('/api/catalog-suggestions?status=pending')
    .set(auth(ownerA.accessToken));
  assert.equal(resA.status, 200);
  assert.equal(resA.body.data.length, 1);
  assert.equal(resA.body.data[0].name, 'From A');

  const resB = await api()
    .get('/api/catalog-suggestions?status=pending')
    .set(auth(ownerB.accessToken));
  assert.equal(resB.status, 200);
  assert.equal(resB.body.data.length, 1);
  assert.equal(resB.body.data[0].name, 'From B');
});

test('accept creates shared product, links listing, marks accepted', async () => {
  const { owner, market } = await seedOwnedMarket();
  const trader = await seedTrader(market);
  const listing = await listProduct(trader, { name: 'Farm Eggs' });
  const listingPrice = listing.pricePaise;

  const created = await api()
    .post('/api/catalog-suggestions')
    .set(auth(trader.accessToken))
    .send({ listingId: listing.id });
  assert.equal(created.status, 201);
  const suggestionId = created.body.data.id;

  const res = await api()
    .post(`/api/catalog-suggestions/${suggestionId}/accept`)
    .set(auth(owner.accessToken))
    .send({ categoryId: 2 });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'accepted');
  assert.ok(res.body.data.sharedProduct);

  const shared = await Product.findById(res.body.data.sharedProduct);
  assert.equal(shared.owner, null);
  assert.equal(shared.categoryId, 2);
  assert.equal(shared.name, 'Farm Eggs');
  assert.equal(shared.pricePaise, 0);
  assert.equal(shared.stock, 0);

  const updatedListing = await Product.findById(listing.id);
  assert.equal(String(updatedListing.catalogItem), String(shared._id));
  assert.equal(updatedListing.pricePaise, listingPrice);
});

test('accept requires categoryId', async () => {
  const { owner, market } = await seedOwnedMarket();
  const trader = await seedTrader(market);
  const listing = await listProduct(trader);
  const created = await api()
    .post('/api/catalog-suggestions')
    .set(auth(trader.accessToken))
    .send({ listingId: listing.id });

  const res = await api()
    .post(`/api/catalog-suggestions/${created.body.data.id}/accept`)
    .set(auth(owner.accessToken))
    .send({});

  assert.equal(res.status, 400);
});

test('reject marks rejected and leaves listing unlinked', async () => {
  const { owner, market } = await seedOwnedMarket();
  const trader = await seedTrader(market);
  const listing = await listProduct(trader, { name: 'Reject Me' });
  const created = await api()
    .post('/api/catalog-suggestions')
    .set(auth(trader.accessToken))
    .send({ listingId: listing.id });

  const res = await api()
    .post(`/api/catalog-suggestions/${created.body.data.id}/reject`)
    .set(auth(owner.accessToken))
    .send({ reason: 'Blurry photo' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'rejected');
  assert.equal(res.body.data.rejectReason, 'Blurry photo');

  const still = await Product.findById(listing.id);
  assert.equal(still.catalogItem, null);
});

test('market owner cannot accept outside their markets', async () => {
  const { market: marketA } = await seedOwnedMarket({ name: 'A' });
  const { owner: ownerB } = await seedOwnedMarket({ name: 'B' });
  const trader = await seedTrader(marketA);
  const listing = await listProduct(trader);
  const created = await api()
    .post('/api/catalog-suggestions')
    .set(auth(trader.accessToken))
    .send({ listingId: listing.id });

  const res = await api()
    .post(`/api/catalog-suggestions/${created.body.data.id}/accept`)
    .set(auth(ownerB.accessToken))
    .send({ categoryId: 1 });

  assert.equal(res.status, 403);
});

test('accept fails if listing already linked', async () => {
  const developer = await authenticatedUser('developer');
  const vendor = await verifiedVendor();
  const listing = await listProduct(vendor, { name: 'Race' });
  const created = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: listing.id });

  const shared = await seedShared('Other');
  await Product.updateOne({ _id: listing.id }, { $set: { catalogItem: shared._id } });

  const res = await api()
    .post(`/api/catalog-suggestions/${created.body.data.id}/accept`)
    .set(auth(developer.accessToken))
    .send({ categoryId: 1 });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'LISTING_NOT_ELIGIBLE');
});

test('shopkeeper cannot accept', async () => {
  const vendor = await verifiedVendor();
  const listing = await listProduct(vendor);
  const created = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: listing.id });

  const res = await api()
    .post(`/api/catalog-suggestions/${created.body.data.id}/accept`)
    .set(auth(vendor.accessToken))
    .send({ categoryId: 1 });

  assert.equal(res.status, 403);
});

test('after reject, shopkeeper may suggest again', async () => {
  const developer = await authenticatedUser('developer');
  const vendor = await verifiedVendor();
  const listing = await listProduct(vendor, { name: 'Retry' });

  const first = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: listing.id });
  assert.equal(first.status, 201);

  await api()
    .post(`/api/catalog-suggestions/${first.body.data.id}/reject`)
    .set(auth(developer.accessToken))
    .send({});

  const second = await api()
    .post('/api/catalog-suggestions')
    .set(auth(vendor.accessToken))
    .send({ listingId: listing.id });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.data.status, 'pending');

  const count = await CatalogSuggestion.countDocuments({ listing: listing.id });
  assert.equal(count, 2);
});
