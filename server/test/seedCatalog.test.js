'use strict';

/**
 * The shared platform catalog's self-syncing boot steps.
 *
 * `seedProducts()` and `retireProducts()` both run unconditionally on every
 * boot, production included (see seedIfEmpty() in utils/seed.js) — unlike
 * everything else in that file, which is demo data and stays gated behind
 * `config.isProduction`. That makes retireProducts()'s owner/createdBy guard
 * load-bearing rather than a nicety: it is the only thing standing between a
 * routine deploy and deleting a real vendor's listing that happens to reuse a
 * retired sku.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase } = require('./helpers');

const Product = require('../models/Product');
const User = require('../models/User');
const { seedProducts, retireProducts, SEED_PRODUCTS, RETIRED_PRODUCT_SKUS } = require('../utils/seed');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('seedProducts only ever inserts a sku that is missing', async () => {
  const first = await seedProducts();
  assert.equal(first, SEED_PRODUCTS.length);

  const second = await seedProducts();
  assert.equal(second, 0);

  const count = await Product.countDocuments({});
  assert.equal(count, SEED_PRODUCTS.length);
});

test('retireProducts removes an owner-less row whose sku is on the retired list', async () => {
  assert.ok(RETIRED_PRODUCT_SKUS.length > 0, 'this test needs at least one retired sku to exercise');
  const [sku] = RETIRED_PRODUCT_SKUS;

  await Product.create({
    sku,
    categoryId: 2,
    name: 'Retired Test Product',
    pricePaise: 1000,
    stock: 5,
  });

  const removed = await retireProducts();
  assert.equal(removed, 1);

  const stillThere = await Product.findOne({ sku });
  assert.equal(stillThere, null);
});

test('retireProducts never touches a real vendor listing that reuses a retired sku', async () => {
  const [sku] = RETIRED_PRODUCT_SKUS;
  const vendor = await User.create({
    name: 'Test Shopkeeper',
    email: 'retire-guard@example.com',
    phone: '9111111111',
    role: 'shopkeeper',
  });

  await Product.create({
    sku,
    owner: vendor._id,
    createdBy: vendor._id,
    categoryId: 2,
    name: "A Vendor's Own Listing",
    pricePaise: 1000,
    stock: 5,
  });

  const removed = await retireProducts();
  assert.equal(removed, 0);

  const stillThere = await Product.findOne({ sku });
  assert.ok(stillThere, 'a real vendor listing was deleted');
  assert.equal(String(stillThere.owner), String(vendor._id));
});

test('retireProducts is a no-op the second time it runs', async () => {
  const [sku] = RETIRED_PRODUCT_SKUS;
  await Product.create({ sku, categoryId: 2, name: 'Retired Test Product', pricePaise: 1000, stock: 5 });

  await retireProducts();
  const second = await retireProducts();
  assert.equal(second, 0);
});
