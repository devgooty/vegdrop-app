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

const { MongoMemoryReplSet } = require('mongodb-memory-server');

async function main() {
  console.info('[dev] starting in-memory MongoDB replica set…');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  // Must be set before config/env.js is loaded, since it freezes at require time.
  process.env.MONGODB_URI = replSet.getUri('vegbazzar');

  const config = require('../config/env');
  const { connect, disconnect } = require('../db/connect');
  const { createApp } = require('../app');
  const { seedIfEmpty } = require('../utils/seed');

  await connect();
  console.info('[dev] connected to in-memory MongoDB (transactions available)');

  await seedIfEmpty();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.info(`\n[dev] API listening on http://localhost:${config.port}`);
    console.info('[dev] Open the app at http://localhost:3000 (run `npm run dev` in another terminal)\n');
    console.info('  Customer   →  http://localhost:3000/');
    console.info('  Shopkeeper →  http://localhost:3000/#/shopkeeper');
    console.info('  Delivery   →  http://localhost:3000/#/delivery\n');
    console.info('[dev] Sign-in needs the 6-digit code, which prints HERE in this console.');
    console.info('[dev] Data is in memory only and is lost when this process stops.\n');
  });

  async function shutdown() {
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
