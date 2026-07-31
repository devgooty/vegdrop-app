'use strict';

const WalletTransaction = require('../models/WalletTransaction');
const { ApiError } = require('../middleware/errors');

/**
 * Wallet operations against the append-only ledger.
 *
 * The balance was previously a number in browser localStorage, editable from
 * devtools. It is now derived exclusively from ledger entries the server wrote.
 *
 * Idempotency is structural: every entry carries a unique `idempotencyKey`, so a
 * replayed Razorpay verification collides on the unique index and is reported as
 * the original success rather than crediting twice.
 */

async function getBalancePaise(userId, session = null) {
  return WalletTransaction.currentBalancePaise(userId, session);
}

async function listTransactions(userId, { limit = 50, before = null } = {}) {
  const filter = { user: userId };
  if (before) filter.createdAt = { $lt: before };

  return WalletTransaction.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(limit, 200))
    .lean();
}

/**
 * How many times to recompute against a moved tail before giving up. Reached only
 * under sustained concurrent writes for one user, which a single person cannot
 * produce; a low ceiling is preferable to spinning.
 */
const MAX_APPEND_ATTEMPTS = 5;

/**
 * Append one entry, deriving its balance and position from the current tail.
 *
 * WHY THIS IS A LOOP AND NOT A READ FOLLOWED BY AN INSERT
 *
 * Deriving the balance means read-then-insert, which is write skew: two
 * concurrent debits both read the same tail, both pass their own sufficiency
 * check, and both insert. A transaction does not prevent that on its own —
 * snapshot isolation detects conflicts on a shared *document*, and here each
 * writer inserts a different one. The unique {user, seq} index is what forces a
 * collision; this loop is what turns the collision into a correct entry rather
 * than a failed request.
 *
 * @param {(ctx: { currentPaise: number, seq: number }) => object} build
 *   Produces the document to insert. Called once per attempt, so any balance
 *   check inside it is made against the tail this attempt will actually extend.
 */
async function appendEntry({ userId, idempotencyKey, build, session }) {
  const replayed = await findByIdempotencyKey(idempotencyKey, session);
  if (replayed) {
    return { transaction: replayed, balancePaise: replayed.balanceAfterPaise, replayed: true };
  }

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const tail = await WalletTransaction.latestFor(userId, session);
    const currentPaise = tail ? tail.balanceAfterPaise : 0;
    const seq = (Number.isInteger(tail?.seq) ? tail.seq : 0) + 1;

    const doc = build({ currentPaise, seq });

    try {
      const [created] = await WalletTransaction.create(
        [{ ...doc, user: userId, seq, idempotencyKey }],
        session ? { session } : {}
      );
      return { transaction: created.toObject(), balancePaise: doc.balanceAfterPaise, replayed: false };
    } catch (err) {
      if (err?.code !== 11000) throw err;

      // The idempotency key collided: an identical entry was written concurrently.
      // Report the winner rather than double-applying it.
      const winner = await findByIdempotencyKey(idempotencyKey, session);
      if (winner) {
        return { transaction: winner, balancePaise: winner.balanceAfterPaise, replayed: true };
      }

      /**
       * The {user, seq} index collided instead: a different entry landed between
       * our read and our insert.
       *
       * Inside a transaction, retrying here is pointless — reads are served from
       * a snapshot fixed when the transaction began, so the tail would come back
       * unchanged and the loop would spin until it exhausted its attempts. Fail
       * instead and let the caller's transaction be retried as a whole, which is
       * what the driver already does for the more common WriteConflict form of
       * this race.
       */
      if (session) {
        throw new ApiError(409, 'Wallet was updated concurrently. Please try again.', 'WALLET_CONFLICT');
      }
    }
  }

  throw new ApiError(409, 'Wallet was updated concurrently. Please try again.', 'WALLET_CONFLICT');
}

/**
 * @returns {Promise<{ transaction: object, balancePaise: number, replayed: boolean }>}
 */
async function credit({ userId, amountPaise, reason, idempotencyKey, razorpayOrderId = null, razorpayPaymentId = null, note = null, session = null }) {
  assertAmount(amountPaise);

  return appendEntry({
    userId,
    idempotencyKey,
    session,
    build: ({ currentPaise }) => ({
      type: 'credit',
      amountPaise,
      balanceAfterPaise: currentPaise + amountPaise,
      reason,
      razorpayOrderId,
      razorpayPaymentId,
      note,
    }),
  });
}

/**
 * @throws {ApiError} 402 when the balance is insufficient.
 */
async function debit({ userId, amountPaise, reason, idempotencyKey, order = null, note = null, session = null }) {
  assertAmount(amountPaise);

  return appendEntry({
    userId,
    idempotencyKey,
    session,
    build: ({ currentPaise }) => {
      // Re-checked on every attempt: a balance that was sufficient against the
      // tail we first read may not be against the one that replaced it.
      if (currentPaise < amountPaise) {
        throw new ApiError(
          402,
          `Insufficient wallet balance. Available ₹${(currentPaise / 100).toFixed(2)}, required ₹${(amountPaise / 100).toFixed(2)}.`,
          'INSUFFICIENT_FUNDS'
        );
      }

      return {
        type: 'debit',
        amountPaise,
        balanceAfterPaise: currentPaise - amountPaise,
        reason,
        order,
        note,
      };
    },
  });
}

async function findByIdempotencyKey(idempotencyKey, session = null) {
  const query = WalletTransaction.findOne({ idempotencyKey });
  if (session) query.session(session);
  return query.lean();
}

function assertAmount(amountPaise) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new ApiError(400, 'Amount must be a positive whole number of paise.', 'INVALID_AMOUNT');
  }
  // Ceiling guards against an overflow or a misplaced decimal draining an account.
  if (amountPaise > 100_000_00) {
    throw new ApiError(400, 'Amount exceeds the ₹100,000 per-transaction limit.', 'AMOUNT_TOO_LARGE');
  }
}

module.exports = { getBalancePaise, listTransactions, credit, debit };
