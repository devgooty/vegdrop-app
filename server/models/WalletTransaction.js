'use strict';

const mongoose = require('mongoose');

/**
 * Append-only wallet ledger. Balance is derived by summing signed amounts, never
 * stored as a mutable field, so a lost update cannot silently create money.
 *
 * All amounts are INTEGER PAISE. Representing currency as a float invites
 * rounding drift that shows up as unreconcilable balances.
 */
const walletTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, required: true, enum: ['credit', 'debit'], index: true },

    // Always positive; `type` carries the sign.
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer number of paise.',
      },
    },

    // Running balance after this entry, for audit and O(1) statement rendering.
    balanceAfterPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'balanceAfterPaise must be an integer number of paise.',
      },
    },

    /**
     * Position in this user's ledger, starting at 1.
     *
     * This is what actually serialises writes. Deriving a balance means
     * read-then-insert, and two concurrent debits can both read the same tail,
     * both pass their own sufficiency check, and both insert — snapshot
     * isolation does not catch it, because neither transaction modifies the row
     * it read, so there is no write conflict to detect. The unique index below
     * turns that second insert into a collision instead of an overdraft.
     */
    seq: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'seq must be an integer.',
      },
    },

    reason: {
      type: String,
      required: true,
      enum: [
        'razorpay_topup',
        'order_payment',
        'order_refund',
        'promotional_credit',
        'admin_adjustment',
        // A stall being paid for goods it supplied, once the order reached the
        // customer. See services/settlement.js — the money is held for a day
        // first, so this entry lands well after the order was delivered.
        'stall_settlement',
      ],
    },

    /**
     * Uniqueness key that makes crediting idempotent. For Razorpay top-ups this
     * is the payment id, so a replayed webhook or double-submitted verification
     * collides on the unique index instead of crediting twice.
     */
    idempotencyKey: { type: String, required: true, unique: true, index: true },

    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },

    note: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: true }
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });

/**
 * Partial rather than plain unique: entries written before `seq` existed have no
 * value for it, and several of those per user would collide with each other on a
 * full unique index. Restricting the index to documents that actually carry a
 * numeric seq lets it be added to a populated collection without a backfill.
 */
walletTransactionSchema.index(
  { user: 1, seq: 1 },
  { unique: true, partialFilterExpression: { seq: { $type: 'number' } } }
);

/**
 * The tail of a user's ledger: the entry the next one must build on.
 *
 * Ordered by seq first. `createdAt` alone is not a reliable tiebreak — two
 * entries can share a millisecond — and it is only consulted here for legacy
 * entries that predate seq, which sort last under a descending sort because
 * missing fields compare below numbers.
 *
 * @returns {Promise<{ balanceAfterPaise: number, seq?: number } | null>}
 */
walletTransactionSchema.statics.latestFor = async function latestFor(userId, session) {
  const query = this.findOne({ user: userId })
    .sort({ seq: -1, createdAt: -1, _id: -1 })
    .select('balanceAfterPaise seq');
  if (session) query.session(session);
  return query.lean();
};

walletTransactionSchema.statics.currentBalancePaise = async function currentBalancePaise(userId, session) {
  const latest = await this.latestFor(userId, session);
  return latest ? latest.balanceAfterPaise : 0;
};

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
