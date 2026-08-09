'use strict';

/**
 * Lock the seeded demo accounts out of a real database, without deleting them.
 *
 * These accounts were created by `seedIfEmpty()` against production (see
 * scripts/remove-demo-seed.js for how that happened). They have **no
 * passwords** — sign-in is passwordless, so anyone who can read the OTP is in —
 * and one of them holds `developer`, the role that bypasses the vendor KYC gate
 * and every admin panel check.
 *
 * Deleting them is the eventual fix, but it is blocked while real data still
 * refers to the demo rows. This is the thing that can be done immediately and
 * independently.
 *
 * Suspension rather than demotion, deliberately:
 *
 *   - `middleware/auth.js:46` refuses any request whose user is not `active`,
 *     re-read from the database on every call, so this takes effect on the very
 *     next request rather than when a token expires.
 *   - `routes/auth.js:266` refuses sign-in outright with 403 ACCOUNT_INACTIVE.
 *
 * Demoting `role` to `customer` would only remove the privileges; the account
 * could still sign in and place orders. Suspension closes both, keeps every
 * record intact, and reverses with a single flag — where a rewritten `role`
 * would have lost what the account was for.
 *
 * `tokenVersion` is bumped as well. Suspension already fails the status check
 * ahead of it, but leaving a live token valid against a locked account is the
 * kind of near-miss that survives a later refactor of the status check.
 *
 * Usage:
 *
 *   node server/scripts/suspend-demo-accounts.js            # dry run
 *   node server/scripts/suspend-demo-accounts.js --apply
 *   node server/scripts/suspend-demo-accounts.js --apply --restore
 */

const config = require('../config/env');
const User = require('../models/User');

// Reuse the removal script's matcher rather than re-deriving it. It requires
// phone AND email to match a seed entry, so a real person holding a
// reserved-range number is never caught by either script.
const { plan } = require('./remove-demo-seed');

/** The seeded accounts, with whatever state they are currently in. */
async function findDemoAccounts() {
  return (await plan()).users;
}

/**
 * Lock the accounts out.
 *
 * Already-suspended accounts are skipped rather than re-written, so re-running
 * does not keep incrementing `tokenVersion` on rows that are already closed.
 *
 * @returns {Promise<{matched: number, changed: number}>}
 */
async function suspend(users) {
  const ids = users.filter((u) => u.status !== 'suspended').map((u) => u._id);
  if (ids.length === 0) return { matched: users.length, changed: 0 };

  const result = await User.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'suspended' }, $inc: { tokenVersion: 1 } }
  );
  return { matched: users.length, changed: result.modifiedCount };
}

/**
 * Undo it.
 *
 * Only ever sets `active` on accounts currently `suspended` — never on one
 * marked `deleted`, which is a different decision someone made on purpose.
 */
async function restore(users) {
  const ids = users.filter((u) => u.status === 'suspended').map((u) => u._id);
  if (ids.length === 0) return { matched: users.length, changed: 0 };

  const result = await User.updateMany(
    { _id: { $in: ids }, status: 'suspended' },
    { $set: { status: 'active' } }
  );
  return { matched: users.length, changed: result.modifiedCount };
}

// --- CLI --------------------------------------------------------------------

function heading(text) {
  console.info(`\n${text}\n${'─'.repeat(text.length)}`);
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const RESTORE = process.argv.includes('--restore');

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
    console.info(`  action:   ${RESTORE ? 'RESTORE to active' : 'SUSPEND'}`);
    console.info(`  mode:     ${APPLY ? 'APPLY — will write' : 'dry run — no writes'}`);

    const users = await findDemoAccounts();

    heading('Demo accounts');
    if (users.length === 0) {
      console.info('  none found — nothing to do.');
      return;
    }
    for (const u of users) {
      console.info(`  ${u.role.padEnd(13)} ${u.phone}  ${String(u.status).padEnd(9)} ${u.email}`);
    }

    if (!APPLY) {
      const verb = RESTORE ? 'restored' : 'suspended';
      const n = users.filter((u) =>
        RESTORE ? u.status === 'suspended' : u.status !== 'suspended'
      ).length;
      console.info(`\nDry run complete. ${n} account(s) would be ${verb}.`);
      console.info(`Re-run with --apply${RESTORE ? ' --restore' : ''} to write.`);
      return;
    }

    const result = RESTORE ? await restore(users) : await suspend(users);

    heading('Done');
    console.info(`  matched: ${result.matched}`);
    console.info(`  changed: ${result.changed}`);
    if (!RESTORE) {
      console.info('\n  These accounts can no longer sign in (403) and any live token');
      console.info('  is refused (401) on its next request. Nothing was deleted.');
      console.info('  Reverse with: --apply --restore');
    }
  } finally {
    await disconnect();
  }
}

module.exports = { findDemoAccounts, suspend, restore };

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFailed:', err?.message ?? err);
    process.exitCode = 1;
  });
}
