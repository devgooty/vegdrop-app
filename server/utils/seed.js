'use strict';

const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');

/**
 * Development seeding.
 *
 * The previous seeder hardcoded eight accounts with real personal passwords in
 * source. There are no passwords at all now — signing in as one of these
 * accounts means requesting a code for its phone number, which the console
 * transport prints to stdout in development.
 *
 * Refuses to run in production.
 */

const SEED_PRODUCTS = [
  { sku: 'VEG-SPINACH-250', categoryId: 1, name: 'Organic Spinach (Palak)', weight: '250g', pricePaise: 3500, oldPricePaise: 4500, rating: 4.8, reviews: 128, isOrganic: true, stock: 15, image: 'https://images.unsplash.com/photo-1576045057995-568f588f82fb?w=300' },
  { sku: 'VEG-BROCCOLI-500', categoryId: 1, name: 'Fresh Broccoli Crown', weight: '500g', pricePaise: 6500, oldPricePaise: 8000, rating: 4.9, reviews: 94, isOrganic: true, stock: 8, image: 'https://images.unsplash.com/photo-1459411621453-7b03977f4bfc?w=300' },
  { sku: 'VEG-TOMATO-1000', categoryId: 2, name: 'Desi Tomatoes (Tamatar)', weight: '1kg', pricePaise: 4000, oldPricePaise: 5000, rating: 4.7, reviews: 210, isOrganic: false, stock: 25, image: 'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?w=300' },
  { sku: 'VEG-ONION-1000', categoryId: 2, name: 'Fresh Red Onions (Pyaaz)', weight: '1kg', pricePaise: 4500, oldPricePaise: 5500, rating: 4.6, reviews: 180, isOrganic: false, stock: 30, image: 'https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?w=300' },
  { sku: 'FRT-AVOCADO-350', categoryId: 3, name: 'Fresh Hass Avocado', weight: '2 pcs (approx 350g)', pricePaise: 18000, oldPricePaise: 22000, rating: 4.9, reviews: 76, isOrganic: true, stock: 5, image: 'https://images.unsplash.com/photo-1523049673857-eb18f1d7b578?w=300' },
];

/**
 * Accounts created for local development. Contact details are non-routable
 * example.com addresses and reserved-range phone numbers — never real people.
 */
const SEED_ACCOUNTS = [
  { name: 'Demo Customer', email: 'customer@example.com', phone: '9000000001', role: 'customer' },
  { name: 'Demo Shopkeeper', email: 'shopkeeper@example.com', phone: '9000000002', role: 'shopkeeper' },
  { name: 'Demo Delivery Agent', email: 'delivery@example.com', phone: '9000000003', role: 'delivery' },
  { name: 'Demo Market Owner', email: 'owner@example.com', phone: '9000000004', role: 'market_owner' },
  { name: 'Demo Developer', email: 'developer@example.com', phone: '9000000005', role: 'developer' },

  /**
   * Two more shopkeepers, so the three stalls below are genuinely separate
   * traders. One stall is not enough to see the interesting behaviour: the
   * accept race, and an order spreading across stalls.
   */
  { name: 'Lakshmi Vegetables', email: 'stall2@example.com', phone: '9000000006', role: 'shopkeeper' },
  { name: 'Ravi Fresh Produce', email: 'stall3@example.com', phone: '9000000007', role: 'shopkeeper' },
];

/**
 * Two markets, roughly 2km apart in Hyderabad.
 *
 * Two rather than one on purpose: a single market cannot demonstrate the hop an
 * order makes when the first market's stalls do not answer, which is the part
 * of the flow most likely to be got wrong.
 */
const SEED_MARKETS = [
  {
    name: 'Mehdipatnam Rythu Bazaar',
    slug: 'mehdipatnam-rythu-bazaar',
    address: 'Ring Road, Mehdipatnam, Hyderabad',
    location: { type: 'Point', coordinates: [78.4383, 17.3947] },
    serviceRadiusMeters: 6000,
  },
  {
    name: 'Erragadda Rythu Bazaar',
    slug: 'erragadda-rythu-bazaar',
    address: 'Erragadda, Hyderabad',
    location: { type: 'Point', coordinates: [78.4408, 17.4557] },
    serviceRadiusMeters: 6000,
  },
];

/**
 * Stalls in the first market. Stall A-1 has auto-accept switched on and
 * declared stock, so an order placed against this market is taken instantly —
 * which is the fastest way to see the whole flow work end to end.
 */
const SEED_STALLS = [
  { stallNumber: 'A-1', name: 'Suresh Vegetables', ownerPhone: '9000000002', autoAccept: true, declareStock: true },
  { stallNumber: 'A-2', name: 'Lakshmi Vegetables', ownerPhone: '9000000006', autoAccept: false, declareStock: true },
  { stallNumber: 'B-5', name: 'Ravi Fresh Produce', ownerPhone: '9000000007', autoAccept: false, declareStock: false },
];

async function seedProducts() {
  const count = await Product.estimatedDocumentCount();
  if (count > 0) return 0;

  await Product.insertMany(SEED_PRODUCTS);
  return SEED_PRODUCTS.length;
}

async function seedAccounts() {
  const created = [];

  for (const account of SEED_ACCOUNTS) {
    const exists = await User.findOne({ phone: account.phone }).select('_id').lean();
    if (exists) continue;

    await User.create({
      name: account.name,
      email: account.email,
      phone: account.phone,
      role: account.role,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });

    created.push(account);
  }

  return created;
}

/**
 * Markets, their price sheets, and the stalls inside the first one.
 *
 * Every market prices every product, because a market that cannot fill an
 * entire order is disqualified as a hop target — a partially priced demo market
 * would make the hop silently never happen and look like a bug.
 */
async function seedMarkets() {
  if ((await Market.estimatedDocumentCount()) > 0) return null;

  /**
   * Both demo markets belong to the demo market owner.
   *
   * Not cosmetic: a market owner's orders, stall list and analytics are all
   * scoped to the markets they own, so an unowned seed market would leave the
   * owner panel correctly but confusingly empty — looking like a broken build
   * rather than the access rule working.
   */
  const owner = await User.findOne({ role: 'market_owner' }).select('_id').lean();

  const markets = await Market.insertMany(
    SEED_MARKETS.map((market) => ({ ...market, owner: owner?._id ?? null }))
  );
  const products = await Product.find({ isActive: true }).select('_id pricePaise').lean();
  if (products.length === 0) return { markets, stalls: [] };

  await MarketPrice.insertMany(
    markets.flatMap((market, marketIndex) =>
      products.map((product) => ({
        market: market._id,
        product: product._id,
        /**
         * The second market is 5% dearer, which is realistic and also exercises
         * the hop price ceiling: it stays under the default "same or cheaper"
         * rule only because that rule compares against the whole subtotal the
         * customer locked, not line by line. Set MARKET_HOP_PRICE_TOLERANCE_BPS
         * above 10000 to let orders travel to it.
         */
        pricePaise: marketIndex === 0 ? product.pricePaise : Math.round(product.pricePaise * 1.05),
      }))
    )
  );

  // Stalls go in the first market only; the second exists to be hopped to.
  const [primary] = markets;
  const owners = await User.find({ phone: { $in: SEED_STALLS.map((s) => s.ownerPhone) } })
    .select('_id phone')
    .lean();
  const byPhone = new Map(owners.map((o) => [o.phone, o._id]));

  const stalls = [];
  for (const spec of SEED_STALLS) {
    const owner = byPhone.get(spec.ownerPhone);
    if (!owner) continue;

    const stall = await Stall.create({
      market: primary._id,
      stallNumber: spec.stallNumber,
      name: spec.name,
      owner,
      autoAccept: spec.autoAccept,
      // Seeded stalls skip the join request: the point of the seed is a market
      // that already trades. Left at the `pending` default they would be held
      // inactive and no demo order could ever be sourced.
      status: 'approved',
    });
    stalls.push(stall);

    // Declared stock is what lets auto-accept fire at all.
    if (spec.declareStock) {
      await StallInventory.insertMany(
        products.map((product) => ({
          stall: stall._id,
          market: primary._id,
          product: product._id,
          stock: 40,
        }))
      );
    }
  }

  return { markets, stalls };
}

async function seedIfEmpty() {
  if (config.isProduction) {
    console.info('[seed] skipped: seeding is disabled in production.');
    return;
  }

  const productCount = await seedProducts();
  if (productCount > 0) console.info(`[seed] inserted ${productCount} demo products.`);

  const accounts = await seedAccounts();

  const marketData = await seedMarkets();
  if (marketData) {
    console.info(
      `[seed] created ${marketData.markets.length} markets and ${marketData.stalls.length} stalls ` +
      `(stall A-1 has auto-accept on).`
    );
  }

  if (accounts.length === 0) return;

  console.info(`\n[seed] created ${accounts.length} development account(s):`);
  for (const account of accounts) {
    console.info(`  ${account.role.padEnd(13)} ${account.phone}  (${account.email})`);
  }
  console.info(
    '\n[seed] Sign in with the phone number above. There is no password — the\n' +
    '[seed] verification code is printed to this console by the dev transport.\n'
  );
}

/**
 * The specs are exported, not just the accounts, so scripts/remove-demo-seed.js
 * identifies what to delete from the same constants that created it. A removal
 * list maintained separately would silently stop matching the moment either
 * side gained a row.
 */
module.exports = { seedIfEmpty, SEED_ACCOUNTS, SEED_PRODUCTS, SEED_MARKETS, SEED_STALLS };
