'use strict';

const mongoose = require('mongoose');

/**
 * The platform's share of one delivered order — one row per order for audit and KPI.
 *
 * Written at delivery alongside other share buckets. A replay collides on the
 * unique `order` index instead of double-counting revenue.
 */
const platformEarningSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true, maxlength: 40 },

    /** The market the order cleared through, when there was one. Null for independent shops. */
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', default: null },

    amountPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer number of paise.',
      },
    },

    /** When the customer took delivery — the moment the platform share was earned. */
    earnedAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

platformEarningSchema.index({ order: 1 }, { unique: true });

platformEarningSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
platformEarningSchema.virtual('amount').get(function amount() {
  return this.amountPaise / 100;
});

module.exports = mongoose.model('PlatformEarning', platformEarningSchema);
