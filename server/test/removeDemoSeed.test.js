'use strict';

/**
 * scripts/remove-demo-seed.js deletes rows from whatever database it is pointed
 * at, and the reason it exists is that a production database was seeded with
 * demo accounts — including a passwordless one holding the `developer` role.
 *
 * So the two things worth proving are that it finds everything the seeder made,
 * and that it refuses to touch anything real. The second matters more: a script
 * that under-deletes leaves work to do, while one that over-deletes destroys
 * order history.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { startTestServer, stopTestServer, resetDatabase } = require('./helpers');

const User = require('../models/User');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const Order = require('../models/Order');

const { seedIfEmpty, SEED_ACCOUNTS, SEED_PRODUCTS, SEED_MARKETS } = require('../utils/seed');
const {
  plan,
  findEntanglements,
  entanglementTotal,
  remove,
} = require('../scripts/remove-demo-seed');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('it finds every account, product, market and stall the seeder created', async () => {
  await seedIfEmpty();

  const found = await plan();

  assert.equal(found.users.length, SEED_ACCOUNTS.length);
  assert.equal(found.products.length, SEED_PRODUCTS.length);
  assert.equal(found.markets.length, SEED_MARKETS.length);
  // Three stalls, all in the first market.
  assert.equal(found.stalls.length, 3);

  // The one that actually matters — the passwordless privileged account.
  const developer = found.users.find((u) => u.role === 'developer');
  assert.ok(developer, 'the developer account must be in the removal plan');
  assert.equal(developer.phone, '9000000005');
});

test('a real account sharing a seeded phone number is left alone', async () => {
  await seedIfEmpty();

  // Same reserved phone, a real person's email. Matching on phone alone would
  // delete this account; matching on the pair must not.
  await User.deleteOne({ phone: '9000000001' });
  await User.create({
    name: 'Actual Person',
    email: 'someone@realdomain.example',
    phone: '9000000001',
    role: 'customer',
  });

  const found = await plan();

  assert.equal(found.users.length, SEED_ACCOUNTS.length - 1);
  assert.ok(
    !found.users.some((u) => u.phone === '9000000001'),
    'an account with a real email must not be selected for deletion'
  );
});

test("a real vendor's product is not deleted for reusing a seeded sku", async () => {
  await seedIfEmpty();

  const vendor = await User.create({
    name: 'Real Vendor',
    email: 'vendor@realdomain.example',
    phone: '9111111111',
    role: 'shopkeeper',
  });

  // The seeded row for this sku, re-pointed at a real owner — the shape a
  // vendor-owned listing takes. Owner is what distinguishes it, not the sku.
  await Product.updateOne({ sku: 'VEG-SPINACH-250' }, { $set: { owner: vendor._id } });

  const found = await plan();

  assert.equal(found.products.length, SEED_PRODUCTS.length - 1);
  assert.ok(!found.products.some((p) => p.sku === 'VEG-SPINACH-250'));
});

test('nothing is entangled in a database that has only been seeded', async () => {
  await seedIfEmpty();

  const tangles = await findEntanglements(await plan());

  assert.equal(entanglementTotal(tangles), 0);
});

/** A minimal valid order. `overrides` reach the top level, `item` the line. */
async function makeOrder({ customer, product, item = {}, ...overrides }) {
  return Order.create({
    orderNumber: `VD${new mongoose.Types.ObjectId().toString().slice(-10).toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Test Lane',
    items: [
      {
        product: product._id,
        name: product.name,
        unitPricePaise: product.pricePaise,
        quantity: 1,
        lineTotalPaise: product.pricePaise,
        lineId: new mongoose.Types.ObjectId(),
        ...item,
      },
    ],
    subtotalPaise: product.pricePaise,
    totalAmountPaise: product.pricePaise,
    paymentMethod: 'cod',
    ...overrides,
  });
}

test('an order against a demo account counts as entanglement', async () => {
  await seedIfEmpty();

  const customer = await User.findOne({ phone: '9000000001' }).lean();
  const product = await Product.findOne({ sku: 'VEG-TOMATO-1000' }).lean();

  await makeOrder({ customer, product });

  const tangles = await findEntanglements(await plan());

  assert.equal(tangles.orders, 1);
  assert.ok(entanglementTotal(tangles) > 0, 'the script must refuse to run on this');
});

/**
 * The stall reference on an order is `items[].claim.stall`, not a top-level
 * `stall`. Mongo matches an unknown path silently, so getting this wrong does
 * not throw — it returns 0 and the script cheerfully reports the deletion as
 * safe over an order the demo stall had actually committed to. This test exists
 * because the first version of the script queried the wrong path.
 */
test('an order line CLAIMED by a demo stall counts as entanglement', async () => {
  await seedIfEmpty();

  const customer = await User.create({
    name: 'Real Customer',
    email: 'buyer@realdomain.example',
    phone: '9444444444',
    role: 'customer',
  });
  const product = await Product.findOne({ sku: 'VEG-ONION-1000' }).lean();
  const stall = await Stall.findOne({ stallNumber: 'A-1' }).lean();

  await makeOrder({
    customer,
    product,
    item: { claim: { stall: stall._id, stallNumber: 'A-1', claimedAt: new Date() } },
  });

  const tangles = await findEntanglements(await plan());

  assert.equal(tangles.orders, 1, 'a claim by a demo stall must be seen');
});

/** Same silent-mismatch risk on the offer path. */
test('an order line OFFERED to a demo stall counts as entanglement', async () => {
  await seedIfEmpty();

  const customer = await User.create({
    name: 'Real Customer',
    email: 'buyer2@realdomain.example',
    phone: '9555555555',
    role: 'customer',
  });
  const product = await Product.findOne({ sku: 'VEG-BROCCOLI-500' }).lean();
  const stall = await Stall.findOne({ stallNumber: 'A-2' }).lean();

  await makeOrder({
    customer,
    product,
    item: { offer: { stall: stall._id, offeredAt: new Date() } },
  });

  const tangles = await findEntanglements(await plan());

  assert.equal(tangles.orders, 1, 'an offer to a demo stall must be seen');
});

test('a real stall approved into a demo market counts as entanglement', async () => {
  await seedIfEmpty();

  const market = await Market.findOne({ slug: 'mehdipatnam-rythu-bazaar' }).lean();
  const realVendor = await User.create({
    name: 'Real Trader',
    email: 'trader@realdomain.example',
    phone: '9222222222',
    role: 'shopkeeper',
  });
  await Stall.create({
    market: market._id,
    stallNumber: 'C-9',
    name: 'Real Trader',
    owner: realVendor._id,
    status: 'approved',
  });

  const tangles = await findEntanglements(await plan());

  assert.equal(tangles.otherStalls, 1);
});

test('removing takes the demo rows and their children, and is idempotent', async () => {
  await seedIfEmpty();

  const before = await plan();
  assert.ok(before.users.length > 0);

  await remove(before);

  // Everything the plan named is gone.
  assert.equal(await User.countDocuments({ _id: { $in: before.userIds } }), 0);
  assert.equal(await Product.countDocuments({ _id: { $in: before.productIds } }), 0);
  assert.equal(await Market.countDocuments({ _id: { $in: before.marketIds } }), 0);
  assert.equal(await Stall.countDocuments({ _id: { $in: before.stallIds } }), 0);

  // And so are the rows that only existed to point at them. Left behind, these
  // are the actual harm: price sheets for a market that no longer exists, and
  // declared stock for a stall nobody owns.
  assert.equal(await MarketPrice.countDocuments({ market: { $in: before.marketIds } }), 0);
  assert.equal(await StallInventory.countDocuments({ stall: { $in: before.stallIds } }), 0);

  // A second pass finds nothing and does nothing.
  const after = await plan();
  assert.equal(after.users.length, 0);
  assert.equal(after.products.length, 0);
  assert.equal(after.markets.length, 0);
  assert.equal(after.stalls.length, 0);
});

test('removing demo data leaves a real account untouched', async () => {
  await seedIfEmpty();

  const real = await User.create({
    name: 'Real Customer',
    email: 'real@realdomain.example',
    phone: '9333333333',
    role: 'customer',
  });

  await remove(await plan());

  assert.ok(await User.findById(real._id), 'a real account must survive the removal');
});
