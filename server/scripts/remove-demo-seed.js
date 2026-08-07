'use strict';

/**
 * Remove demo seed data from a database that should never have had it.
 *
 * `seedIfEmpty()` skips only when `config.isProduction`. A deployment running
 * with NODE_ENV unset or `development` but pointed at a real MONGODB_URI will
 * therefore seed that real database — which is exactly what happened here. The
 * result is live accounts with **no passwords**, including one holding the
 * `developer` role, which bypasses the vendor KYC gate and every role check in
 * the admin panels.
 *
 * Usage:
 *
 *   node server/scripts/remove-demo-seed.js            # dry run, changes nothing
 *   node server/scripts/remove-demo-seed.js --apply    # actually delete
 *   node server/scripts/remove-demo-seed.js --apply --force
 *
 * Dry run is the default on purpose: this points at whatever MONGODB_URI is in
 * the environment, and the whole reason this script exists is that something
 * pointed at the wrong database once already.
 *
 * What it will NOT do without --force: delete anything a real order, payment,
 * wallet entry, KYC record or earning refers to. A demo account that has traded
 * is no longer only demo data — deleting it orphans rows that reference it, and
 * a dangling `customer` on an order is worse than a stale account you can
 * demote by hand. Entanglement is reported, then the script stops.
 *
 * The finding and deleting are exported separately from the CLI wrapper so
 * server/test/removeDemoSeed.test.js can exercise them against a real database.
 * A script that deletes production data on the strength of "it looked right"
 * is not one to run untested.
 */

const config = require('../config/env');

const User = require('../models/User');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const StallPhoto = require('../models/StallPhoto');
const StallEarning = require('../models/StallEarning');
const Order = require('../models/Order');
const PaymentIntent = require('../models/PaymentIntent');
const WalletTransaction = require('../models/WalletTransaction');
const VendorKyc = require('../models/VendorKyc');
const RefreshToken = require('../models/RefreshToken');
const OtpChallenge = require('../models/OtpChallenge');

const { SEED_ACCOUNTS, SEED_PRODUCTS, SEED_MARKETS, SEED_STALLS } = require('../utils/seed');

/**
 * Everything the seeder created that is still present.
 *
 * Identified from the seeder's own constants, so the two cannot drift apart —
 * a hand-maintained list would stop matching the moment either side changed.
 *
 * @returns {Promise<{users, products, markets, stalls, userIds, productIds, marketIds, stallIds}>}
 */
async function plan() {
  /**
   * Users are matched on phone AND email together.
   *
   * Either alone is too loose. `9000000001` sits in a reserved range and is
   * unlikely to belong to anyone, but "unlikely" is not a basis for deleting an
   * account — a real person who somehow held that number would have their own
   * email address, and the pair would not match.
   */
  const users = await User.find({
    $or: SEED_ACCOUNTS.map((account) => ({ phone: account.phone, email: account.email })),
  })
    .select('_id name email phone role createdAt')
    .lean();

  /**
   * Products are matched on sku AND `owner: null`.
   *
   * The owner check matters: a real shopkeeper's listing carries their id, and
   * the sku index is globally unique, so a vendor who happened to reuse one of
   * these skus is excluded here rather than losing a product.
   */
  const products = await Product.find({
    sku: { $in: SEED_PRODUCTS.map((p) => p.sku) },
    owner: null,
  })
    .select('_id sku name')
    .lean();

  const markets = await Market.find({ slug: { $in: SEED_MARKETS.map((m) => m.slug) } })
    .select('_id name slug')
    .lean();

  const userIds = users.map((u) => u._id);
  const marketIds = markets.map((m) => m._id);

  const stalls =
    marketIds.length && userIds.length
      ? await Stall.find({
          market: { $in: marketIds },
          stallNumber: { $in: SEED_STALLS.map((s) => s.stallNumber) },
          owner: { $in: userIds },
        })
          .select('_id stallNumber name market owner')
          .lean()
      : [];

  return {
    users,
    products,
    markets,
    stalls,
    userIds,
    productIds: products.map((p) => p._id),
    marketIds,
    stallIds: stalls.map((s) => s._id),
  };
}

/**
 * Real rows that would be orphaned by deleting the plan.
 *
 * Counted rather than fetched — this needs a go/no-go answer and a number to
 * print, not the documents.
 */
async function findEntanglements({ userIds, stallIds, marketIds, productIds }) {
  const [orders, payments, wallet, kyc, earnings, otherStalls, otherInventory] = await Promise.all([
    /**
     * Note the paths. An order's stall references live INSIDE `items` —
     * `items[].claim.stall` is the stall that committed to a line and
     * `items[].offer.stall` is the one it was addressed to. There is no
     * top-level `stall`, and the line array is `items`, not `lines`.
     *
     * Querying the wrong path here is silent: Mongo matches nothing, the count
     * comes back 0, and the script reports "safe to delete" over an order the
     * demo stall actually claimed.
     */
    Order.countDocuments({
      $or: [
        { customer: { $in: userIds } },
        { shop: { $in: userIds } },
        { assignedTo: { $in: userIds } },
        { market: { $in: marketIds } },
        { 'items.claim.stall': { $in: stallIds } },
        { 'items.offer.stall': { $in: stallIds } },
        { 'items.product': { $in: productIds } },
      ],
    }),
    PaymentIntent.countDocuments({ user: { $in: userIds } }),
    WalletTransaction.countDocuments({ user: { $in: userIds } }),
    VendorKyc.countDocuments({ user: { $in: userIds } }),
    StallEarning.countDocuments({
      $or: [{ shop: { $in: userIds } }, { stall: { $in: stallIds } }],
    }),
    /**
     * A stall inside a demo market that this script would NOT delete — i.e. one
     * a real shopkeeper was approved into. Removing the market from under them
     * breaks their account, so it counts as entanglement too.
     */
    Stall.countDocuments({ market: { $in: marketIds }, _id: { $nin: stallIds } }),
    StallInventory.countDocuments({ market: { $in: marketIds }, stall: { $nin: stallIds } }),
  ]);

  return { orders, payments, wallet, kyc, earnings, otherStalls, otherInventory };
}

/** Total across every entanglement category. Zero means safe to delete. */
function entanglementTotal(tangles) {
  return Object.values(tangles).reduce((sum, n) => sum + n, 0);
}

/**
 * Delete the plan, children before parents.
 *
 * Ordered so a failure part-way through never leaves a surviving row pointing
 * at something already gone.
 *
 * @returns {Promise<Array<[string, number]>>} label and count per step
 */
async function remove({ userIds, productIds, marketIds, stallIds }) {
  const steps = [
    ['stall photos', () => StallPhoto.deleteMany({ stall: { $in: stallIds } })],
    ['stall inventory', () => StallInventory.deleteMany({ stall: { $in: stallIds } })],
    ['stall earnings', () => StallEarning.deleteMany({ stall: { $in: stallIds } })],
    ['stalls', () => Stall.deleteMany({ _id: { $in: stallIds } })],
    ['market prices', () => MarketPrice.deleteMany({ market: { $in: marketIds } })],
    ['markets', () => Market.deleteMany({ _id: { $in: marketIds } })],
    ['products', () => Product.deleteMany({ _id: { $in: productIds } })],
    /**
     * Sessions and pending codes go before the users they belong to. An OTP
     * challenge outliving its account is a live credential for nothing, and a
     * refresh token would survive to be presented against a missing user.
     */
    ['refresh tokens', () => RefreshToken.deleteMany({ user: { $in: userIds } })],
    ['otp challenges', () => OtpChallenge.deleteMany({ user: { $in: userIds } })],
    ['users', () => User.deleteMany({ _id: { $in: userIds } })],
  ];

  const results = [];
  for (const [label, run] of steps) {
    const result = await run();
    results.push([label, result.deletedCount]);
  }
  return results;
}

// --- CLI --------------------------------------------------------------------

function heading(text) {
  console.info(`\n${text}\n${'─'.repeat(text.length)}`);
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const FORCE = process.argv.includes('--force');

  if (!config.mongoUri) {
    console.error('MONGODB_URI is not set. Nothing to connect to.');
    process.exitCode = 1;
    return;
  }

  const { connect, disconnect, mongoose } = require('../db/connect');
  await connect(config.mongoUri);

  try {
    // Name the database this is about to touch. Not knowing that is what
    // caused the mess this script cleans up.
    heading('Target');
    console.info(`  database: ${mongoose.connection.name}`);
    console.info(`  host:     ${mongoose.connection.host}`);
    console.info(`  NODE_ENV: ${config.NODE_ENV}`);
    console.info(`  mode:     ${APPLY ? 'APPLY — will delete' : 'dry run — no writes'}`);

    const found = await plan();

    heading('Demo data found');
    console.info(`  users:    ${found.users.length}`);
    for (const u of found.users) {
      console.info(`    ${u.role.padEnd(13)} ${u.phone}  ${u.email}`);
    }
    console.info(`  products: ${found.products.length}  ${found.products.map((p) => p.sku).join(', ') || '—'}`);
    console.info(`  markets:  ${found.markets.length}  ${found.markets.map((m) => m.slug).join(', ') || '—'}`);
    console.info(`  stalls:   ${found.stalls.length}  ${found.stalls.map((s) => s.stallNumber).join(', ') || '—'}`);

    const nothing =
      !found.users.length && !found.products.length && !found.markets.length && !found.stalls.length;
    if (nothing) {
      console.info('\nNothing to do — no demo seed data in this database.');
      return;
    }

    const tangles = await findEntanglements(found);
    const total = entanglementTotal(tangles);

    heading('Real data referring to it');
    console.info(`  orders:                    ${tangles.orders}`);
    console.info(`  payment intents:           ${tangles.payments}`);
    console.info(`  wallet entries:            ${tangles.wallet}`);
    console.info(`  vendor KYC records:        ${tangles.kyc}`);
    console.info(`  stall earnings:            ${tangles.earnings}`);
    console.info(`  non-demo stalls in market: ${tangles.otherStalls}`);
    console.info(`  their inventory rows:      ${tangles.otherInventory}`);

    if (total > 0 && !FORCE) {
      console.error(
        `\nSTOPPING: ${total} real row(s) refer to this demo data.\n` +
          'Deleting now would leave them pointing at nothing. Options:\n' +
          '  - Deal with those rows first (refund/close the orders, move the stalls), or\n' +
          '  - Demote the accounts by hand instead: set role to `customer` and bump\n' +
          '    tokenVersion, which revokes access without destroying history, or\n' +
          '  - Re-run with --force if you have decided the orphans are acceptable.'
      );
      process.exitCode = 1;
      return;
    }

    if (!APPLY) {
      console.info('\nDry run complete. Re-run with --apply to delete the rows listed above.');
      return;
    }

    heading('Deleting');
    for (const [label, count] of await remove(found)) {
      console.info(`  ${label.padEnd(16)} ${count}`);
    }

    heading('Done');
    console.info('  Re-run without --apply to confirm nothing is left.');
    console.info('  Then set NODE_ENV=production so seeding can never run here again.');
  } finally {
    await disconnect();
  }
}

module.exports = { plan, findEntanglements, entanglementTotal, remove };

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFailed:', err?.message ?? err);
    process.exitCode = 1;
  });
}
