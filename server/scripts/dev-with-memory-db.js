'use strict';

/**
 * Run the API against a throwaway in-memory MongoDB.
 *
 * For local verification when no MongoDB is installed. Starts a single-node
 * replica set (not a standalone) because checkout and the wallet ledger use
 * multi-document transactions, which standalone mongod cannot run.
 *
 * Data lives only in memory and is discarded on exit — this is a demo harness,
 * never a deployment target.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

// Serves GET /api/auth/dev/login, which signs in as a seeded account with no
// code. Set HERE and not in .env.example or `npm run server`, because this
// harness is a throwaway in-memory demo and the only context where handing out
// sessions by URL is not a vulnerability. config/env.js refuses to boot if this
// ever reaches production; see the note there. Opt out with DEV_LOGIN=0.
process.env.DEV_LOGIN = process.env.DEV_LOGIN || '1';

// Lets a second instance run alongside the default one on a free port, e.g.
// `npm run server:demo -- --port 5001`, for side-by-side local preview.
const portFlagIndex = process.argv.indexOf('--port');
if (portFlagIndex !== -1 && process.argv[portFlagIndex + 1]) {
  process.env.PORT = process.argv[portFlagIndex + 1];
}

const { MongoMemoryReplSet } = require('mongodb-memory-server');

/**
 * Three independent shops stocking different amounts of the same few items.
 *
 * Lives HERE rather than in utils/seed.js on purpose. That seeder also runs at
 * real boots — it only skips when `config.isProduction` — and there is a whole
 * `remove-demo-seed` script and contract built around exactly which documents it
 * creates. This harness is the one place demo-only data belongs.
 *
 * Without it there is nothing to see: the shared seed creates no shop-owned
 * listings at all, so every independent shop stocks nothing and the basket
 * coverage ranking has no data to rank.
 *
 * Coverage is 5, 4 and 3 of the same five items, and the best-stocked shop is
 * deliberately the FURTHEST away — otherwise "ranked by coverage" and "ranked by
 * distance" would produce the same order and the demo would prove nothing.
 */
async function seedDemoShops() {
  const mongoose = require('mongoose');
  const User = require('../models/User');
  const Product = require('../models/Product');
  const VendorKyc = require('../models/VendorKyc');

  // Near the first demo market, so one set of coordinates finds everything.
  const NEAR = { lat: 17.3947, lng: 78.4383 };

  const shops = [
    { name: 'Anand Vegetables', phone: '9000000011', covers: 5, offsetKm: 2.0 },
    { name: 'Ravi Fresh Store', phone: '9000000012', covers: 4, offsetKm: 1.0 },
    { name: 'Sri Balaji Veg', phone: '9000000013', covers: 3, offsetKm: 0.4 },
  ];

  if (await User.exists({ phone: shops[0].phone })) return [];

  // Five real catalog rows, whichever the seed happens to have created.
  const basket = await Product.find({ owner: null, isActive: true })
    .sort({ name: 1 })
    .limit(5)
    .lean();
  if (basket.length < 5) return [];

  const created = [];

  for (const shop of shops) {
    const user = await User.create({
      name: shop.name,
      email: `${shop.phone}@example.com`,
      phone: shop.phone,
      role: 'shopkeeper',
      phoneVerifiedAt: new Date(),
      shop: {
        name: shop.name,
        address: `${shop.name}, Hyderabad`,
        isOpen: true,
        serviceRadiusMeters: 8000,
        // ~0.009 degrees of latitude is roughly 1 km.
        location: { type: 'Point', coordinates: [NEAR.lng, NEAR.lat + shop.offsetKm * 0.009] },
      },
    });

    /**
     * A shop is only listed to customers once its settlement account is proved
     * (routes/shops.js `listingExclusions`), so the demo has to clear KYC or
     * none of these would ever appear. Written straight in rather than driven
     * through the penny drop, which kyc.test.js already covers properly.
     */
    await VendorKyc.create({
      user: user._id,
      legalName: shop.name,
      bankName: 'HDFC Bank',
      ifsc: 'HDFC0001234',
      upiVpa: `${shop.phone}@okhdfcbank`,
      ...VendorKyc.buildSecrets({ bankAccount: '123456789012' }),
      status: 'verified',
      verifiedAt: new Date(),
    });

    await Product.insertMany(
      basket.slice(0, shop.covers).map((item, index) => ({
        sku: `DEMO-${shop.phone}-${index}`,
        categoryId: item.categoryId,
        name: item.name,
        nameTe: item.nameTe,
        nameHi: item.nameHi,
        weight: item.weight,
        image: item.image,
        // A little above the catalog price, so a shop reads as its own seller
        // rather than a mirror of the platform.
        pricePaise: item.pricePaise + 200,
        stock: 40,
        owner: user._id,
        createdBy: user._id,
        // The whole point: what this listing IS, across shops.
        catalogItem: item._id,
      }))
    );

    created.push({ ...shop, id: String(user._id) });
  }

  return created;
}

async function main() {
  console.info('[dev] starting in-memory MongoDB replica set…');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  // Must be set before config/env.js is loaded, since it freezes at require time.
  process.env.MONGODB_URI = replSet.getUri('vegdrop');

  /**
   * Load .env HERE, before the demo fallbacks below.
   *
   * config/env.js calls dotenv itself, but not until it is required at the
   * bottom of this function — and dotenv never overwrites a variable that is
   * already set. So every `x || 'demo-…'` below would win over the real value in
   * .env, and the fallback would silently replace real configuration rather than
   * standing in for missing configuration.
   *
   * That is not theoretical: it substituted a placeholder WHATSAPP_APP_SECRET
   * for the real one, so every webhook Meta signed failed its signature check
   * and was rejected with a 403 — with the console still reporting the demo as
   * fully configured.
   */
  require('dotenv').config();

  /**
   * Registration needs BOTH contacts proved, so /register/start and
   * /vendor/register/start refuse outright when email delivery is
   * unconfigured (config.email.configured) rather than silently only proving
   * a phone. Real deployments set EMAIL_FROM plus a provider key; this demo
   * has neither, so it fakes just enough config to pass that check and then
   * overrides the transport below so nothing actually dials out to
   * `smtp.demo.invalid`.
   */
  process.env.EMAIL_FROM = process.env.EMAIL_FROM || 'VegDrop Demo <demo@vegdrop.local>';
  process.env.SMTP_HOST = process.env.SMTP_HOST || 'smtp.demo.invalid';
  process.env.SMTP_FROM = process.env.SMTP_FROM || process.env.EMAIL_FROM;

  /**
   * Reverse OTP needs an inbox number per channel or `/auth/reverse/start`
   * answers 503 and the sign-in screen hides the option — which would make the
   * feature invisible in the demo. Both channels are faked on for the same
   * reason email is above.
   *
   * There is nothing on the other end of these numbers, so the inbound leg is
   * simulated by POSTing to /api/gateway/reverse-otp-sms with the secret below.
   */
  process.env.WHATSAPP_INBOX_NUMBER = process.env.WHATSAPP_INBOX_NUMBER || '919000000001';
  process.env.WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || 'demo-whatsapp-app-secret-000000000000';
  process.env.SMS_GATEWAY_INBOX_NUMBER = process.env.SMS_GATEWAY_INBOX_NUMBER || '919000000002';
  process.env.SMS_GATEWAY_SECRET = process.env.SMS_GATEWAY_SECRET || 'demo-sms-gateway-secret-0000000000000';

  const config = require('../config/env');
  const notify = require('../services/notify');
  const { connect, disconnect, ensureIndexes } = require('../db/connect');
  const { runMigrations } = require('../db/migrations');
  const { createApp } = require('../app');
  const { seedIfEmpty, SEED_ACCOUNTS } = require('../utils/seed');
  const sweeper = require('../services/sweeper');

  // See the EMAIL_FROM/SMTP_HOST comment above: config now believes email is
  // configured, so route past resolveEmailTransport's real SMTP attempt and
  // print codes to this console instead, exactly like the phone transport.
  notify.setTransport(notify.consoleTransport);

  await connect();
  console.info('[dev] connected to in-memory MongoDB (transactions available)');

  // `createApp` compiles every model through its route imports, so it has to
  // run before the indexes are built.
  const app = createApp();

  /**
   * A fresh in-memory database has nothing to migrate, but this runs anyway so
   * the demo exercises the same boot sequence as production. A migration that
   * only ever runs against real data is one nobody has watched work.
   */
  await runMigrations();

  /**
   * Not optional, even in a demo: `$geoNear` fails outright without a 2dsphere
   * index, so "markets near me" and "nearest rider" both 500 without this.
   */
  await ensureIndexes();

  await seedIfEmpty();
  const demoShops = await seedDemoShops();

  /**
   * The clock. Without it a demo silently loses three behaviours that only
   * happen when time passes: the 90s sourcing window closing, an unanswered
   * rider offer cascading, and held earnings being paid out.
   */
  sweeper.start();
  const server = app.listen(config.port, () => {
    console.info(`\n[dev] API listening on http://localhost:${config.port}`);
    console.info('[dev] Open the app at http://localhost:3000 (run `npm run dev` in another terminal)\n');
    console.info('  Customer   →  http://localhost:3000/');
    console.info('  Shopkeeper →  http://localhost:3000/#/shopkeeper');
    console.info('  Delivery   →  http://localhost:3000/#/delivery\n');
    if (config.devLoginEnabled) {
      console.info('[dev] Skip the code entirely — open one of these in any browser:\n');
      for (const account of SEED_ACCOUNTS) {
        const hash = account.role === 'shopkeeper' ? '/%23/shopkeeper'
          : account.role === 'delivery' ? '/%23/delivery'
          : '';
        console.info(
          `  ${account.role.padEnd(13)} http://localhost:3000/api/auth/dev/login?phone=${account.phone}${hash ? `&next=${hash}` : ''}`
        );
      }
      console.info('\n[dev] Each sets the refresh cookie and redirects into the app, signed in.');
      console.info('[dev] DEV_LOGIN=1 does this; production refuses to boot with it set.\n');
    }
    console.info('[dev] Sign-in needs the 6-digit code, which prints HERE in this console.');
    console.info('[dev] For "send us one instead", simulate the inbound message with:');
    console.info(
      `      curl -X POST http://localhost:${config.port}/api/gateway/reverse-otp-sms \\\n` +
        `        -H 'Content-Type: application/json' \\\n` +
        `        -H 'X-Gateway-Secret: ${process.env.SMS_GATEWAY_SECRET}' \\\n` +
        `        -d '{"from":"<your 10-digit number>","text":"<the code on screen>"}'`
    );
    if (demoShops.length > 0) {
      console.info('\n[seed] independent shops, stocking different amounts of the same 5 items:');
      for (const shop of demoShops) {
        console.info(`  ${shop.name.padEnd(20)} ${shop.phone}  ${shop.covers}/5 items  ~${shop.offsetKm}km`);
      }
      console.info('[seed] The best-stocked one is the furthest away on purpose, so');
      console.info('[seed] "ranked by coverage" cannot be mistaken for "ranked by distance".');
    }

    console.info('[dev] Data is in memory only and is lost when this process stops.\n');
  });

  async function shutdown() {
    sweeper.stop();
    server.close(async () => {
      await disconnect().catch(() => {});
      await replSet.stop().catch(() => {});
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[dev] failed to start:', err);
  process.exit(1);
});
