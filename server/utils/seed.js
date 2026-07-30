'use strict';

const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');

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

async function seedIfEmpty() {
  if (config.isProduction) {
    console.info('[seed] skipped: seeding is disabled in production.');
    return;
  }

  const productCount = await seedProducts();
  if (productCount > 0) console.info(`[seed] inserted ${productCount} demo products.`);

  const accounts = await seedAccounts();
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

module.exports = { seedIfEmpty, SEED_ACCOUNTS };
