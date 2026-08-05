'use strict';

const mongoose = require('mongoose');

/**
 * Schema changes that existing data cannot survive on its own.
 *
 * WHY THIS EXISTS SEPARATELY FROM ensureIndexes
 *
 * `ensureIndexes` deliberately calls `createIndexes` rather than `syncIndexes`,
 * so it never drops anything — a rollback to an older release must not delete
 * the indexes a newer one added. That is the right default, but it means an
 * index whose *options* changed can never be rebuilt: MongoDB answers a
 * same-key-different-options request with IndexOptionsConflict and the old
 * definition silently stays in force. Dropping such an index is a deliberate,
 * named act, which is what this file is for.
 *
 * Every migration here must be idempotent. They run on every boot, including
 * boots of a database that has already had them applied, and including two
 * instances starting at once.
 */

/**
 * Stall gained an approval workflow: a shopkeeper now asks to join a market and
 * the market owner accepts or refuses.
 *
 * Two things break without this.
 *
 * 1. Stalls created before the field exists have no `status`. The new schema
 *    default only applies to documents this process creates, so a query for
 *    `status: 'approved'` would not match a single existing stall and every
 *    live stall would quietly stop being offered orders. They were created by a
 *    market manager through POST /markets/:id/stalls, which is an approval by
 *    definition, so `approved` is the honest backfill.
 *
 * 2. The uniqueness rule on `owner` changed from sparse to partial. The old
 *    index counted a stall in any state, so one rejection would have barred a
 *    shopkeeper from ever applying to another market. The replacement only
 *    counts pending and approved rows — but it cannot be built while the old
 *    one is present, because the keys match and the options do not.
 */
async function migrateStallApproval() {
  const Stall = mongoose.models.Stall;
  if (!Stall) return { backfilled: 0, droppedIndexes: [] };

  const { modifiedCount } = await Stall.collection.updateMany(
    { status: { $exists: false } },
    { $set: { status: 'approved' } }
  );

  // Drop the superseded definitions so ensureIndexes can build the partial ones.
  // Identified by key shape rather than by name: an index created by an older
  // release carries Mongo's generated name, which is stable, but checking the
  // options is what actually establishes it is the stale one.
  const droppedIndexes = [];
  const existing = await Stall.collection.indexes().catch(() => []);

  for (const index of existing) {
    const keys = Object.keys(index.key);

    const staleOwner =
      keys.length === 1 && keys[0] === 'owner' && index.unique && !index.partialFilterExpression;

    const staleStallNumber =
      keys.length === 2 &&
      keys[0] === 'market' &&
      keys[1] === 'stallNumber' &&
      index.unique &&
      !index.partialFilterExpression;

    if (staleOwner || staleStallNumber) {
      // A concurrent boot may have dropped it a moment ago; that is success, not
      // a failure, so the error is swallowed rather than surfaced.
      await Stall.collection.dropIndex(index.name).catch(() => {});
      droppedIndexes.push(index.name);
    }
  }

  return { backfilled: modifiedCount, droppedIndexes };
}

/**
 * Run every migration, in order, before indexes are built.
 *
 * Failures are logged and swallowed rather than aborting boot. A migration that
 * cannot run leaves the database as it was, which is recoverable; refusing to
 * start leaves the service down, which is not — and these run on every boot, so
 * the next one retries anyway.
 */
async function runMigrations() {
  const started = Date.now();

  try {
    const { backfilled, droppedIndexes } = await migrateStallApproval();

    if (backfilled > 0) {
      console.info(`[db] migration: marked ${backfilled} existing stall(s) approved`);
    }
    if (droppedIndexes.length > 0) {
      console.info(`[db] migration: dropped superseded stall index(es) ${droppedIndexes.join(', ')}`);
    }
  } catch (err) {
    console.error(`[db] migration failed: ${err?.message}`);
    return { ok: false };
  }

  console.info(`[db] migrations ready (${Date.now() - started}ms)`);
  return { ok: true };
}

module.exports = { runMigrations, migrateStallApproval };
