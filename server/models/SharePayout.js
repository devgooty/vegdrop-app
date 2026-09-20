'use strict';

const mongoose = require('mongoose');

/**
 * Hold-then-release payout for non-shopkeeper share buckets: delivery rider and
 * market owner.
 *
 * Mirrors the StallEarning lifecycle: created at delivery in `pending`, released
 * into the recipient's wallet after the hold window. The ledger entry is linked
 * through `walletTransaction` once money moves.
 */
const sharePayoutSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    bucket: {
      type: String,
      required: true,
      enum: ['delivery', 'marketOwner'],
    },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    amountPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer number of paise.',
      },
    },

    status: {
      type: String,
      required: true,
      enum: ['pending', 'released'],
      default: 'pending',
      index: true,
    },

    /** When the customer took delivery. The hold is measured from here. */
    earnedAt: { type: Date, required: true },
    /** When it becomes payable without asking. */
    releaseAt: { type: Date, required: true },
    releasedAt: { type: Date, default: null },

    /** The ledger entry that actually moved the money. */
    walletTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WalletTransaction',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/** One payout per bucket per order — replays collide instead of double-paying. */
sharePayoutSchema.index({ order: 1, bucket: 1 }, { unique: true });

/** The release sweep: everything due, oldest first. */
sharePayoutSchema.index({ status: 1, releaseAt: 1 });
/** Recipient earnings history. */
sharePayoutSchema.index({ recipient: 1, status: 1, earnedAt: -1 });

sharePayoutSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
sharePayoutSchema.virtual('amount').get(function amount() {
  return this.amountPaise / 100;
});

module.exports = mongoose.model('SharePayout', sharePayoutSchema);
