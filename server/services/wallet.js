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
 * @returns {Promise<{ transaction: object, balancePaise: number, replayed: boolean }>}
 */
async function credit({ userId, amountPaise, reason, idempotencyKey, razorpayOrderId = null, razorpayPaymentId = null, note = null, session = null }) {
  assertAmount(amountPaise);

  const existing = await findByIdempotencyKey(idempotencyKey, session);
  if (existing) {
    return { transaction: existing, balancePaise: existing.balanceAfterPaise, replayed: true };
  }

  const current = await getBalancePaise(userId, session);
  const next = current + amountPaise;

  try {
    const [created] = await WalletTransaction.create(
      [{
        user: userId,
        type: 'credit',
        amountPaise,
        balanceAfterPaise: next,
        reason,
        idempotencyKey,
        razorpayOrderId,
        razorpayPaymentId,
        note,
      }],
      session ? { session } : {}
    );
    return { transaction: created.toObject(), balancePaise: next, replayed: false };
  } catch (err) {
    // Lost the race against a concurrent identical credit: treat as a replay.
    if (err?.code === 11000) {
      const winner = await findByIdempotencyKey(idempotencyKey, session);
      if (winner) {
        return { transaction: winner, balancePaise: winner.balanceAfterPaise, replayed: true };
      }
    }
    throw err;
  }
}

/**
 * @throws {ApiError} 402 when the balance is insufficient.
 */
async function debit({ userId, amountPaise, reason, idempotencyKey, order = null, note = null, session = null }) {
  assertAmount(amountPaise);

  const existing = await findByIdempotencyKey(idempotencyKey, session);
  if (existing) {
    return { transaction: existing, balancePaise: existing.balanceAfterPaise, replayed: true };
  }

  const current = await getBalancePaise(userId, session);
  if (current < amountPaise) {
    throw new ApiError(
      402,
      `Insufficient wallet balance. Available ₹${(current / 100).toFixed(2)}, required ₹${(amountPaise / 100).toFixed(2)}.`,
      'INSUFFICIENT_FUNDS'
    );
  }

  const next = current - amountPaise;

  const [created] = await WalletTransaction.create(
    [{
      user: userId,
      type: 'debit',
      amountPaise,
      balanceAfterPaise: next,
      reason,
      idempotencyKey,
      order,
      note,
    }],
    session ? { session } : {}
  );

  return { transaction: created.toObject(), balancePaise: next, replayed: false };
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
