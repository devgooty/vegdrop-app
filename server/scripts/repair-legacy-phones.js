'use strict';

/**
 * Move a proved number out of `pendingPhone` and into `phone`.
 *
 * Registration once completed on an email code, so the number somebody typed
 * was stored unproven in `pendingPhone` and `phone` was never set. On the live
 * database that is 24 of 32 accounts — every one of them carrying a
 * `phoneVerifiedAt` that says the number WAS proved, in a field that says it
 * was not.
 *
 * Both sign-in paths now perform this repair per account (routes/auth.js has
 * always done it; routes/reverseOtp.js does since the fix), so the population
 * heals as people return. This script is for the ones who do not return soon,
 * and it exists as a script rather than a boot migration for one reason: it
 * CANNOT always succeed, and a migration that half-applies on every boot and
 * logs a conflict nobody reads is worse than one somebody runs and reads.
 *
 * The conflict is real and not rare. `pendingPhone` was never reserved — no
 * unique index, by design, because an unproven claim must not block anybody —
 * so several accounts may claim one number. `(phone, role)` IS unique, so only
 * one of them per role can be repaired. The live database has three `customer`
 * rows claiming one number.
 *
 * Where that happens the winner is the OLDEST by `createdAt`, because that is
 * who `findByIdentifier` resolves to (see the note there). Picking any other
 * would repair one account and sign the user into a different one.
 *
 * Usage:
 *
 *   node server/scripts/repair-legacy-phones.js            # dry run
 *   node server/scripts/repair-legacy-phones.js --apply
 */

const config = require('../config/env');
const User = require('../models/User');

/**
 * Accounts whose number is proved but filed as unproven.
 *
 * `phoneVerifiedAt` is required, not optional. An account that never verified
 * is exactly what `pendingPhone` exists to hold apart, and this script is a
 * filing correction — it must never turn an unproven claim into a credential.
 */
async function findLegacy() {
  return User.find({
    phone: { $exists: false },
    pendingPhone: { $type: 'string', $ne: '' },
    phoneVerifiedAt: { $ne: null },
    status: { $ne: 'deleted' },
  })
    .select('_id name email pendingPhone role status phoneVerifiedAt createdAt lastLoginAt')
    .sort({ createdAt: 1 })
    .lean();
}

/**
 * Split them into the ones that can be repaired and the ones that cannot.
 *
 * A number already held by a live account in the same role is a blocker, and it
 * is checked against the database rather than only within this batch — the
 * winner may have been repaired by a previous run, or by its own sign-in while
 * this was being read.
 *
 * @returns {Promise<{repair: object[], blocked: Array<{user: object, because: string}>}>}
 */
async function partition(legacy) {
  const numbers = [...new Set(legacy.map((u) => u.pendingPhone))];

  const taken = new Set(
    (
      await User.find({ phone: { $in: numbers }, status: { $ne: 'deleted' } })
        .select('phone role')
        .lean()
    ).map((u) => `${u.phone}|${u.role}`)
  );

  const repair = [];
  const blocked = [];

  // `legacy` is sorted oldest first, so the first claimant of a (number, role)
  // wins — the same row findByIdentifier resolves to.
  for (const user of legacy) {
    const key = `${user.pendingPhone}|${user.role}`;
    if (taken.has(key)) {
      blocked.push({ user, because: `another ${user.role} already holds ${user.pendingPhone}` });
      continue;
    }
    taken.add(key);
    repair.push(user);
  }

  return { repair, blocked };
}

/**
 * Apply it, one account at a time.
 *
 * Not `updateMany`: each write names its own document and is filtered on the
 * state this run read, so an account that changed underneath — signed in and
 * repaired itself, was suspended — loses rather than being overwritten. A batch
 * would either take them all or tell us nothing about which failed.
 *
 * `tokenVersion` is deliberately NOT bumped. Nothing about the session changes:
 * the role is the same, the account is the same, and the number was already
 * proved. Forcing every legacy holder to sign in again would be a worse outcome
 * than the filing error being fixed.
 */
async function repairAll(users) {
  const done = [];
  const failed = [];

  for (const user of users) {
    try {
      const result = await User.updateOne(
        { _id: user._id, phone: { $exists: false }, pendingPhone: user.pendingPhone },
        { $set: { phone: user.pendingPhone }, $unset: { pendingPhone: '' } }
      );
      if (result.modifiedCount === 1) done.push(user);
      else failed.push({ user, because: 'changed underneath this run' });
    } catch (err) {
      // E11000 despite the pre-check: someone proved the same number between
      // the read and this write. Reported, never thrown — one collision must
      // not abandon the rest of the batch.
      failed.push({ user, because: err?.code === 11000 ? 'number taken mid-run' : err.message });
    }
  }

  return { done, failed };
}

// --- CLI --------------------------------------------------------------------

function heading(text) {
  console.info(`\n${text}\n${'─'.repeat(text.length)}`);
}

function describe(u) {
  return `${String(u._id)}  ${String(u.role).padEnd(13)} ${u.pendingPhone}  ${u.name || '(no name)'}`;
}

async function main() {
  const APPLY = process.argv.includes('--apply');

  if (!config.mongoUri) {
    console.error('MONGODB_URI is not set. Nothing to connect to.');
    process.exitCode = 1;
    return;
  }

  const { connect, disconnect, mongoose } = require('../db/connect');
  await connect(config.mongoUri);

  try {
    heading('Target');
    console.info(`  database: ${mongoose.connection.name}`);
    console.info(`  host:     ${mongoose.connection.host}`);
    console.info(`  mode:     ${APPLY ? 'APPLY — will write' : 'dry run — no writes'}`);

    const legacy = await findLegacy();

    if (legacy.length === 0) {
      console.info('\nNothing to repair — every proved number is already filed as proved.');
      return;
    }

    const { repair, blocked } = await partition(legacy);

    heading(`Will be repaired (${repair.length})`);
    for (const u of repair) console.info(`  ${describe(u)}`);

    if (blocked.length > 0) {
      heading(`Cannot be repaired (${blocked.length})`);
      for (const entry of blocked) {
        console.info(`  ${describe(entry.user)}`);
        console.info(`      ${entry.because}`);
      }
      console.info('\n  These keep their number in pendingPhone. That is correct rather than');
      console.info('  a failure: (phone, role) is unique, so one account per role can hold a');
      console.info('  number, and the oldest — the one sign-in resolves to — got it. Decide');
      console.info('  what the duplicates are for; merging or closing them is a judgement');
      console.info('  call this script will not make on its own.');
    }

    if (!APPLY) {
      console.info(`\nDry run complete. Re-run with --apply to repair ${repair.length} account(s).`);
      return;
    }

    const { done, failed } = await repairAll(repair);

    heading('Done');
    console.info(`  repaired: ${done.length}`);
    if (failed.length > 0) {
      console.info(`  failed:   ${failed.length}`);
      for (const entry of failed) {
        console.info(`    ${describe(entry.user)} — ${entry.because}`);
      }
    }
    console.info('\n  No session was invalidated: the role, the account and the number are');
    console.info('  unchanged. Only the field holding the number is.');
  } finally {
    await disconnect();
  }
}

module.exports = { findLegacy, partition, repairAll };

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFailed:', err?.message ?? err);
    process.exitCode = 1;
  });
}
