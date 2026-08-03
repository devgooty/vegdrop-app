'use strict';

const mongoose = require('mongoose');
const fieldCrypto = require('../services/fieldCrypto');

/**
 * Vendor identity and settlement-account verification.
 *
 * A shopkeeper may hold the role without being able to trade: this record is the
 * gate. Until `status` reaches 'verified', middleware/vendorVerified.js refuses
 * every catalog write, so a self-registered account that never completes KYC can
 * list nothing and sell nothing.
 *
 * Storage rules:
 *  - PAN and bank account are encrypted (AES-256-GCM) and never leave the server
 *    in full. Only the last four digits are ever returned to a client.
 *  - Uniqueness is enforced on a keyed fingerprint, because the ciphertext is
 *    randomised and would defeat an index.
 *  - The penny-drop amount is stored as an HMAC, exactly like an OTP code. If it
 *    were stored in the clear, a database read would let anyone pass the check
 *    without ever seeing the bank statement.
 */

const STATUSES = Object.freeze([
  'draft',            // details submitted, nothing sent yet
  'penny_sent',       // transfer dispatched, awaiting the vendor's confirmation
  'verified',         // amount confirmed; catalog writes unlocked
  'rejected',         // too many wrong confirmations, or an operator declined
]);

const vendorKycSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    // Name exactly as printed on the PAN card. Compared against the beneficiary
    // name the bank returns, so a vendor cannot settle into someone else's account.
    legalName: { type: String, required: true, trim: true, maxlength: 120 },

    panEncrypted: { type: String, required: true, select: false },
    panLast4: { type: String, required: true, maxlength: 4 },
    // Unique: one PAN cannot back two vendor accounts.
    panFingerprint: { type: String, required: true, index: { unique: true } },

    bankAccountEncrypted: { type: String, required: true, select: false },
    bankAccountLast4: { type: String, required: true, maxlength: 4 },
    ifsc: { type: String, required: true, trim: true, uppercase: true, maxlength: 11 },

    upiVpa: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },
    // What the provider says the VPA belongs to, when it tells us.
    upiBeneficiaryName: { type: String, default: null, maxlength: 160 },

    status: { type: String, enum: STATUSES, default: 'draft', index: true },

    pennyDrop: {
      // HMAC of the amount, never the amount itself.
      amountHash: { type: String, default: null, select: false },
      referenceId: { type: String, default: null },
      providerRef: { type: String, default: null },
      utr: { type: String, default: null },
      sentAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
      maxAttempts: { type: Number, default: 5 },
    },

    verifiedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 300 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false, transform: stripSensitive },
    toObject: { virtuals: true, versionKey: false, transform: stripSensitive },
  }
);

/**
 * Defence in depth. `select: false` already keeps these out of a default query,
 * but an explicit `.select('+panEncrypted')` somewhere would otherwise serialise
 * straight through to a response.
 */
function stripSensitive(_doc, ret) {
  delete ret._id;
  delete ret.panEncrypted;
  delete ret.bankAccountEncrypted;
  delete ret.panFingerprint;
  if (ret.pennyDrop) delete ret.pennyDrop.amountHash;
  return ret;
}

vendorKycSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

vendorKycSchema.virtual('isVerified').get(function isVerified() {
  return this.status === 'verified';
});

/**
 * Client-facing shape. An explicit allowlist rather than deletion of known-bad
 * fields, so a future schema addition cannot leak by default.
 */
vendorKycSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toHexString(),
    legalName: this.legalName,
    // Masked to the last four, the most any receipt would show.
    pan: `XXXXX${this.panLast4}`,
    bankAccount: `••••${this.bankAccountLast4}`,
    ifsc: this.ifsc,
    upiVpa: this.upiVpa,
    upiBeneficiaryName: this.upiBeneficiaryName,
    status: this.status,
    isVerified: this.status === 'verified',
    pennyDrop: {
      sentAt: this.pennyDrop?.sentAt || null,
      expiresAt: this.pennyDrop?.expiresAt || null,
      attemptsRemaining: Math.max(0, (this.pennyDrop?.maxAttempts ?? 0) - (this.pennyDrop?.attempts ?? 0)),
    },
    verifiedAt: this.verifiedAt,
    rejectionReason: this.rejectionReason,
    updatedAt: this.updatedAt,
  };
};

/** Encrypt on the way in, so no caller has to remember to. */
vendorKycSchema.statics.buildSecrets = function buildSecrets({ pan, bankAccount }) {
  const normalizedPan = String(pan).trim().toUpperCase();
  const normalizedAccount = String(bankAccount).trim();

  return {
    panEncrypted: fieldCrypto.encrypt(normalizedPan),
    panLast4: normalizedPan.slice(-4),
    panFingerprint: fieldCrypto.fingerprint(normalizedPan),
    bankAccountEncrypted: fieldCrypto.encrypt(normalizedAccount),
    bankAccountLast4: normalizedAccount.slice(-4),
  };
};

const VendorKyc = mongoose.model('VendorKyc', vendorKycSchema);

module.exports = VendorKyc;
module.exports.STATUSES = STATUSES;
