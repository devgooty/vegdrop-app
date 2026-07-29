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

/**
 * Index creation is explicit, via ensureIndexes() after connecting.
 *
 * Left on, autoIndex fires when each model is compiled — which happens at
 * require time, before connect() has run. With bufferCommands disabled those
 * builds fail immediately against a missing connection, and Model.init() then
 * memoizes the rejection, so every later attempt returns the same stale failure.
 * The visible symptom was $geoNear erroring with "no 2dsphere index found" on a
 * database where the index was declared correctly.
 */
mongoose.set('autoIndex', false);

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
 * Build every declared index before serving traffic.
 *
 * Mongoose's autoIndex creates indexes lazily and without awaiting them, so a
 * query can reach a collection whose index does not exist yet. For most indexes
 * that only costs a slow scan — but `$geoNear` is a hard error without its
 * 2dsphere index, so "find markets near me" fails outright on a cold database
 * rather than merely running slowly.
 *
 * createIndexes() is used rather than init(): init() memoizes its result, so a
 * build that failed before the connection existed would be replayed forever.
 * Failures are logged rather than thrown — a missing index should degrade
 * performance, not refuse to boot.
 */
async function ensureIndexes() {
  const results = await Promise.allSettled(
    Object.values(mongoose.models).map((model) => model.createIndexes())
  );

  const failed = results
    .map((result, index) => ({ result, name: Object.keys(mongoose.models)[index] }))
    .filter(({ result }) => result.status === 'rejected');

  for (const { name, result } of failed) {
    console.error(`[db] index build failed for ${name}:`, result.reason?.message);
  }

  return { total: results.length, failed: failed.length };
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

module.exports = { connect, disconnect, isConnected, ensureIndexes, withTransaction, mongoose };
