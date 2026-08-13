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

  /**
   * Every other non-leafy item from the customer app's home-page vegetable
   * aisle (src/data/mockData.js's `marketVegetables`), all under categoryId 2
   * — the same "Fresh Vegetables" bucket tomato and onion above already use —
   * so ProductList's per-category carousel and CategoryDetailView show them
   * as real, addable-to-cart products instead of the dead-end category tiles
   * they used to be. Images reuse the exact photo ids already vetted for
   * those items in mockData.js, so the login marquee and the product card
   * agree on what each vegetable looks like.
   */
  { sku: 'VEG-CHILLI-100', categoryId: 2, name: 'Green Chilli (Hari Mirch)', weight: '100g', pricePaise: 2000, oldPricePaise: 2500, rating: 4.5, reviews: 64, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1704473509931-971356e22feb?w=300' },
  { sku: 'VEG-PEAS-500', categoryId: 2, name: 'Fresh Green Peas (Matar)', weight: '500g', pricePaise: 6000, oldPricePaise: 7500, rating: 4.6, reviews: 88, isOrganic: false, stock: 18, image: 'https://images.unsplash.com/photo-1690023614293-ac2ba2eb0731?w=300' },
  { sku: 'VEG-BRINJAL-500', categoryId: 2, name: 'Purple Brinjal (Baingan)', weight: '500g', pricePaise: 3500, oldPricePaise: 4200, rating: 4.4, reviews: 55, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1683543122945-513029986574?w=300' },
  { sku: 'VEG-CUCUMBER-500', categoryId: 2, name: 'Fresh Cucumber (Kheera)', weight: '500g', pricePaise: 3000, oldPricePaise: 3800, rating: 4.5, reviews: 102, isOrganic: false, stock: 25, image: 'https://images.unsplash.com/photo-1694153192731-ab5445654427?w=300' },
  { sku: 'VEG-BOTTLEGOURD-600', categoryId: 2, name: 'Bottle Gourd (Lauki)', weight: '1 pc (approx 600g)', pricePaise: 3500, oldPricePaise: 4200, rating: 4.3, reviews: 41, isOrganic: false, stock: 15, image: 'https://images.unsplash.com/photo-1776653097091-47334b767dfa?w=300' },
  { sku: 'VEG-CABBAGE-800', categoryId: 2, name: 'Green Cabbage (Patta Gobi)', weight: '1 pc (approx 800g)', pricePaise: 3000, oldPricePaise: 3800, rating: 4.4, reviews: 73, isOrganic: false, stock: 18, image: 'https://images.unsplash.com/photo-1583116935756-f66cd999cdbe?w=300' },
  { sku: 'VEG-CAULIFLOWER-600', categoryId: 2, name: 'Cauliflower (Phool Gobi)', weight: '1 pc (approx 600g)', pricePaise: 3500, oldPricePaise: 4200, rating: 4.5, reviews: 90, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1784043437088-c86a43eb695d?w=300' },
  { sku: 'VEG-CARROT-500', categoryId: 2, name: 'Fresh Carrot (Gajar)', weight: '500g', pricePaise: 4000, oldPricePaise: 5000, rating: 4.7, reviews: 115, isOrganic: false, stock: 22, image: 'https://images.unsplash.com/photo-1633380110125-f6e685676160?w=300' },
  { sku: 'VEG-BEETROOT-500', categoryId: 2, name: 'Fresh Beetroot (Chukandar)', weight: '500g', pricePaise: 3500, oldPricePaise: 4200, rating: 4.4, reviews: 48, isOrganic: false, stock: 16, image: 'https://images.unsplash.com/photo-1639402480805-ea8ef529e028?w=300' },
  { sku: 'VEG-POTATO-1000', categoryId: 2, name: 'Fresh Potato (Aloo)', weight: '1kg', pricePaise: 3000, oldPricePaise: 3800, rating: 4.6, reviews: 240, isOrganic: false, stock: 35, image: 'https://images.unsplash.com/photo-1518977676601-b53f82aba655?w=300' },
  { sku: 'VEG-GINGER-200', categoryId: 2, name: 'Fresh Ginger (Adrak)', weight: '200g', pricePaise: 4000, oldPricePaise: 5000, rating: 4.5, reviews: 67, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1635843104103-ddd88e1c5141?w=300' },
  { sku: 'VEG-GARLIC-200', categoryId: 2, name: 'Fresh Garlic (Lahsun)', weight: '200g', pricePaise: 6000, oldPricePaise: 7200, rating: 4.6, reviews: 82, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1540148426945-6cf22a6b2383?w=300' },
  { sku: 'VEG-RIDGEGOURD-500', categoryId: 2, name: 'Ridge Gourd (Turai)', weight: '500g', pricePaise: 3500, oldPricePaise: 4200, rating: 4.2, reviews: 29, isOrganic: false, stock: 14, image: 'https://images.unsplash.com/photo-1759156632043-eab44e007e67?w=300' },
  { sku: 'VEG-BITTERGOURD-500', categoryId: 2, name: 'Bitter Gourd (Karela)', weight: '500g', pricePaise: 4000, oldPricePaise: 4800, rating: 4.1, reviews: 33, isOrganic: false, stock: 14, image: 'https://images.unsplash.com/photo-1739903760939-743aec69a05f?w=300' },
  { sku: 'VEG-OKRA-500', categoryId: 2, name: 'Fresh Okra (Bhindi)', weight: '500g', pricePaise: 3500, oldPricePaise: 4200, rating: 4.5, reviews: 96, isOrganic: false, stock: 22, image: 'https://images.unsplash.com/photo-1558408525-1092038389ae?w=300' },
  { sku: 'VEG-CAPSICUM-500', categoryId: 2, name: 'Green Capsicum (Shimla Mirch)', weight: '500g', pricePaise: 4500, oldPricePaise: 5500, rating: 4.6, reviews: 78, isOrganic: false, stock: 18, image: 'https://images.unsplash.com/photo-1563565375-f3fdfdbefa83?w=300' },
  { sku: 'VEG-SWEETPOTATO-500', categoryId: 2, name: 'Sweet Potato (Shakarkandi)', weight: '500g', pricePaise: 4000, oldPricePaise: 5000, rating: 4.5, reviews: 52, isOrganic: false, stock: 16, image: 'https://images.unsplash.com/photo-1744659749700-c4213f840355?w=300' },
  { sku: 'VEG-GREENBEANS-500', categoryId: 2, name: 'French Beans (Fansi)', weight: '500g', pricePaise: 4500, oldPricePaise: 5500, rating: 4.4, reviews: 61, isOrganic: false, stock: 18, image: 'https://images.unsplash.com/photo-1567375698348-5d9d5ae99de0?w=300' },
  { sku: 'VEG-SPRINGONION-150', categoryId: 2, name: 'Spring Onion (Hara Pyaaz)', weight: '1 bunch (approx 150g)', pricePaise: 2000, oldPricePaise: 2500, rating: 4.3, reviews: 37, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1559836833-2a2c99b1f54f?w=300' },
  { sku: 'VEG-TURNIP-500', categoryId: 2, name: 'Fresh Turnip (Shalgam)', weight: '500g', pricePaise: 3000, oldPricePaise: 3800, rating: 4.2, reviews: 24, isOrganic: false, stock: 14, image: 'https://images.unsplash.com/photo-1648291913186-951f2ef36c85?w=300' },
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

/**
 * Per-sku, not all-or-nothing: an earlier boot may have already inserted the
 * original five and left it at that, and a plain "collection non-empty, skip"
 * check would mean nothing newly added to SEED_PRODUCTS ever reaches an
 * already-seeded database — which every environment this has ever run in
 * already is. Matches the existence check seedAccounts already does per
 * account, just keyed on sku instead of phone.
 */
async function seedProducts() {
  const existingSkus = new Set((await Product.find({}, 'sku').lean()).map((p) => p.sku));
  const missing = SEED_PRODUCTS.filter((p) => !existingSkus.has(p.sku));
  if (missing.length === 0) return 0;

  try {
    await Product.insertMany(missing, { ordered: false });
  } catch (err) {
    // A second instance booting at the same moment can insert one of these
    // skus between the check above and this insert; the unique index on sku
    // rejects that one row and, with ordered: false, still lands every other
    // row in the batch. Anything other than a duplicate-key conflict is a
    // real failure and should still surface.
    const isDuplicateKeyOnly =
      err.code === 11000 || (Array.isArray(err.writeErrors) && err.writeErrors.every((e) => e.code === 11000));
    if (!isDuplicateKeyOnly) throw err;
  }
  return missing.length;
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
