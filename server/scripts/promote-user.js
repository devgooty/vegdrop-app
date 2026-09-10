'use strict';

/**
 * Give an existing account a privileged role, from outside the API.
 *
 * WHY THIS HAS TO EXIST
 *
 * There is otherwise no way to create the first `market_owner` or `developer`
 * on a real deployment, and each of the three things that closes that door is
 * individually correct:
 *
 *   - `utils/seed.js` skips every privileged demo account on a deployed host
 *     (`config.isProduction || config.isDeployed`). It must — those rows have
 *     published phone numbers and one of them is a `developer`.
 *   - `PATCH /api/users/:id/role` is `developer`-only, and on a fresh
 *     deployment nobody holds `developer` to call it.
 *   - `DEV_LOGIN` is a boot-time fatal the moment a deploy marker is present.
 *
 * So the role can only be granted by a role nobody has. This script is the
 * documented way out of that, run by whoever holds the database credentials —
 * which is the right authority for it, and the only one available.
 *
 * WHAT IT DELIBERATELY WILL NOT DO
 *
 * **It never creates an account.** Promotion targets a row that already exists,
 * which means the number has already been proved through the ordinary
 * passwordless flow. A script that could mint a `developer` from nothing would
 * be a worse hole than the one it fills: possession of the phone stays the
 * credential of record, and this only changes what that account is allowed to
 * do. Sign in on the customer app first, then run this.
 *
 * It also refuses to guess between accounts. One contact backs one account PER
 * ROLE, so a number can hold a customer, a shopkeeper and a delivery account at
 * once; `--from` names which of them to promote when there is more than one.
 *
 * Usage:
 *
 *   node server/scripts/promote-user.js 9281401201 market_owner
 *   node server/scripts/promote-user.js 9281401201 market_owner --apply
 *   node server/scripts/promote-user.js 9281401201 market_owner --apply --from customer
 *   node server/scripts/promote-user.js 9281401201 market_owner --apply --id <account id>
 */

const config = require('../config/env');
const User = require('../models/User');
const { ROLES } = require('../models/User');

/**
 * Normalise a typed number to the bare ten digits the database stores.
 *
 * Mirrors `fields.phone` in middleware/validate.js, including the detail that
 * matters: the country prefix is stripped BY LENGTH, never by pattern.
 * Unconditionally removing a leading "91" corrupts 9111111111, which is a real
 * mobile — and here that would mean promoting the wrong person, or reporting
 * "no such account" to someone who has one.
 */
function normalisePhone(input) {
  const bare = String(input).trim().replace(/[\s()-]/g, '').replace(/^\+/, '');
  const trimmed =
    bare.length === 12 && bare.startsWith('91') ? bare.slice(2)
    : bare.length === 11 && bare.startsWith('0') ? bare.slice(1)
    : bare;

  return /^[6-9]\d{9}$/.test(trimmed) ? trimmed : null;
}

/**
 * Every account on this number, so the caller sees what they are choosing
 * between rather than having one picked for them.
 *
 * `pendingPhone` is matched as well as `phone`, and that is not a convenience.
 * Accounts predating the phone-first registration hold their number ONLY in
 * `pendingPhone` — registration once completed on an email code, so the typed
 * number was stored unproven. On the live database that is 24 of 32 accounts.
 * Matching `phone` alone reported "no accounts on this number" for every one of
 * them, which reads as "you typed it wrong" rather than "this account is shaped
 * differently", and left the operator with no way to promote anybody.
 *
 * The number is not taken on trust here. `phoneVerifiedAt` is carried through so
 * the caller can see whether it was ever proved, and the promotion repairs the
 * field only for an account that HAS proved it — see `promote`.
 */
async function accountsFor(phone) {
  return User.find({ $or: [{ phone }, { pendingPhone: phone }] })
    .select('_id name email phone pendingPhone phoneVerifiedAt role status tokenVersion')
    .lean();
}

/**
 * Apply the role change.
 *
 * `tokenVersion` is bumped for the same reason the suspension script bumps it:
 * `middleware/auth.js` compares the token's `tv` claim against the live record,
 * so incrementing it forces the session to be re-established and the new role
 * to be read. Without it the account holds a token asserting its OLD role until
 * that token expires — which for a promotion is merely slow, and for the
 * reverse would leave privileges live after they were removed.
 */
async function promote(user, role) {
  /**
   * A legacy account's number is moved out of `pendingPhone` at the same time.
   *
   * This is the same repair `routes/auth.js` performs when such an account
   * signs in through the outbound code — the number came back from the phone,
   * so it is proved and belongs in the field that means proved. Doing it here
   * matters because the reverse-OTP path does NOT perform that repair, so an
   * account that only ever signs in that way stays legacy forever.
   *
   * Guarded on `phoneVerifiedAt`: an unproven number is exactly what
   * `pendingPhone` exists to hold apart, and a promotion is not a proof of
   * possession. An account that has never verified keeps its number where it is
   * and is promoted regardless — the operator decided that, and the role change
   * is the thing they asked for.
   */
  const repair =
    !user.phone && user.pendingPhone && user.phoneVerifiedAt
      ? { $set: { role, phone: user.pendingPhone }, $unset: { pendingPhone: '' } }
      : { $set: { role } };

  const result = await User.updateOne(
    { _id: user._id, role: user.role },
    { ...repair, $inc: { tokenVersion: 1 } }
  );
  return result.modifiedCount === 1;
}

// --- CLI --------------------------------------------------------------------

function heading(text) {
  console.info(`\n${text}\n${'─'.repeat(text.length)}`);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const FROM = argValue('--from');
  const ID = argValue('--id');

  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  // `--from customer` and `--id <oid>` leave their values in the positional
  // list; drop them.
  const args = positional.filter((a) => a !== FROM && a !== ID);
  const [rawPhone, role] = args;

  if (!rawPhone || !role) {
    console.error(
      'Usage: node server/scripts/promote-user.js <phone> <role> [--apply] [--from <role>] [--id <account id>]'
    );
    console.error(`Roles: ${ROLES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const phone = normalisePhone(rawPhone);
  if (!phone) {
    console.error(`"${rawPhone}" is not a valid 10-digit Indian mobile number.`);
    process.exitCode = 1;
    return;
  }

  if (!ROLES.includes(role)) {
    console.error(`"${role}" is not a role. Valid: ${ROLES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

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
    console.info(`  phone:    ${phone}`);
    console.info(`  to role:  ${role}`);
    console.info(`  mode:     ${APPLY ? 'APPLY — will write' : 'dry run — no writes'}`);

    const found = await accountsFor(phone);

    heading('Accounts on this number');
    if (found.length === 0) {
      console.info('  none.');
      console.info('\n  This script never creates an account — possession of the number stays');
      console.info('  the credential, and it is proved by signing in, not by this script.');
      console.info('  Sign in once on the customer app with this number, then re-run.');
      return;
    }
    for (const u of found) {
      // The id is printed because `--from <role>` cannot separate two accounts
      // holding the SAME role — which legacy data produces, since the unique
      // index binds (phone, role) and a legacy row has no `phone` to bind.
      const legacy = !u.phone && u.pendingPhone ? '  [legacy: pendingPhone]' : '';
      console.info(
        `  ${String(u._id)}  ${u.role.padEnd(13)} ${String(u.status).padEnd(9)} ${u.name || '(no name)'}${legacy}`
      );
    }

    if (found.some((u) => u.role === role)) {
      console.info(`\n  Already holds ${role} on this number. Nothing to do.`);
      return;
    }

    /**
     * Which account to promote.
     *
     * Ambiguity is refused rather than resolved by picking the first row. A
     * number legitimately holds several accounts, and silently promoting the
     * wrong one gives privileges to an identity the operator did not intend and
     * would have no reason to go looking at.
     */
    let candidates = FROM ? found.filter((u) => u.role === FROM) : found;

    /**
     * `--id` names one row outright.
     *
     * Needed because `--from <role>` assumes a role appears at most once on a
     * number, which the (phone, role) unique index normally guarantees — but a
     * legacy account has no `phone`, so nothing binds it, and the live database
     * carries three `customer` rows on one number. Without this there is no
     * expressible way to promote any of them.
     */
    if (ID) {
      candidates = candidates.filter((u) => String(u._id) === ID);
      if (candidates.length === 0) {
        console.error(`
  No account with id ${ID} on this number${FROM ? ` with role ${FROM}` : ''}.`);
        process.exitCode = 1;
        return;
      }
    }

    if (candidates.length === 0) {
      console.error(`\n  No ${FROM} account on this number to promote.`);
      process.exitCode = 1;
      return;
    }

    if (candidates.length > 1) {
      console.error(`\n  ${candidates.length} accounts on this number. Name which one with --from <role>.`);
      process.exitCode = 1;
      return;
    }

    const [target] = candidates;

    if (target.status !== 'active') {
      console.error(`\n  That account is ${target.status}, not active. Promoting a locked account`);
      console.error('  would grant privileges to something that still cannot sign in.');
      process.exitCode = 1;
      return;
    }

    heading('Change');
    console.info(`  ${target.role} → ${role}   (${target.name || target.phone || target.pendingPhone})`);
    if (!target.phone && target.pendingPhone) {
      console.info(
        target.phoneVerifiedAt
          ? `  legacy account — ${target.pendingPhone} moves from pendingPhone to phone (it is verified).`
          : '  legacy account — pendingPhone is NOT verified, so it is left where it is.'
      );
    }

    if (!APPLY) {
      console.info('\nDry run complete. Re-run with --apply to write.');
      return;
    }

    const changed = await promote(target, role);

    heading('Done');
    if (!changed) {
      // The filter pins the role it read, so a concurrent change loses rather
      // than silently overwriting a decision someone else just made.
      console.error('  nothing written — the account changed underneath this run. Re-run.');
      process.exitCode = 1;
      return;
    }

    console.info(`  ${target.phone || target.pendingPhone} is now ${role}.`);
    console.info('\n  Their existing sessions are invalidated, so they sign in again —');
    console.info('  and the new role is read from the database on the next request.');
    console.info(`  Reverse with: --apply --from ${role} ... ${target.role}`);
  } finally {
    await disconnect();
  }
}

module.exports = { normalisePhone, accountsFor, promote };

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFailed:', err?.message ?? err);
    process.exitCode = 1;
  });
}
