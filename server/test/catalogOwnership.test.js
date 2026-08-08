'use strict';

/**
 * A vendor may edit their own listings and nobody else's.
 *
 * The catalog is one shared table. While `shopkeeper` was a role an
 * administrator handed out that was merely untidy; vendor self-registration
 * turned it into a way for any stranger who cleared a penny drop to reprice,
 * empty or delist a competitor's entire range.
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

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/** A KYC-cleared shopkeeper — the state self-registration can reach unaided. */
async function verifiedVendor() {
  const session = await authenticatedUser('shopkeeper');
  await verifyVendor(session.user);
  return session;
}

async function listProduct(session, name = 'Tomato') {
  const res = await api()
    .post('/api/products')
    .set(auth(session.accessToken))
    .send({ sku: `SKU-${uniq()}`, categoryId: 1, name, price: 40, stock: 100 });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('a vendor can edit the product they listed', async () => {
  const vendor = await verifiedVendor();
  const product = await listProduct(vendor);

  const res = await api()
    .patch(`/api/products/${product.id}`)
    .set(auth(vendor.accessToken))
    .send({ price: 45 });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.pricePaise, 4500);
});

test('a vendor cannot reprice a competitor listing', async () => {
  const alice = await verifiedVendor();
  const mallory = await verifiedVendor();
  const product = await listProduct(alice, 'Alice Tomato');

  const res = await api()
    .patch(`/api/products/${product.id}`)
    .set(auth(mallory.accessToken))
    .send({ price: 1 });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_YOUR_PRODUCT');

  const unchanged = await Product.findById(product.id);
  assert.equal(unchanged.pricePaise, 4000, 'the competitor price must not move');
});

test('a vendor cannot empty a competitor stock', async () => {
  const alice = await verifiedVendor();
  const mallory = await verifiedVendor();
  const product = await listProduct(alice, 'Alice Onion');

  const res = await api()
    .patch(`/api/products/${product.id}/stock`)
    .set(auth(mallory.accessToken))
    .send({ stock: 0 });

  assert.equal(res.status, 403);

  const unchanged = await Product.findById(product.id);
  assert.equal(unchanged.stock, 100);
});

test('a vendor cannot delist a competitor listing', async () => {
  const alice = await verifiedVendor();
  const mallory = await verifiedVendor();
  const product = await listProduct(alice, 'Alice Chilli');

  const res = await api()
    .patch(`/api/products/${product.id}`)
    .set(auth(mallory.accessToken))
    .send({ isActive: false });

  assert.equal(res.status, 403);

  const unchanged = await Product.findById(product.id);
  assert.equal(unchanged.isActive, true);
});

/**
 * Seeded catalog carries no owner. Treating "unowned" as "first vendor to
 * arrive owns it" would hand the whole platform catalog to whoever asked first.
 */
test('an unowned catalog row is not editable by a vendor', async () => {
  const vendor = await verifiedVendor();
  const seeded = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Seeded Potato',
    pricePaise: 3000,
    stock: 50,
  });

  const res = await api()
    .patch(`/api/products/${seeded._id}`)
    .set(auth(vendor.accessToken))
    .send({ price: 1 });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_YOUR_PRODUCT');
});

test('a market owner can still administer any listing', async () => {
  const vendor = await verifiedVendor();
  const product = await listProduct(vendor, 'Vendor Brinjal');
  const owner = await authenticatedUser('market_owner');

  const res = await api()
    .patch(`/api/products/${product.id}`)
    .set(auth(owner.accessToken))
    .send({ price: 50 });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.pricePaise, 5000);
});

test('createdBy cannot be supplied by the caller', async () => {
  const alice = await verifiedVendor();
  const mallory = await verifiedVendor();

  const res = await api()
    .post('/api/products')
    .set(auth(mallory.accessToken))
    .send({
      sku: `SKU-${uniq()}`,
      categoryId: 1,
      name: 'Planted',
      price: 40,
      stock: 10,
      createdBy: alice.user._id.toHexString(),
    });

  assert.equal(res.status, 400, 'strict schemas reject an unknown key outright');
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});
