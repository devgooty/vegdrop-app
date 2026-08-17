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

// Lets a second instance run alongside the default one on a free port, e.g.
// `npm run server:demo -- --port 5001`, for side-by-side local preview.
const portFlagIndex = process.argv.indexOf('--port');
if (portFlagIndex !== -1 && process.argv[portFlagIndex + 1]) {
  process.env.PORT = process.argv[portFlagIndex + 1];
}

const { MongoMemoryReplSet } = require('mongodb-memory-server');

async function main() {
  console.info('[dev] starting in-memory MongoDB replica set…');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  // Must be set before config/env.js is loaded, since it freezes at require time.
  process.env.MONGODB_URI = replSet.getUri('vegdrop');

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
  const { seedIfEmpty } = require('../utils/seed');
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
    console.info('[dev] Sign-in needs the 6-digit code, which prints HERE in this console.');
    console.info('[dev] For "send us one instead", simulate the inbound message with:');
    console.info(
      `      curl -X POST http://localhost:${config.port}/api/gateway/reverse-otp-sms \\\n` +
        `        -H 'Content-Type: application/json' \\\n` +
        `        -H 'X-Gateway-Secret: ${process.env.SMS_GATEWAY_SECRET}' \\\n` +
        `        -d '{"from":"<your 10-digit number>","text":"<the code on screen>"}'`
    );
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
