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
 * User gained per-role identity: one contact may now back a customer, a
 * shopkeeper AND a delivery account, instead of exactly one account globally.
 * See the MIGRATION NOTE above the `{ email: 1, role: 1 }` / `{ phone: 1,
 * role: 1 }` indexes in models/User.js.
 *
 * Two indexes are stale, and they fail in different ways.
 *
 * The unique single-field index — `{ email: 1 }` with `unique: true` — is the
 * old global constraint. It cannot be rebuilt as the new compound one merely
 * by adding `role`, because its NAME does not collide with anything (compound
 * indexes get their own auto-generated name), so `createIndexes()` builds the
 * new compound index successfully alongside it. The two then coexist, and the
 * old one goes on enforcing one-account-per-contact regardless of what the
 * current schema declares — silently, because nothing failed.
 *
 * A second, easier-to-miss failure is what actually surfaced in production:
 * `email`/`phone` still carry `index: true` at the field level for plain
 * lookups (unrelated to uniqueness), which Mongoose auto-names `email_1` —
 * the SAME auto-generated name the old unique index already holds. Same name,
 * different options (unique/sparse vs plain), so `createIndexes()` throws
 * IndexOptionsConflict for that one specifically. The error is logged and
 * swallowed by `ensureIndexes()`, so boot continues, but neither the lookup
 * index nor (independently) the compound unique index this migration exists
 * to unblock gets built until the stale one is gone.
 *
 * Matched by key shape and `unique: true`, the same test `migrateStallApproval`
 * uses for `owner` above — a single-field unique index on exactly `email` or
 * `phone` is, by construction, the retired global constraint. The new rule
 * lives on a two-key index (`email`+`role` or `phone`+`role`), so this can
 * never match it.
 */
async function migrateUserContactIndexes() {
  const User = mongoose.models.User;
  if (!User) return { droppedIndexes: [] };

  const droppedIndexes = [];
  const existing = await User.collection.indexes().catch(() => []);

  for (const index of existing) {
    const keys = Object.keys(index.key);

    const staleContact =
      keys.length === 1 && (keys[0] === 'email' || keys[0] === 'phone') && index.unique === true;

    if (staleContact) {
      // A concurrent boot may have dropped it a moment ago; that is success,
      // not a failure, so the error is swallowed rather than surfaced.
      await User.collection.dropIndex(index.name).catch(() => {});
      droppedIndexes.push(index.name);
    }
  }

  return { droppedIndexes };
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
/**
 * Login codes stopped being delivered to email, so `emailVerifiedAt` records
 * something that can no longer happen.
 *
 * WHY IT HAS TO GO RATHER THAN JUST BEING IGNORED
 *
 * A stale timestamp here is not inert. `verifiedContacts()` used to read it,
 * and the field is exactly the kind of thing a future change reads again
 * without checking whether anything still sets it — at which point every
 * pre-migration account claims a verified address that nobody has proved
 * control of since the flow that proved it was deleted. Removing the data is
 * what makes the schema comment true.
 *
 * The ADDRESS is kept. `email` is still a live field: routes/markets.js sends
 * stall approval and suspension notices to it, and PATCH /api/users/:id sets
 * it. Only the claim that someone proved it is dropped.
 *
 * Idempotent by construction: `$unset` on documents that still have the field
 * matches nothing on a second run, so two instances booting at once race
 * harmlessly and a database that has already been migrated does no writes.
 */
async function migrateDroppedEmailVerification() {
  const User = mongoose.connection.collection('users');

  const result = await User.updateMany(
    { emailVerifiedAt: { $exists: true } },
    { $unset: { emailVerifiedAt: '' } }
  );

  return { cleared: result?.modifiedCount ?? 0 };
}

/**
 * Profile photo uploads were removed, so the stored photographs and the field
 * that pointed at them have to go with the feature.

 * WHY THE BYTES ARE DELETED RATHER THAN LEFT ALONE
 *
 * Nothing reads them any more, so leaving them costs no correctness — but they
 * are photographs of people's faces that their owners can no longer see, edit
 * or delete, because every screen and endpoint that reached them is gone. A
 * dropped feature must not turn its data into a permanent holding of personal
 * images nobody can act on. That is the whole reason this runs.
 *
 * `avatar.photoUpdatedAt` goes for the same reason `emailVerifiedAt` did above:
 * a leftover timestamp asserting "this account has a photo" is exactly the kind
 * of field a later change reads again without checking whether anything still
 * writes it, and every pre-migration account would then claim a picture that
 * does not exist.
 *
 * Idempotent both halves. `$unset` matches nothing on a second run, and a
 * missing collection reports `NamespaceNotFound` (26), which is swallowed — two
 * instances booting at once race harmlessly, and the second simply finds the
 * work already done.
 */
async function migrateRemovedAvatarPhotos() {
  const User = mongoose.connection.collection('users');

  const result = await User.updateMany(
    { 'avatar.photoUpdatedAt': { $exists: true } },
    { $unset: { 'avatar.photoUpdatedAt': '' } }
  );

  let photosDropped = 0;
  try {
    const collection = mongoose.connection.collection('useravatars');
    photosDropped = await collection.countDocuments();
    await collection.drop();
  } catch (err) {
    // 26 is NamespaceNotFound: already dropped, or never existed on a database
    // that post-dates the feature. Anything else is a real failure.
    if (err?.code !== 26) throw err;
    photosDropped = 0;
  }

  return { cleared: result?.modifiedCount ?? 0, photosDropped };
}

/**
 * Link each shop's own listings to the shared-catalog item they are an instance
 * of, so basket coverage can be asked across shops (see `Product.catalogItem`).
 *
 * NAME MATCHING LIVES HERE AND NOWHERE ELSE, AND IT NEVER GUESSES.
 *
 * A listing predating `catalogItem` records what it is only in its name, so a
 * one-time backfill has nothing else to go on. That is acceptable exactly once,
 * under two rules: the match must be unambiguous — one catalog row, one shop row,
 * for a given normalised name — and anything else is LEFT NULL rather than
 * linked to a best guess. A wrong link is worse than no link: it makes a shop
 * look like it stocks something it does not, and routes an order there that the
 * shop then cannot fill. Unlinked is merely invisible, which is recoverable by a
 * vendor picking the right item.
 *
 * Nothing at runtime matches on names. Coverage is an exact `catalogItem` match.
 *
 * Idempotent: only rows with `catalogItem: null` are considered and every write
 * is guarded on it still being null, so a second run — or a second instance
 * booting at the same moment — writes nothing rather than relinking.
 */
async function migrateProductCatalogItem() {
  const Products = mongoose.connection.collection('products');

  // Only shop-owned rows need linking. A shared row IS the canonical item.
  const unlinked = await Products.find(
    { owner: { $ne: null }, catalogItem: null },
    { projection: { _id: 1, name: 1 } }
  ).toArray();

  if (unlinked.length === 0) return { linked: 0, unmatched: 0, ambiguous: 0 };

  const normalise = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const catalog = await Products.find(
    { owner: null },
    { projection: { _id: 1, name: 1 } }
  ).toArray();

  /**
   * Names that appear on more than one catalog row are unusable: there is no
   * way to tell which was meant. Recorded as ambiguous and skipped, never
   * resolved by taking the first.
   */
  const byName = new Map();
  const duplicated = new Set();
  for (const row of catalog) {
    const key = normalise(row.name);
    if (!key) continue;
    if (byName.has(key)) duplicated.add(key);
    byName.set(key, row._id);
  }

  let linked = 0;
  let unmatched = 0;
  let ambiguous = 0;

  for (const row of unlinked) {
    const key = normalise(row.name);
    if (!key || !byName.has(key)) {
      unmatched += 1;
      continue;
    }
    if (duplicated.has(key)) {
      ambiguous += 1;
      continue;
    }

    // Guarded on still being null, so a concurrent boot cannot double-write.
    const result = await Products.updateOne(
      { _id: row._id, catalogItem: null },
      { $set: { catalogItem: byName.get(key) } }
    );
    if (result?.modifiedCount) linked += 1;
  }

  return { linked, unmatched, ambiguous };
}

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
    const { droppedIndexes } = await migrateUserContactIndexes();

    if (droppedIndexes.length > 0) {
      console.info(`[db] migration: dropped superseded user contact index(es) ${droppedIndexes.join(', ')}`);
    }
  } catch (err) {
    console.error(`[db] migration (user contact indexes) failed: ${err?.message}`);
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

  try {
    const { cleared } = await migrateDroppedEmailVerification();

    if (cleared > 0) {
      console.info(
        `[db] migration: cleared emailVerifiedAt from ${cleared} account(s) — nothing proves an address any more`
      );
    }
  } catch (err) {
    console.error(`[db] migration (dropped email verification) failed: ${err?.message}`);
    ok = false;
  }

  try {
    const { cleared, photosDropped } = await migrateRemovedAvatarPhotos();

    if (cleared > 0 || photosDropped > 0) {
      console.info(
        `[db] migration: removed ${photosDropped} uploaded profile photo(s) and ` +
          `cleared avatar.photoUpdatedAt from ${cleared} account(s) — uploads are gone`
      );
    }
  } catch (err) {
    console.error(`[db] migration (removed avatar photos) failed: ${err?.message}`);
    ok = false;
  }

  try {
    const { linked, unmatched, ambiguous } = await migrateProductCatalogItem();

    if (linked > 0) {
      console.info(`[db] migration: linked ${linked} shop listing(s) to a shared catalog item`);
    }
    /**
     * Reported, never swallowed. These listings are invisible to basket
     * coverage until a vendor links them by hand, and a silent zero here would
     * read as "every shop's catalog is searchable" when it is not.
     */
    if (unmatched > 0 || ambiguous > 0) {
      console.warn(
        `[db] migration: ${unmatched + ambiguous} shop listing(s) left unlinked ` +
          `(${unmatched} matched no catalog item, ${ambiguous} matched more than one). ` +
          'They will not appear in basket coverage until a vendor links them.'
      );
    }
  } catch (err) {
    console.error(`[db] migration (product catalog item) failed: ${err?.message}`);
    ok = false;
  }

  console.info(`[db] migrations ready (${Date.now() - started}ms)`);
  return { ok };
}

module.exports = {
  runMigrations,
  migrateStallApproval,
  migrateUserContactIndexes,
  migrateWalletLedgerSequence,
  migrateDroppedEmailVerification,
  migrateRemovedAvatarPhotos,
  migrateProductCatalogItem,
};
