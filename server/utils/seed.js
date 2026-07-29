'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');
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
 * Accounts created for local development. Contact details are non-routable
 * example.com addresses and reserved-range phone numbers — never real people.
 */
const SEED_ACCOUNTS = [
  { key: 'CUSTOMER', name: 'Demo Customer', email: 'customer@example.com', phone: '9000000001', role: 'customer' },
  { key: 'SHOPKEEPER', name: 'Demo Shopkeeper', email: 'shopkeeper@example.com', phone: '9000000002', role: 'shopkeeper' },
  { key: 'DELIVERY', name: 'Demo Delivery Agent', email: 'delivery@example.com', phone: '9000000003', role: 'delivery' },
  { key: 'MARKET_OWNER', name: 'Demo Market Owner', email: 'owner@example.com', phone: '9000000004', role: 'market_owner' },
  { key: 'DEVELOPER', name: 'Demo Developer', email: 'developer@example.com', phone: '9000000005', role: 'developer' },
];

/** Random, meets the strength policy, and never written to disk. */
function generatePassword() {
  return `${crypto.randomBytes(12).toString('base64url')}aA1!`;
}

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

  const productCount = await seedProducts();
  if (productCount > 0) console.info(`[seed] inserted ${productCount} demo products.`);

  const accounts = await seedAccounts();
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

module.exports = { seedIfEmpty, SEED_ACCOUNTS };
