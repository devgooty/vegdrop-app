'use strict';

const mongoose = require('mongoose');

/**
 * What a stall is owed for one order.
 *
 * Created at the moment the customer takes delivery — never before. A stall
 * that accepted and packed an order that was then cancelled is owed nothing,
 * because nothing was sold.
 *
 * From there the money is HELD (`pending`) for a configurable window, then
 * released into the shopkeeper's wallet automatically. The hold exists because
 * a delivery can still go wrong after it lands, and unpaid money is far easier
 * to withhold than paid money is to recover.
 *
 * This is a record of an obligation, not the money itself. The money is the
 * WalletTransaction written when this is released, and that transaction's
 * idempotency key is derived from this document's id — so a stall cannot be
 * paid twice for the same order no matter how many times the release runs.
 */
const earningLineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1 },
    // The market's price, which is what the stall is paid — not the customer's
    // locked price, which can differ once an order has hopped markets.
    unitPricePaise: { type: Number, required: true, min: 0 },
    lineTotalPaise: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const stallEarningSchema = new mongoose.Schema(
  {
    stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', required: true, index: true },
    stallNumber: { type: String, default: null, maxlength: 24 },
    /**
     * The shopkeeper who gets paid, denormalised from the stall.
     *
     * Held here rather than looked up at release time on purpose: if a stall
     * changes hands, money earned under the previous owner must still go to the
     * previous owner.
     */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true, maxlength: 40 },

    lines: { type: [earningLineSchema], required: true },

    grossPaise: { type: Number, required: true, min: 0 },
    commissionPaise: { type: Number, required: true, min: 0, default: 0 },
    /** What actually reaches the wallet. gross − commission. */
    netPaise: { type: Number, required: true, min: 0 },

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
    /** True when the shopkeeper asked for it before the hold expired. */
    releasedEarly: { type: Boolean, default: false },

    /** The ledger entry that actually moved the money. */
    walletTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/**
 * One earning per stall per order.
 *
 * This is the guard that makes recording idempotent: a redelivered or replayed
 * completion collides on the index instead of creating a second obligation.
 */
stallEarningSchema.index({ order: 1, stall: 1 }, { unique: true });

/** The release sweep: everything due, oldest first. */
stallEarningSchema.index({ status: 1, releaseAt: 1 });
/** The shopkeeper's own earnings screen. */
stallEarningSchema.index({ owner: 1, status: 1, earnedAt: -1 });

stallEarningSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
stallEarningSchema.virtual('net').get(function net() {
  return this.netPaise / 100;
});

module.exports = mongoose.model('StallEarning', stallEarningSchema);
