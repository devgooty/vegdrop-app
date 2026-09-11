'use strict';

/**
 * Find — and optionally remove — accounts that duplicate another account.
 *
 * `(phone, role)` is unique, so "one number, one account per role" is enforced
 * by the database for every account whose number is actually in `phone`. This
 * script is about the two kinds of duplicate that constraint cannot see.
 *
 * **Unreachable duplicates.** An account claiming a number in `pendingPhone`
 * while a different account of the same role HOLDS that number in `phone`.
 * `findByIdentifier` resolves the holder first, always, so nobody can ever sign
 * into the claimant again — not the person who created it, not anyone. These
 * are dead rows and the script will delete them, on evidence, below.
 *
 * They exist because `pendingPhone` carries no unique index, deliberately: an
 * unproven claim must never block a real person from registering. While
 * registration could complete on an email code, that left a typed-but-unproved
 * number on the account, and the same number could be typed any number of
 * times. Registration proves the phone now, so no new ones are created.
 *
 * **Same name, same role, different numbers.** One person who registered twice
 * on two numbers. The index cannot see this and neither can anything else: with
 * no identity verification anywhere in the system, the number IS the person, so
 * two numbers are two people as far as the database can tell. This half is
 * therefore **reported and never deleted**. A shared name is not evidence — a
 * market can hold two people called the same thing.
 *
 * Usage:
 *
 *   node server/scripts/find-duplicate-accounts.js            # report only
 *   node server/scripts/find-duplicate-accounts.js --apply    # delete the dead rows
 *   node server/scripts/find-duplicate-accounts.js --apply --with-abandoned-kyc
 *
 * Report is the default for the same reason it is in remove-demo-seed.js: this
 * points at whatever MONGODB_URI is in the environment.
 */

const config = require('../config/env');
const mongoose = require('mongoose');

const User = require('../models/User');
const Order = require('../models/Order');
const PaymentIntent = require('../models/PaymentIntent');
const WalletTransaction = require('../models/WalletTransaction');
const VendorKyc = require('../models/VendorKyc');
const Stall = require('../models/Stall');
const Product = require('../models/Product');
const RefreshToken = require('../models/RefreshToken');
const OtpChallenge = require('../models/OtpChallenge');

/**
 * Prove every entanglement filter actually discriminates before trusting a zero.
 *
 * `db/connect.js` sets `strictQuery: true`, which silently DROPS an unknown path
 * from a filter — no error, no warning. So `{ shopkeeper: id }` against a model
 * whose field is `owner` does not return nothing; it returns whatever `{}`
 * returns, and a count meant to protect real data becomes noise. This was not
 * hypothetical: the first version of this audit reported three stalls against
 * every account, including customers, and blocked seven safe deletions.
 *
 * Querying each collection for an id that cannot exist is the cheapest possible
 * proof that the field names are right. A non-zero answer means a filter
 * collapsed, and the only safe response is to stop.
 */
async function assertFiltersDiscriminate() {
  const ghost = new mongoose.Types.ObjectId();
  const controls = [
    ['Order', Order, { customer: ghost }],
    ['Stall', Stall, { owner: ghost }],
    ['Product', Product, { owner: ghost }],
    ['PaymentIntent', PaymentIntent, { user: ghost }],
    ['WalletTransaction', WalletTransaction, { user: ghost }],
    ['VendorKyc', VendorKyc, { user: ghost }],
  ];
  const broken = [];
  for (const [label, Model, filter] of controls) {
    if ((await Model.countDocuments(filter)) !== 0) broken.push(label);
  }
  if (broken.length > 0) {
    throw new Error(
      `Filter did not discriminate for: ${broken.join(', ')}. A field name is wrong ` +
        'and strictQuery dropped it. Refusing to judge deletions on these counts.'
    );
  }
}

/**
 * Accounts that share a (number, role) with an account holding that number.
 *
 * The holder is whoever has it in `phone` — which is also whoever sign-in
 * resolves to, so "unreachable" here is a fact about the login path, not an
 * inference from the data.
 */
async function findUnreachable() {
  const live = await User.find({ status: { $ne: 'deleted' } })
    .select('name email role phone pendingPhone createdAt lastLoginAt')
    .sort({ createdAt: 1 })
    .lean();

  const holders = new Map();
  for (const u of live) if (u.phone) holders.set(`${u.phone}|${u.role}`, u);

  const found = [];
  for (const u of live) {
    if (u.phone || !u.pendingPhone) continue;
    const holder = holders.get(`${u.pendingPhone}|${u.role}`);
    if (holder) found.push({ user: u, holder });
  }
  return found;
}

/**
 * One name holding one role on two different numbers.
 *
 * Reported only. See the note at the top: this is a prompt to look, not a
 * finding to act on.
 */
async function findSameNameSameRole() {
  const live = await User.find({ status: { $ne: 'deleted' } })
    .select('name role phone pendingPhone createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const normalise = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const groups = new Map();
  for (const u of live) {
    if (!normalise(u.name)) continue;
    const key = `${normalise(u.name)}|${u.role}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * What would be orphaned by deleting this account.
 *
 * A verified KYC record is counted as entanglement and an unverified one is
 * not, which is the one judgement encoded here. A verified record is the
 * outcome of a real penny drop against a real settlement account; an
 * abandoned one is a half-filled form, and on an unreachable account it can
 * never be completed — leaving it behind orphans somebody's bank details on a
 * row no screen will ever show again.
 */
async function findEntanglements(userId) {
  const [orders, payments, wallet, kycVerified, kycAbandoned, stalls, products] = await Promise.all([
    Order.countDocuments({
      $or: [
        { customer: userId },
        { assignedTo: userId },
        { shop: userId },
        { 'delivery.riderOffer.rider': userId },
      ],
    }),
    PaymentIntent.countDocuments({ user: userId }),
    WalletTransaction.countDocuments({ user: userId }),
    VendorKyc.countDocuments({ user: userId, status: 'verified' }),
    VendorKyc.countDocuments({ user: userId, status: { $ne: 'verified' } }),
    Stall.countDocuments({ owner: userId }),
    Product.countDocuments({ owner: userId }),
  ]);
  return { orders, payments, wallet, kycVerified, kycAbandoned, stalls, products };
}

/**
 * Zero means safe. `withAbandonedKyc` forgives an unverified KYC record and
 * nothing else — every other category still blocks.
 */
function entanglementTotal(tangles, { withAbandonedKyc = false } = {}) {
  const { kycAbandoned, ...rest } = tangles;
  return Object.values(rest).reduce((sum, n) => sum + n, 0) + (withAbandonedKyc ? 0 : kycAbandoned);
}

/**
 * Delete one account and the rows that exist only to serve its sessions.
 *
 * Refresh tokens and OTP challenges go with it — they are login machinery, not
 * records of anything. A verified KYC is never deleted, whatever the flags say:
 * the filter pins `status: { $ne: 'verified' }`, so the rule cannot be waived by
 * a caller passing the wrong argument.
 */
async function removeAccount(userId, { withAbandonedKyc = false } = {}) {
  const removed = { kyc: 0, refreshTokens: 0, otpChallenges: 0, users: 0 };
  if (withAbandonedKyc) {
    removed.kyc = (await VendorKyc.deleteMany({ user: userId, status: { $ne: 'verified' } }))
      .deletedCount;
  }
  removed.refreshTokens = (await RefreshToken.deleteMany({ user: userId })).deletedCount;
  removed.otpChallenges = (await OtpChallenge.deleteMany({ user: userId })).deletedCount;
  removed.users = (await User.deleteOne({ _id: userId })).deletedCount;
  return removed;
}

// --- CLI --------------------------------------------------------------------

function heading(text) {
  console.info(`\n${text}\n${'─'.repeat(text.length)}`);
}

function describe(u) {
  const number = u.phone || u.pendingPhone || '(no number)';
  return `${String(u._id)}  ${String(u.role).padEnd(13)} ${String(number).padEnd(12)} ${u.name || '(no name)'}`;
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const WITH_KYC = process.argv.includes('--with-abandoned-kyc');

  if (!config.mongoUri) {
    console.error('MONGODB_URI is not set. Nothing to connect to.');
    process.exitCode = 1;
    return;
  }

  const { connect, disconnect } = require('../db/connect');
  await connect(config.mongoUri);

  try {
    heading('Target');
    console.info(`  database: ${mongoose.connection.name}`);
    console.info(`  host:     ${mongoose.connection.host}`);
    console.info(`  mode:     ${APPLY ? 'APPLY — will delete' : 'report only — no writes'}`);

    await assertFiltersDiscriminate();

    const unreachable = await findUnreachable();
    heading(`Unreachable duplicates (${unreachable.length})`);
    if (unreachable.length === 0) console.info('  none');

    const safe = [];
    for (const { user, holder } of unreachable) {
      const tangles = await findEntanglements(user._id);
      const total = entanglementTotal(tangles, { withAbandonedKyc: WITH_KYC });
      console.info(`  ${describe(user)}`);
      console.info(`      duplicate of "${holder.name || '(no name)'}" (${holder._id}), which holds the number`);
      console.info(
        `      orders ${tangles.orders}  payments ${tangles.payments}  wallet ${tangles.wallet}` +
          `  kyc ${tangles.kycVerified}+${tangles.kycAbandoned}  stalls ${tangles.stalls}` +
          `  products ${tangles.products}`
      );
      if (total === 0) {
        safe.push(user);
        console.info('      => safe to delete');
      } else {
        console.info(
          `      => BLOCKED${tangles.kycVerified ? ' — KYC is verified, never sweep this' : ''}` +
            `${!WITH_KYC && tangles.kycAbandoned ? ' — abandoned KYC, pass --with-abandoned-kyc' : ''}`
        );
      }
    }

    const sameName = await findSameNameSameRole();
    heading(`Same name and role on different numbers (${sameName.length})`);
    if (sameName.length === 0) console.info('  none');
    for (const group of sameName) {
      console.info(`  "${group[0].name}" as ${group[0].role}:`);
      for (const u of group) console.info(`      ${describe(u)}`);
    }
    if (sameName.length > 0) {
      console.info('\n  Reported, never deleted. Two numbers are two people as far as this');
      console.info('  system can tell — there is no identity check anywhere in it — so a');
      console.info('  shared name is a prompt to look, not evidence. Decide by hand.');
    }

    if (!APPLY) {
      console.info(`\nReport only. Re-run with --apply to delete ${safe.length} unreachable account(s).`);
      return;
    }

    heading('Deleting');
    const totals = { kyc: 0, refreshTokens: 0, otpChallenges: 0, users: 0 };
    for (const user of safe) {
      const removed = await removeAccount(user._id, { withAbandonedKyc: WITH_KYC });
      for (const key of Object.keys(totals)) totals[key] += removed[key];
      console.info(`  ${describe(user)}`);
    }
    console.info(
      `\n  users ${totals.users}  abandoned KYC ${totals.kyc}` +
        `  refresh tokens ${totals.refreshTokens}  otp challenges ${totals.otpChallenges}`
    );
    console.info('\n  Anyone signed into a deleted row is signed out, and signing in again');
    console.info('  lands them on the account that holds the number — which is the one');
    console.info('  they should have reached all along.');
  } finally {
    await disconnect();
  }
}

module.exports = {
  assertFiltersDiscriminate,
  findUnreachable,
  findSameNameSameRole,
  findEntanglements,
  entanglementTotal,
  removeAccount,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFailed:', err?.message ?? err);
    process.exitCode = 1;
  });
}
