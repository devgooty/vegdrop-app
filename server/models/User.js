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

    // There is no password field. Authentication is a one-time code delivered to
    // the phone number above — see routes/auth.js. Accounts created before that
    // change may still carry a `passwordHash` in MongoDB; it is absent from this
    // schema, so nothing reads it and it never reaches a response.

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

    /**
     * Bumped to invalidate every outstanding access token for this user
     * (forced logout, role change, suspension).
     */
    tokenVersion: { type: Number, default: 0 },

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
  // Defensive: `passwordHash` is no longer in the schema, so a legacy document's
  // copy is dropped on read. Deleting it here too costs nothing and means a
  // future `strict: false` could not turn it into a leak.
  delete ret.passwordHash;
  return ret;
}

userSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
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
