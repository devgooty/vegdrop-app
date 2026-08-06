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
 * Repair a wallet ledger whose (user, seq) positions collided.
 *
 * `seq` exists to serialise concurrent writes: two racing appends both read the
 * same tail, and the unique {user, seq} index turns the second insert into a
 * collision instead of a silent overdraft (see models/WalletTransaction.js).
 * That protection has to already exist for it to work — a handful of entries
 * were written before it did, or during a boot where the index build itself had
 * not finished, and ended up sharing a `seq`. The index can never be (re)built
 * on top of that, which is a symptom: the balance-derivation ledger's own
 * ordering has been ambiguous for that user ever since, whether or not the
 * index has ever successfully existed to enforce it.
 *
 * Fixed by chronological replay, which is the only ordering nothing about this
 * bug could have corrupted: reread every entry for an affected user oldest
 * first (createdAt, then _id as a same-millisecond tiebreak — an ObjectId
 * embeds its own creation time and is monotonic even within one millisecond),
 * renumber `seq` 1..n in that order, and recompute `balanceAfterPaise` as the
 * running sum of signed amounts. The second part matters as much as the
 * first: two entries that both read the same stale tail did not just collide
 * on `seq`, they each computed a `balanceAfterPaise` that ignores whichever of
 * them actually happened second, so the stored balance can already be wrong
 * quite apart from the index refusing to build.
 *
 * Writes go through the raw collection, not the Mongoose model: this is a
 * point-in-time repair of already-stored numbers, not a new ledger entry, and
 * the model's own validators are not relevant here.
 */
async function migrateWalletLedgerSequence() {
  const WalletTransaction = mongoose.models.WalletTransaction;
  if (!WalletTransaction) return { usersFixed: 0, entriesFixed: 0, overdraftsFound: [] };

  /**
   * Every user, unconditionally, rather than pre-filtering to "users with a
   * seq collision" first.
   *
   * An earlier version of this migration used an aggregation ($group by
   * {user, seq}, keep groups with count > 1) to find affected users before
   * doing the expensive per-user replay. That ran in production, found
   * nothing, and the exact same index build failure it was meant to fix
   * happened again on the very next boot.
   *
   * The likely reason: a unique index is multikey-aware — if `seq` on one
   * document is ever an array (a stray `$push` somewhere, instead of `$set`,
   * at some point in this collection's history) rather than the plain number
   * the schema declares, MongoDB's index build still collides `[7]` against a
   * sibling document's plain `7`, because it indexes each array element
   * separately. The aggregation's $group does not: `[7]` and `7` are
   * different group keys to it, so a document in exactly that shape hides
   * from detection while still breaking the index build it was meant to
   * explain. Recomputing every user and diffing against what is actually
   * stored — rather than trusting a pre-filter to have already found the
   * problem — catches that shape (or any other one) the same way it catches
   * a plain numeric collision: `typeof entry.seq === 'number'` is false for
   * an array, so the entry is corrected regardless of why it was wrong.
   *
   * Collections here are small (per-user wallet history, not a shared table),
   * so scanning everyone on every boot costs nothing worth optimising away —
   * and an early return in the loop below skips a user immediately once
   * their own entries are confirmed already correct.
   */
  const userIds = await WalletTransaction.collection.distinct('user');

  let usersFixed = 0;
  let entriesFixed = 0;
  const overdraftsFound = [];

  for (const userId of userIds) {
    const entries = await WalletTransaction.collection
      .find({ user: userId })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();

    const ops = [];
    let runningPaise = 0;

    entries.forEach((entry, index) => {
      const signed = entry.type === 'credit' ? entry.amountPaise : -entry.amountPaise;
      runningPaise += signed;

      // A true chronological replay going negative means a debit was allowed
      // against a balance that, in the correct order, could not cover it — a
      // real historical overdraft the race let through, not a data-entry slip.
      // Recorded rather than clamped: papering over it here would make the
      // running total lie about what actually happened.
      if (runningPaise < 0) {
        overdraftsFound.push({ user: userId.toString(), afterEntry: entry._id.toString(), balancePaise: runningPaise });
      }

      const correctSeq = index + 1;
      // typeof-checked, not just !==: a non-numeric seq (an array, from the
      // corruption this migration exists to catch) is wrong regardless of
      // what it happens to loosely compare equal to.
      const seqIsClean = typeof entry.seq === 'number' && entry.seq === correctSeq;
      const balanceIsClean = entry.balanceAfterPaise === runningPaise;

      if (!seqIsClean || !balanceIsClean) {
        ops.push({
          updateOne: {
            filter: { _id: entry._id },
            update: { $set: { seq: correctSeq, balanceAfterPaise: runningPaise } },
          },
        });
      }
    });

    if (ops.length > 0) {
      await WalletTransaction.collection.bulkWrite(ops, { ordered: true });
      entriesFixed += ops.length;
      usersFixed += 1;
    }
  }

  return { usersFixed, entriesFixed, overdraftsFound };
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
  let ok = true;

  // Independent try/catch per migration: one that fails must not stop an
  // unrelated one from running, and both retry on the next boot regardless.
  try {
    const { backfilled, droppedIndexes } = await migrateStallApproval();

    if (backfilled > 0) {
      console.info(`[db] migration: marked ${backfilled} existing stall(s) approved`);
    }
    if (droppedIndexes.length > 0) {
      console.info(`[db] migration: dropped superseded stall index(es) ${droppedIndexes.join(', ')}`);
    }
  } catch (err) {
    console.error(`[db] migration (stall approval) failed: ${err?.message}`);
    ok = false;
  }

  try {
    const { usersFixed, entriesFixed, overdraftsFound } = await migrateWalletLedgerSequence();

    if (entriesFixed > 0) {
      console.info(
        `[db] migration: repaired wallet ledger sequence for ${usersFixed} user(s), ${entriesFixed} entr${entriesFixed === 1 ? 'y' : 'ies'} renumbered`
      );
    }
    if (overdraftsFound.length > 0) {
      // Not a boot failure — the repair already applied — but a real historical
      // event worth a human looking at, not just a log line scrolling past.
      console.error(
        `[db] migration: wallet ledger repair found ${overdraftsFound.length} point(s) where chronological replay went negative`,
        overdraftsFound
      );
    }
  } catch (err) {
    console.error(`[db] migration (wallet ledger sequence) failed: ${err?.message}`);
    ok = false;
  }

  console.info(`[db] migrations ready (${Date.now() - started}ms)`);
  return { ok };
}

module.exports = { runMigrations, migrateStallApproval, migrateWalletLedgerSequence };
