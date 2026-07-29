'use strict';

const mongoose = require('mongoose');

const ROLES = Object.freeze(['customer', 'delivery', 'shopkeeper', 'market_owner', 'developer']);

/** Roles permitted to self-register. Everything else is provisioned by an admin. */
const SELF_SERVICE_ROLES = Object.freeze(['customer']);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    // Sparse + unique: a user may register with phone only.
    email: {
      type: String,
      required: false,
      trim: true,
      lowercase: true,
      index: { unique: true, sparse: true },
      maxlength: 254,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
      maxlength: 20,
    },

    passwordHash: { type: String, required: true, select: false },

    // Role is never accepted from a request body — see routes/auth.js.
    role: { type: String, enum: ROLES, default: 'customer', index: true },

    status: {
      type: String,
      enum: ['active', 'suspended', 'deleted'],
      default: 'active',
      index: true,
    },

    emailVerifiedAt: { type: Date, default: null },
    phoneVerifiedAt: { type: Date, default: null },

    // Brute-force controls.
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },

    /**
     * Bumped to invalidate every outstanding access token for this user
     * (password change, forced logout, role change, suspension).
     */
    tokenVersion: { type: Number, default: 0 },

    passwordChangedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false, transform: stripSensitive },
    toObject: { virtuals: true, versionKey: false, transform: stripSensitive },
  }
);

function stripSensitive(_doc, ret) {
  delete ret._id;
  delete ret.passwordHash;
  delete ret.failedLoginAttempts;
  delete ret.lockedUntil;
  return ret;
}

userSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

userSchema.virtual('isLocked').get(function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil.getTime() > Date.now());
});

/**
 * Shape sent to clients. Explicit allowlist rather than deletion of known-bad
 * fields, so a future schema addition cannot leak by default.
 */
userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toHexString(),
    name: this.name,
    email: this.email || null,
    phone: this.phone,
    role: this.role,
    status: this.status,
    emailVerified: Boolean(this.emailVerifiedAt),
    phoneVerified: Boolean(this.phoneVerifiedAt),
    createdAt: this.createdAt,
  };
};

const User = mongoose.model('User', userSchema);

module.exports = User;
module.exports.ROLES = ROLES;
module.exports.SELF_SERVICE_ROLES = SELF_SERVICE_ROLES;
