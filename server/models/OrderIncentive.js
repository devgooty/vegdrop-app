'use strict';

const mongoose = require('mongoose');

/**
 * Customer-incentive pool accrued on one order — accounting only until the
 * cashback wave credits wallets.
 *
 * `promosEnabled` snapshots whether promos were on for that order's market at
 * settlement time, so a later policy change cannot rewrite history.
 */
const orderIncentiveSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },

    amountPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'amountPaise must be an integer number of paise.',
      },
    },

    promosEnabled: { type: Boolean, required: true },

    /** When the customer took delivery — when the incentive was earmarked. */
    earnedAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

orderIncentiveSchema.index({ order: 1 }, { unique: true });

orderIncentiveSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
orderIncentiveSchema.virtual('amount').get(function amount() {
  return this.amountPaise / 100;
});

module.exports = mongoose.model('OrderIncentive', orderIncentiveSchema);
