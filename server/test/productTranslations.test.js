'use strict';

/**
 * Telugu/Hindi product names, and the backfill that is the only way they reach
 * a database that already has the catalog in it.
 *
 * `seedProducts()` inserts only *missing* skus, so on every environment that has
 * ever booted this app — production included — all 37 rows already exist. A test
 * that seeds a fresh database and checks the names would pass while the feature
 * shipped to nobody, which is the same blind spot test/migrations.test.js exists
 * to cover for indexes. So the interesting case here is the one that starts from
 * rows *without* translations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase } = require('./helpers');

const Product = require('../models/Product');
const { seedProducts, backfillProductTranslations } = require('../utils/seed');
const { PRODUCT_NAME_TRANSLATIONS } = require('../utils/productTranslations');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('a freshly seeded row carries its Telugu and Hindi name', async () => {
  await seedProducts();

  const tomato = await Product.findOne({ sku: 'VEG-TOMATO-1000' }).lean();
  assert.equal(tomato.nameTe, 'టమాటా');
  assert.equal(tomato.nameHi, 'टमाटर');
  // English stays the record of truth for staff and order history.
  assert.equal(tomato.name, 'Desi Tomatoes (Tamatar)');
});

test('backfill translates rows an earlier boot inserted untranslated', async () => {
  await seedProducts();
  // Exactly what every existing database looks like: catalog present, the
  // translation fields never written.
  await Product.updateMany({}, { $set: { nameTe: '', nameHi: '' } });

  const changed = await backfillProductTranslations();
  assert.ok(changed > 0, 'backfill should have updated the untranslated rows');

  const okra = await Product.findOne({ sku: 'VEG-OKRA-500' }).lean();
  assert.equal(okra.nameTe, 'బెండకాయ');
  assert.equal(okra.nameHi, 'भिंडी');
});

test('backfill is idempotent, so a second boot does no writes', async () => {
  await seedProducts();
  await Product.updateMany({}, { $set: { nameTe: '', nameHi: '' } });

  await backfillProductTranslations();
  assert.equal(await backfillProductTranslations(), 0);
});

test('backfill never overwrites a name someone has corrected by hand', async () => {
  await seedProducts();
  await Product.updateOne({ sku: 'VEG-TOMATO-1000' }, { $set: { nameTe: 'రోమా టమాటా', nameHi: '' } });

  await backfillProductTranslations();

  const tomato = await Product.findOne({ sku: 'VEG-TOMATO-1000' }).lean();
  // The empty Hindi field is filled; the edited Telugu one is left alone.
  assert.equal(tomato.nameHi, 'टमाटर');
  assert.equal(tomato.nameTe, 'రోమా టమాటా');
});

test('every seeded sku has both translations', async () => {
  await seedProducts();

  const untranslated = await Product.find({
    $or: [{ nameTe: '' }, { nameHi: '' }],
  }, 'sku').lean();

  assert.deepEqual(
    untranslated.map((p) => p.sku),
    [],
    'every seeded product should have a Telugu and Hindi name'
  );
  assert.equal(Object.keys(PRODUCT_NAME_TRANSLATIONS).length, await Product.countDocuments({}));
});
