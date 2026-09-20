'use strict';

const mongoose = require('mongoose');

const optionalBpsField = {
  type: Number,
  default: null,
  min: 0,
  max: 10000,
  validate: {
    validator(v) {
      return v == null || Number.isInteger(v);
    },
    message: 'basis points must be an integer.',
  },
};

const marketSharePolicySchema = new mongoose.Schema(
  {
    market: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Market',
      required: true,
      unique: true,
    },
    platformBps: optionalBpsField,
    shopkeeperBps: optionalBpsField,
    deliveryBps: optionalBpsField,
    marketOwnerBps: optionalBpsField,
    customerIncentiveBps: optionalBpsField,
    promosEnabled: { type: Boolean, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

marketSharePolicySchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

module.exports = mongoose.model('MarketSharePolicy', marketSharePolicySchema);
