'use strict';

const mongoose = require('mongoose');
const { assertBpsSum } = require('../services/sharePolicy');

const bpsField = {
  type: Number,
  required: true,
  min: 0,
  max: 10000,
  validate: { validator: Number.isInteger, message: 'basis points must be an integer.' },
};

const platformSharePolicySchema = new mongoose.Schema(
  {
    platformBps: bpsField,
    shopkeeperBps: bpsField,
    deliveryBps: bpsField,
    marketOwnerBps: bpsField,
    customerIncentiveBps: bpsField,
    promosEnabled: { type: Boolean, required: true, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

platformSharePolicySchema.pre('validate', function enforceBpsSum() {
  assertBpsSum(this);
});

platformSharePolicySchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

module.exports = mongoose.model('PlatformSharePolicy', platformSharePolicySchema);
