'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const passwords = require('../services/password');

/**
 * Development seeding.
 *
 * The previous seeder hardcoded eight accounts with real personal passwords in
 * source. This one refuses to run in production, takes credentials from the
 * environment, and otherwise generates a random password per account and prints
 * it once so it exists nowhere on disk.
 */

const SEED_PRODUCTS = [
  { sku: 'VEG-SPINACH-250', categoryId: 1, name: 'Organic Spinach (Palak)', weight: '250g', pricePaise: 3500, oldPricePaise: 4500, rating: 4.8, reviews: 128, isOrganic: true, stock: 15, image: 'https://images.unsplash.com/photo-1576045057995-568f588f82fb?w=300' },
  { sku: 'VEG-BROCCOLI-500', categoryId: 1, name: 'Fresh Broccoli Crown', weight: '500g', pricePaise: 6500, oldPricePaise: 8000, rating: 4.9, reviews: 94, isOrganic: true, stock: 8, image: 'https://images.unsplash.com/photo-1459411621453-7b03977f4bfc?w=300' },
  { sku: 'VEG-TOMATO-1000', categoryId: 2, name: 'Desi Tomatoes (Tamatar)', weight: '1kg', pricePaise: 4000, oldPricePaise: 5000, rating: 4.7, reviews: 210, isOrganic: false, stock: 25, image: 'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?w=300' },
  { sku: 'VEG-ONION-1000', categoryId: 2, name: 'Fresh Red Onions (Pyaaz)', weight: '1kg', pricePaise: 4500, oldPricePaise: 5500, rating: 4.6, reviews: 180, isOrganic: false, stock: 30, image: 'https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?w=300' },
  { sku: 'FRT-AVOCADO-350', categoryId: 3, name: 'Fresh Hass Avocado', weight: '2 pcs (approx 350g)', pricePaise: 18000, oldPricePaise: 22000, rating: 4.9, reviews: 76, isOrganic: true, stock: 5, image: 'https://images.unsplash.com/photo-1523049673857-eb18f1d7b578?w=300' },
];

/**
 * Two markets so the "try another market" fallback has somewhere to point, and
 * three stalls in the primary one so a normal basket genuinely spans vendors.
 * Coordinates are real Hyderabad locations; distances between them are a few km,
 * which exercises the geo search meaningfully.
 */
const SEED_MARKETS = [
  {
    key: 'GUDIMALKAPUR',
    slug: 'gudimalkapur-market',
    name: 'Gudimalkapur Vegetable Market',
    address: 'Gudimalkapur, Mehdipatnam',
    city: 'Hyderabad',
    pincode: '500028',
    latitude: 17.3833,
    longitude: 78.4333,
    serviceRadiusM: 8000,
  },
  {
    key: 'BOWENPALLY',
    slug: 'bowenpally-market',
    name: 'Bowenpally Wholesale Market',
    address: 'Bowenpally, Secunderabad',
    city: 'Hyderabad',
    pincode: '500011',
    latitude: 17.4747,
    longitude: 78.4869,
    serviceRadiusM: 8000,
  },
];

/**
 * Stall vendors. Each needs its own shopkeeper account because a stall's owner
 * is what authorizes every catalog write — sharing one login across stalls would
 * reinstate exactly the cross-vendor access this model exists to prevent.
 *
 * `skus` distributes the catalog so no single stall holds a whole basket.
 */
const SEED_STALLS = [
  { marketKey: 'GUDIMALKAPUR', accountKey: 'SHOPKEEPER',   stallNumber: 'A-01', name: 'Ravi Fresh Greens',   skus: ['VEG-SPINACH-250', 'VEG-BROCCOLI-500'], latitude: 17.38340, longitude: 78.43310 },
  { marketKey: 'GUDIMALKAPUR', accountKey: 'SHOPKEEPER_2', stallNumber: 'B-12', name: 'Lakshmi Vegetables',  skus: ['VEG-TOMATO-1000', 'VEG-ONION-1000'],   latitude: 17.38352, longitude: 78.43365 },
  { marketKey: 'GUDIMALKAPUR', accountKey: 'SHOPKEEPER_3', stallNumber: 'C-04', name: 'Sunrise Exotic Fruit', skus: ['FRT-AVOCADO-350'],                    latitude: 17.38310, longitude: 78.43402 },
  // The fallback market stocks everything, so "try another market" can succeed.
  { marketKey: 'BOWENPALLY',   accountKey: 'SHOPKEEPER_4', stallNumber: 'W-07', name: 'Bowenpally Traders',  skus: ['VEG-SPINACH-250', 'VEG-BROCCOLI-500', 'VEG-TOMATO-1000', 'VEG-ONION-1000', 'FRT-AVOCADO-350'], latitude: 17.47480, longitude: 78.48700 },
];

/**
 * Accounts created for local development. Contact details are non-routable
 * example.com addresses and reserved-range phone numbers — never real people.
 */
const SEED_ACCOUNTS = [
  { key: 'CUSTOMER', name: 'Demo Customer', email: 'customer@example.com', phone: '9000000001', role: 'customer' },
  { key: 'SHOPKEEPER', name: 'Ravi (Stall A-01)', email: 'shopkeeper@example.com', phone: '9000000002', role: 'shopkeeper' },
  { key: 'DELIVERY', name: 'Demo Delivery Agent', email: 'delivery@example.com', phone: '9000000003', role: 'delivery' },
  { key: 'MARKET_OWNER', name: 'Demo Market Owner', email: 'owner@example.com', phone: '9000000004', role: 'market_owner' },
  { key: 'DEVELOPER', name: 'Demo Developer', email: 'developer@example.com', phone: '9000000005', role: 'developer' },
  // One account per stall — see SEED_STALLS for why they cannot be shared.
  { key: 'SHOPKEEPER_2', name: 'Lakshmi (Stall B-12)', email: 'stall2@example.com', phone: '9000000006', role: 'shopkeeper' },
  { key: 'SHOPKEEPER_3', name: 'Sunrise (Stall C-04)', email: 'stall3@example.com', phone: '9000000007', role: 'shopkeeper' },
  { key: 'SHOPKEEPER_4', name: 'Bowenpally Traders (W-07)', email: 'stall4@example.com', phone: '9000000008', role: 'shopkeeper' },
];

/** Random, meets the strength policy, and never written to disk. */
function generatePassword() {
  return `${crypto.randomBytes(12).toString('base64url')}aA1!`;
}

/**
 * Markets, stalls, and the catalog spread across them.
 *
 * Products are created per stall rather than globally, because a product with no
 * owning stall cannot be authorized, priced, or picked up — the SKU is shared
 * across stalls, the listing is not.
 */
async function seedMarketsAndCatalog() {
  const existing = await Market.estimatedDocumentCount();
  if (existing > 0) return { markets: 0, stalls: 0, products: 0 };

  const marketsByKey = new Map();
  for (const { key, latitude, longitude, ...rest } of SEED_MARKETS) {
    const market = await Market.create({
      ...rest,
      location: { type: 'Point', coordinates: [longitude, latitude] },
    });
    marketsByKey.set(key, market);
  }

  const productsBySku = new Map(SEED_PRODUCTS.map((p) => [p.sku, p]));

  let stallCount = 0;
  let productCount = 0;

  for (const spec of SEED_STALLS) {
    const market = marketsByKey.get(spec.marketKey);
    const account = SEED_ACCOUNTS.find((a) => a.key === spec.accountKey);
    if (!market || !account) continue;

    const owner = await User.findOne({ phone: account.phone }).select('_id').lean();
    if (!owner) continue;

    const stall = await Stall.create({
      market: market._id,
      owner: owner._id,
      stallNumber: spec.stallNumber,
      name: spec.name,
      phone: account.phone,
      location: { type: 'Point', coordinates: [spec.longitude, spec.latitude] },
    });
    stallCount += 1;

    for (const sku of spec.skus) {
      const template = productsBySku.get(sku);
      if (!template) continue;

      /**
       * Vary price and stock slightly per stall. Identical listings would hide
       * the whole point of a marketplace, and would make it impossible to tell
       * during testing which stall a basket line actually came from.
       */
      const jitter = 1 + ((stallCount % 3) - 1) * 0.05;

      await Product.create({
        ...template,
        pricePaise: Math.round(template.pricePaise * jitter),
        oldPricePaise: template.oldPricePaise ? Math.round(template.oldPricePaise * jitter) : null,
        stock: template.stock,
        stall: stall._id,
        market: market._id,
      });
      productCount += 1;
    }
  }

  return { markets: marketsByKey.size, stalls: stallCount, products: productCount };
}

async function seedAccounts() {
  const created = [];

  for (const account of SEED_ACCOUNTS) {
    const exists = await User.findOne({ phone: account.phone }).select('_id').lean();
    if (exists) continue;

    const envPassword = process.env[`SEED_${account.key}_PASSWORD`];
    const password = envPassword || generatePassword();

    // Env-supplied passwords still have to satisfy the policy.
    if (envPassword) passwords.assertPasswordShape(envPassword);

    await User.create({
      name: account.name,
      email: account.email,
      phone: account.phone,
      passwordHash: await passwords.hash(password),
      role: account.role,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });

    created.push({ ...account, password, generated: !envPassword });
  }

  return created;
}

async function seedIfEmpty() {
  if (config.isProduction) {
    console.info('[seed] skipped: seeding is disabled in production.');
    return;
  }

  // Accounts first: a stall cannot be created without an owner to authorize it.
  const accounts = await seedAccounts();

  const { markets, stalls, products } = await seedMarketsAndCatalog();
  if (markets > 0) {
    console.info(`[seed] inserted ${markets} markets, ${stalls} stalls, ${products} stall listings.`);
  }

  if (accounts.length === 0) return;

  const generated = accounts.filter((a) => a.generated);

  console.info(`\n[seed] created ${accounts.length} development account(s):`);
  for (const account of accounts) {
    console.info(`  ${account.role.padEnd(13)} ${account.email}  /  ${account.phone}`);
  }

  if (generated.length > 0) {
    console.info('\n[seed] Randomly generated passwords (shown once, not stored anywhere):');
    for (const account of generated) {
      console.info(`  ${account.email.padEnd(26)} ${account.password}`);
    }
    console.info(
      '\n[seed] Set SEED_<ROLE>_PASSWORD in .env to choose these yourself.\n' +
      '[seed] Sign-in also requires the emailed/SMS code, printed to this console in development.\n'
    );
  }
}

module.exports = { seedIfEmpty, SEED_ACCOUNTS, SEED_MARKETS, SEED_STALLS, SEED_PRODUCTS };
