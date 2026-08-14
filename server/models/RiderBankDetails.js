'use strict';

const mongoose = require('mongoose');
const fieldCrypto = require('../services/fieldCrypto');

/**
 * A delivery rider's settlement account.
 *
 * There is no rider payout ledger in this codebase (see DeliveryPanel.jsx) —
 * the market office settles what a rider is owed outside the app. This record
 * exists so those details are on file rather than collected ad hoc over phone
 * calls; it gates nothing and is not verified the way VendorKyc is, because
 * nothing here unlocks a capability the way catalog writes do for a vendor.
 */
const riderBankDetailsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // As it appears on the rider's PAN card, so it can be matched against the
    // bank account by whoever settles payouts manually.
    legalName: { type: String, required: true, trim: true, maxlength: 120 },
    bankName: { type: String, required: true, trim: true, maxlength: 120 },
    bankAccountEncrypted: { type: String, required: true, select: false },
    bankAccountLast4: { type: String, required: true, maxlength: 4 },
    ifsc: { type: String, required: true, trim: true, uppercase: true, maxlength: 11 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false, transform: stripSensitive },
    toObject: { virtuals: true, versionKey: false, transform: stripSensitive },
  }
);

/**
 * Defence in depth. `select: false` already keeps this out of a default query,
 * but an explicit `.select('+bankAccountEncrypted')` somewhere would otherwise
 * serialise straight through to a response.
 */
function stripSensitive(_doc, ret) {
  delete ret._id;
  delete ret.bankAccountEncrypted;
  return ret;
}

riderBankDetailsSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/** Never returns the account number in full — only the last four digits. */
riderBankDetailsSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    legalName: this.legalName,
    bankName: this.bankName,
    bankAccount: `••••${this.bankAccountLast4}`,
    ifsc: this.ifsc,
    updatedAt: this.updatedAt,
  };
};

riderBankDetailsSchema.statics.buildSecrets = function buildSecrets({ bankAccount }) {
  const normalizedAccount = String(bankAccount).trim();
  return {
    bankAccountEncrypted: fieldCrypto.encrypt(normalizedAccount),
    bankAccountLast4: normalizedAccount.slice(-4),
  };
};

module.exports = mongoose.model('RiderBankDetails', riderBankDetailsSchema);
