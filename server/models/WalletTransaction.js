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

    reason: {
      type: String,
      required: true,
      enum: [
        'razorpay_topup',
        'order_payment',
        'order_refund',
        /**
         * A multi-stall order takes the money as a hold at checkout and releases
         * it in full if any stall declines. Distinct reasons from
         * payment/refund so a released hold is not reported to the customer as a
         * refund for a purchase that never happened.
         */
        'order_hold',
        'order_hold_release',
        'promotional_credit',
        'admin_adjustment',
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

walletTransactionSchema.statics.currentBalancePaise = async function currentBalancePaise(userId, session) {
  const query = this.findOne({ user: userId }).sort({ createdAt: -1, _id: -1 }).select('balanceAfterPaise');
  if (session) query.session(session);
  const latest = await query.lean();
  return latest ? latest.balanceAfterPaise : 0;
};

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
