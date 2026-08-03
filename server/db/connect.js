'use strict';

const mongoose = require('mongoose');
const config = require('../config/env');

/**
 * Database connection.
 *
 * bufferCommands is disabled so a query issued while disconnected fails fast
 * instead of hanging until a timeout; the API surfaces 503 rather than stalling.
 */
mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

// NOTE: `sanitizeFilter` is deliberately NOT enabled globally. It rewrites any
// object-valued filter into an $eq comparison, which breaks legitimate operator
// queries ({ expiresAt: { $gt: now } }) throughout the codebase. Injection is
// instead blocked at the two places attacker input actually enters:
//   - middleware/validate.js  — zod rejects non-string types outright
//   - middleware/sanitize.js  — strips $-prefixed keys from body/params/query

let transactionsSupported = null;

async function connect(uri = config.mongoUri) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
  });

  // Multi-document transactions require a replica set or sharded cluster. A
  // standalone mongod (the common local dev setup) cannot run them.
  const topology = mongoose.connection.client?.topology;
  transactionsSupported = Boolean(topology?.hasSessionSupport?.());

  if (!transactionsSupported && config.isProduction) {
    throw new Error(
      'MongoDB deployment does not support transactions. Wallet and order operations require a replica set in production.'
    );
  }

  return mongoose.connection;
}

/**
 * Build every model's declared indexes, and wait for them.
 *
 * Mongoose normally does this itself when a model is compiled, but this app
 * sets `bufferCommands: false` above and compiles its models (via the route
 * imports in app.js) BEFORE the connection exists — so those automatic builds
 * fire against a dead connection and are swallowed. The result is a database
 * with no indexes at all, which mostly just runs slowly and hides.
 *
 * It stops hiding at `$geoNear`, which does not degrade to a scan: without a
 * 2dsphere index it fails the request outright. "Markets near me" and "nearest
 * rider" are both that query, so this is load-bearing rather than an
 * optimisation.
 *
 * `createIndexes` is idempotent, so a restart against an already-indexed
 * database is a cheap no-op. Deliberately NOT `syncIndexes`, which drops
 * indexes it does not recognise — that would make a rollback to an older
 * release delete the indexes the newer one added.
 */
async function ensureIndexes() {
  const models = Object.values(mongoose.models);
  const started = Date.now();

  const results = await Promise.allSettled(models.map((model) => model.createIndexes()));

  const failed = results
    .map((result, i) => ({ result, name: models[i].modelName }))
    .filter(({ result }) => result.status === 'rejected');

  for (const { name, result } of failed) {
    console.error(`[db] index build failed for ${name}: ${result.reason?.message}`);
  }

  if (failed.length === 0) {
    console.info(`[db] indexes ready (${models.length} models, ${Date.now() - started}ms)`);
  }

  return { total: models.length, failed: failed.length };
}

async function disconnect() {
  await mongoose.disconnect();
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Run `fn` inside a transaction when the deployment supports one.
 *
 * On a standalone dev mongod the callback still runs, without atomicity — the
 * boot check above guarantees production is never in that mode. Callers must
 * still write operations that are individually safe (conditional updates,
 * unique idempotency keys) rather than relying solely on the transaction.
 *
 * @param {(session: import('mongoose').ClientSession | null) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withTransaction(fn) {
  if (!transactionsSupported) {
    return fn(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { connect, disconnect, isConnected, withTransaction, ensureIndexes, mongoose };
