'use strict';

const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const { PRODUCT_NAME_TRANSLATIONS, translationsForSku } = require('./productTranslations');

/**
 * Development seeding, and the shared product catalog.
 *
 * The previous seeder hardcoded eight accounts with real personal passwords in
 * source. There are no passwords at all now — signing in as one of these
 * accounts means requesting a code for its phone number, which the console
 * transport prints to stdout in development.
 *
 * Demo accounts, markets and stalls refuse to run in production. The product
 * catalog does not: SEED_PRODUCTS is the shared platform catalog, not demo
 * data, and `seedProducts()` only ever inserts a sku that is missing — see
 * its own comment below.
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

  /**
   * The one item `marketVegetables` in mockData.js still had no matching row
   * for — everything else in that list was covered when the batch above was
   * added. Same treatment: real product, categoryId 2, the exact photo id
   * already vetted for it in mockData.js.
   */
  { sku: 'VEG-CORIANDER-100', categoryId: 2, name: 'Fresh Coriander (Dhaniya)', weight: '1 bunch (approx 100g)', pricePaise: 1500, oldPricePaise: 2000, rating: 4.4, reviews: 45, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1723810330043-dd05647294cb?w=300' },

  /**
   * A second round beyond `marketVegetables` itself: these widen the aisle
   * rather than fill a gap in it, so mockData.js's `marketVegetables` and
   * `marketLeafyGreens` were extended to match, keeping the tile a customer
   * taps and the product it lands on defined in one place each.
   *
   * Every photo below was found by searching Unsplash and picked only when
   * its own AI-generated alt text explicitly named the item — the same bar
   * the rest of this list was held to, and for the same reason: a wrong
   * "close-up of green leaves" guess is worse than leaving the item out.
   * Several common Indian vegetables (drumstick, cluster beans, ivy gourd,
   * green garlic, fenugreek, curry leaves, mint, kale, artichoke) were tried
   * and dropped for exactly that reason — nothing on Unsplash confirmed them.
   */
  { sku: 'VEG-PUMPKIN-1000', categoryId: 2, name: 'Pumpkin (Kaddu)', weight: '1 pc (approx 1kg)', pricePaise: 3500, oldPricePaise: 4200, rating: 4.3, reviews: 58, isOrganic: false, stock: 12, image: 'https://images.unsplash.com/photo-1570586437263-ab629fccc818?w=300' },
  { sku: 'VEG-RADISH-500', categoryId: 2, name: 'Fresh Radish (Mooli)', weight: '500g', pricePaise: 2500, oldPricePaise: 3200, rating: 4.2, reviews: 40, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1576072115035-5fe30e447e60?w=300' },
  { sku: 'VEG-MUSHROOM-200', categoryId: 2, name: 'Button Mushroom', weight: '200g', pricePaise: 4500, oldPricePaise: 5500, rating: 4.6, reviews: 88, isOrganic: false, stock: 15, image: 'https://images.unsplash.com/photo-1552825898-07e419204683?w=300' },
  { sku: 'VEG-ZUCCHINI-500', categoryId: 2, name: 'Zucchini', weight: '500g', pricePaise: 4000, oldPricePaise: 5000, rating: 4.3, reviews: 34, isOrganic: false, stock: 14, image: 'https://images.unsplash.com/photo-1753445657076-5c3c710c42c4?w=300' },
  { sku: 'VEG-LEEK-250', categoryId: 2, name: 'Leek', weight: '250g', pricePaise: 3500, oldPricePaise: 4200, rating: 4.1, reviews: 22, isOrganic: false, stock: 12, image: 'https://images.unsplash.com/photo-1760108273146-c1ad5f5bce30?w=300' },
  { sku: 'VEG-CELERY-250', categoryId: 2, name: 'Celery', weight: '1 bunch (approx 250g)', pricePaise: 3500, oldPricePaise: 4200, rating: 4.0, reviews: 19, isOrganic: false, stock: 10, image: 'https://images.unsplash.com/photo-1742805286467-305b3529c00a?w=300' },
  { sku: 'VEG-RAWBANANA-500', categoryId: 2, name: 'Raw Banana (Kacha Kela)', weight: '3 pcs (approx 500g)', pricePaise: 2500, oldPricePaise: 3200, rating: 4.3, reviews: 42, isOrganic: false, stock: 20, image: 'https://images.unsplash.com/photo-1528279335935-f486951a6adf?w=300' },
  { sku: 'VEG-FENNEL-250', categoryId: 2, name: 'Fennel Bulb (Saunf)', weight: '250g', pricePaise: 4500, oldPricePaise: 5500, rating: 4.1, reviews: 24, isOrganic: false, stock: 10, image: 'https://images.unsplash.com/photo-1760393339688-cbb315e481f4?w=300' },
  { sku: 'VEG-ASPARAGUS-250', categoryId: 2, name: 'Asparagus', weight: '250g', pricePaise: 8000, oldPricePaise: 9500, rating: 4.5, reviews: 30, isOrganic: false, stock: 8, image: 'https://images.unsplash.com/photo-1756364125457-ae0be9c397c1?w=300' },

  /**
   * Leafy, so categoryId 1 like spinach and broccoli above, not 2.
   */
  { sku: 'VEG-LETTUCE-300', categoryId: 1, name: 'Iceberg Lettuce', weight: '1 pc (approx 300g)', pricePaise: 3500, oldPricePaise: 4200, rating: 4.4, reviews: 46, isOrganic: false, stock: 12, image: 'https://images.unsplash.com/photo-1693667660375-653320dbebb4?w=300' },
  { sku: 'VEG-MUSTARDGREENS-500', categoryId: 1, name: 'Mustard Greens (Sarson Saag)', weight: '1 bunch (approx 500g)', pricePaise: 3000, oldPricePaise: 3800, rating: 4.3, reviews: 38, isOrganic: false, stock: 15, image: 'https://images.unsplash.com/photo-1772701488768-4ddd628abc84?w=300' },
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
  const missing = SEED_PRODUCTS.filter((p) => !existingSkus.has(p.sku))
    // Translations are attached here rather than written out beside every row
    // above, so the same table also drives backfillProductTranslations() and the
    // two can never disagree about what a sku is called in Telugu.
    .map((p) => ({ ...p, ...translationsForSku(p.sku) }));
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

/**
 * Fill in Telugu and Hindi names on rows a previous boot already inserted.
 *
 * Without this the feature would ship to nobody. `seedProducts()` adds only
 * *missing* skus, so on every database that has ever run this app — production
 * included — all 37 catalog rows already exist and would keep `nameTe: ''`
 * for good, leaving a Telugu shopper reading English product names while the
 * rest of the app translated correctly.
 *
 * Each language is its own update, filtered on that one field being empty, so a
 * name someone has corrected by hand is never reverted to the table's version.
 * Matching the row on "either field is empty" and then `$set`-ing both would
 * quietly overwrite an edited Telugu name whenever Hindi happened to be blank —
 * which is exactly what the test for this caught.
 *
 * A second boot therefore has nothing left to do, and reports 0.
 */
async function backfillProductTranslations() {
  const ops = [];
  for (const [sku, { te, hi }] of Object.entries(PRODUCT_NAME_TRANSLATIONS)) {
    if (te) {
      ops.push({
        updateOne: { filter: { sku, nameTe: { $in: ['', null] } }, update: { $set: { nameTe: te } } },
      });
    }
    if (hi) {
      ops.push({
        updateOne: { filter: { sku, nameHi: { $in: ['', null] } }, update: { $set: { nameHi: hi } } },
      });
    }
  }
  if (ops.length === 0) return 0;

  const result = await Product.bulkWrite(ops, { ordered: false });
  return result.modifiedCount || 0;
}

/**
 * Skus that used to be in SEED_PRODUCTS and no longer are.
 *
 * `seedProducts()` only ever adds a missing sku — nothing un-seeds one when
 * it disappears from the list above, so an already-seeded database
 * (production included) needs this to actually catch up. Scoped to
 * `owner: null` AND `createdBy: null`, the same guard scripts/remove-demo-seed.js
 * uses: only a row this seeder could plausibly have created is ever touched,
 * never a real shopkeeper's or market owner's listing that happens to reuse
 * a retired sku.
 *
 * Safe to clear once a deploy has run against every environment that matters
 * — it exists to catch up already-seeded databases, not as a permanent record.
 */
const RETIRED_PRODUCT_SKUS = ['VEG-SWEETCORN-400'];

async function retireProducts() {
  if (RETIRED_PRODUCT_SKUS.length === 0) return 0;
  const result = await Product.deleteMany({
    sku: { $in: RETIRED_PRODUCT_SKUS },
    owner: null,
    createdBy: null,
  });
  return result.deletedCount;
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
  /**
   * The shared platform catalog runs in every environment, production
   * included. `seedProducts()` only ever inserts a sku that is missing — see
   * the comment on it above — so this is how a product added to
   * SEED_PRODUCTS after production was first seeded still reaches it, on the
   * next ordinary boot, without a one-off script or direct database access.
   */
  const productCount = await seedProducts();
  if (productCount > 0) console.info(`[seed] inserted ${productCount} product(s) into the catalog.`);

  const retiredCount = await retireProducts();
  if (retiredCount > 0) console.info(`[seed] removed ${retiredCount} retired product(s) from the catalog.`);

  // Runs in production too, and for the same reason the catalog seed does: the
  // rows are already there, so this is the only path by which they ever get a
  // Telugu or Hindi name.
  const translatedCount = await backfillProductTranslations();
  if (translatedCount > 0) console.info(`[seed] backfilled translations for ${translatedCount} product(s).`);

  /**
   * Deliberately asks TWO questions, because NODE_ENV answers the wrong one.
   *
   * `isProduction` is a claim the host makes about itself, and this project's
   * own Railway deployment was serving real traffic with NODE_ENV unset — so
   * this guard was inert and every demo account, market and stall below was
   * created in the live database. `isDeployed` is a fact the platform injects
   * and cannot be forgotten; see the note on DEPLOY_MARKERS in config/env.js.
   *
   * Nothing under here may ever run on a real host: these rows are fictional,
   * their phone numbers are published in this file, and one of them is a
   * `developer` account that bypasses every role check in the system.
   */
  if (config.isProduction || config.isDeployed) {
    const why = config.isProduction ? 'disabled in production' : `disabled on a deployed host (${config.deployedMarker} is set)`;
    console.info(`[seed] demo accounts, markets and stalls skipped: ${why}.`);
    return;
  }

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
 * Fabricated traffic — orders, a wallet ledger, KYC, rider bank details — so the
 * Developer Console has something to chart on a fresh database.
 *
 * NOT called by `seedIfEmpty`, deliberately, and that is the whole point of it
 * living behind its own export. Three reasons, each of which has already caused
 * a real problem:
 *
 * - `seedIfEmpty` runs on every boot including real ones, guarded only by
 *   "am I production/deployed". These rows are not demo *fixtures* like a market
 *   or a stall, they are money: an append-only wallet ledger, paid orders, and a
 *   VendorKyc marked `verified` that `middleware/vendorVerified.js` reads as
 *   proof of a penny drop that never happened.
 * - Its guards are global counts (`Order.countDocuments() === 0`), which is true
 *   of every real deployment on day one — so "only seeds an empty database" is
 *   exactly the condition a launching production database satisfies.
 * - `scripts/remove-demo-seed.js` identifies demo rows from the same constants
 *   that created them. These were never added to that list, so it read nine
 *   seeded orders as REAL orders entangled with demo stalls and refused to
 *   clean up — which is what `test/removeDemoSeed.test.js` caught.
 *
 * It is called from `scripts/dev-with-memory-db.js`, whose database is thrown
 * away on exit, and nowhere else. Keep it that way.
 */
async function seedDemoOrdersAndData() {
  const Order = require('../models/Order');
  const WalletTransaction = require('../models/WalletTransaction');
  const VendorKyc = require('../models/VendorKyc');
  const RiderBankDetails = require('../models/RiderBankDetails');

  // 1. Seed demo orders if none exist
  const orderCount = await Order.countDocuments();
  if (orderCount === 0) {
    const customer = await User.findOne({ role: 'customer' }).lean();
    const rider = await User.findOne({ role: 'delivery' }).lean();
    const market = await Market.findOne().lean();
    const products = await Product.find({ isActive: true }).limit(8).lean();

    if (customer && products.length > 0) {
      const now = Date.now();
      const demoOrderConfigs = [
        { daysAgo: 6, status: 'Delivered', totalPaise: 42000, itemsCount: 3, payment: 'razorpay', payStatus: 'paid' },
        { daysAgo: 5, status: 'Delivered', totalPaise: 65000, itemsCount: 4, payment: 'wallet', payStatus: 'paid' },
        { daysAgo: 4, status: 'Delivered', totalPaise: 38000, itemsCount: 2, payment: 'wallet', payStatus: 'paid' },
        { daysAgo: 3, status: 'Delivered', totalPaise: 92000, itemsCount: 5, payment: 'razorpay', payStatus: 'paid' },
        { daysAgo: 2, status: 'Delivered', totalPaise: 54000, itemsCount: 3, payment: 'wallet', payStatus: 'paid' },
        { daysAgo: 1, status: 'Delivered', totalPaise: 78000, itemsCount: 4, payment: 'razorpay', payStatus: 'paid' },
        { daysAgo: 0, status: 'Out for Delivery', totalPaise: 45000, itemsCount: 2, payment: 'wallet', payStatus: 'paid' },
        { daysAgo: 0, status: 'Preparing', totalPaise: 82000, itemsCount: 4, payment: 'wallet', payStatus: 'paid' },
        { daysAgo: 0, status: 'Pending', totalPaise: 31000, itemsCount: 2, payment: 'cod', payStatus: 'pending' },
      ];

      const ordersToInsert = demoOrderConfigs.map((cfg, idx) => {
        const orderTime = new Date(now - cfg.daysAgo * 24 * 60 * 60 * 1000 - (idx * 3600000));
        const selectedProducts = products.slice(0, cfg.itemsCount);
        const items = selectedProducts.map((p) => ({
          product: p._id,
          name: p.name,
          unitPricePaise: p.pricePaise,
          quantity: 1,
          lineTotalPaise: p.pricePaise,
        }));
        const subtotal = items.reduce((s, i) => s + i.lineTotalPaise, 0);

        return {
          orderNumber: `ORD-${orderTime.getFullYear()}${(orderTime.getMonth() + 1).toString().padStart(2, '0')}${orderTime.getDate().toString().padStart(2, '0')}-${1000 + idx}`,
          customer: customer._id,
          customerName: customer.name || 'Demo Customer',
          phone: customer.phone || '9000000001',
          address: 'Flat 402, Green Meadows, Mehdipatnam, Hyderabad',
          items,
          subtotalPaise: subtotal,
          deliveryFeePaise: 0,
          totalAmountPaise: cfg.totalPaise || subtotal,
          paymentMethod: cfg.payment,
          paymentStatus: cfg.payStatus,
          status: cfg.status,
          market: market?._id || null,
          assignedTo: cfg.status !== 'Placed' ? rider?._id : null,
          createdAt: orderTime,
          updatedAt: orderTime,
        };
      });

      await Order.insertMany(ordersToInsert);
      console.info(`[seed] created ${ordersToInsert.length} demo orders across the past 7 days.`);
    }
  }

  // 2. Seed demo wallet transactions
  const walletCount = await WalletTransaction.countDocuments();
  if (walletCount === 0) {
    const customer = await User.findOne({ role: 'customer' }).lean();
    if (customer) {
      const now = Date.now();
      const transactions = [
        { user: customer._id, type: 'credit', amountPaise: 200000, balanceAfterPaise: 200000, seq: 1, reason: 'razorpay_topup', idempotencyKey: `SEED-TOPUP-1-${customer._id}`, note: 'Top-up via UPI / Card', createdAt: new Date(now - 6 * 24 * 3600000) },
        { user: customer._id, type: 'debit', amountPaise: 42000, balanceAfterPaise: 158000, seq: 2, reason: 'order_payment', idempotencyKey: `SEED-PAY-2-${customer._id}`, note: 'Order payment', createdAt: new Date(now - 5 * 24 * 3600000) },
        { user: customer._id, type: 'debit', amountPaise: 38000, balanceAfterPaise: 120000, seq: 3, reason: 'order_payment', idempotencyKey: `SEED-PAY-3-${customer._id}`, note: 'Order payment', createdAt: new Date(now - 4 * 24 * 3600000) },
        { user: customer._id, type: 'credit', amountPaise: 100000, balanceAfterPaise: 220000, seq: 4, reason: 'razorpay_topup', idempotencyKey: `SEED-TOPUP-4-${customer._id}`, note: 'Top-up via NetBanking', createdAt: new Date(now - 2 * 24 * 3600000) },
        { user: customer._id, type: 'debit', amountPaise: 54000, balanceAfterPaise: 166000, seq: 5, reason: 'order_payment', idempotencyKey: `SEED-PAY-5-${customer._id}`, note: 'Order payment', createdAt: new Date(now - 1 * 24 * 3600000) },
      ];
      await WalletTransaction.insertMany(transactions);
      console.info(`[seed] created ${transactions.length} demo wallet ledger transactions.`);
    }
  }

  // 3. Seed demo KYC and Rider bank details
  const kycCount = await VendorKyc.countDocuments();
  if (kycCount === 0) {
    const shopkeepers = await User.find({ role: 'shopkeeper' }).limit(3).lean();
    if (shopkeepers.length > 0) {
      const kycDocs = shopkeepers.map((s, idx) => ({
        user: s._id,
        legalName: s.name || 'Vendor Enterprise',
        bankName: idx === 0 ? 'State Bank of India' : idx === 1 ? 'HDFC Bank' : 'ICICI Bank',
        ifsc: idx === 0 ? 'SBIN0001234' : idx === 1 ? 'HDFC0005678' : 'ICIC0009012',
        upiVpa: `${s.phone || '9000000002'}@oksbi`,
        ...VendorKyc.buildSecrets({ bankAccount: '987654321098' }),
        status: idx === 0 ? 'verified' : 'draft',
        verifiedAt: idx === 0 ? new Date() : null,
      }));
      await VendorKyc.insertMany(kycDocs);
      console.info(`[seed] created ${kycDocs.length} demo vendor KYC records.`);
    }
  }

  const riderBankCount = await RiderBankDetails.countDocuments();
  if (riderBankCount === 0) {
    const rider = await User.findOne({ role: 'delivery' }).lean();
    if (rider) {
      await RiderBankDetails.create({
        user: rider._id,
        legalName: rider.name || 'Demo Rider',
        bankName: 'Axis Bank',
        ifsc: 'UTIB0001234',
        ...RiderBankDetails.buildSecrets({ bankAccount: '112233445566' }),
      });
      console.info('[seed] created demo rider bank details.');
    }
  }
}

/**
 * The specs are exported, not just the accounts, so scripts/remove-demo-seed.js
 * identifies what to delete from the same constants that created it. A removal
 * list maintained separately would silently stop matching the moment either
 * side gained a row.
 *
 * `seedProducts` is exported on its own, separately from `seedIfEmpty`, because
 * it is already per-sku idempotent against a non-empty collection (see the
 * comment on it above) — `seedIfEmpty`'s production guard exists to stop the
 * *other* seed steps (demo accounts, markets) from ever running there, not to
 * stop a newly added catalog item from reaching a database that was seeded
 * before that item existed.
 */
module.exports = {
  seedIfEmpty,
  seedDemoOrdersAndData,
  seedProducts,
  backfillProductTranslations,
  retireProducts,
  SEED_ACCOUNTS,
  SEED_PRODUCTS,
  SEED_MARKETS,
  SEED_STALLS,
  RETIRED_PRODUCT_SKUS,
};
