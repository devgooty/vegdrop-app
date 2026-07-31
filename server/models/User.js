'use strict';

const mongoose = require('mongoose');

const ROLES = Object.freeze(['customer', 'delivery', 'shopkeeper', 'market_owner', 'developer']);

/** Roles permitted to self-register. Everything else is provisioned by an admin. */
const SELF_SERVICE_ROLES = Object.freeze(['customer']);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * VERIFIED contacts. Both are sparse-unique, and a value only ever lands
     * here once someone has proved they receive codes at it.
     *
     * That is the whole reason `phone` is no longer required. Registration has to
     * survive WhatsApp being unavailable, and the alternative — writing an
     * unproven number here — would reserve it: anyone could type a stranger's
     * number, take it out of circulation, and stop its real owner from ever
     * registering. An unproven number goes to `pendingPhone` below, which
     * reserves nothing.
     *
     * An account must end up with at least one of these; `hasVerifiedContact()`
     * is the check, and routes/auth.js refuses to create an account without one.
     */
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
      required: false,
      trim: true,
      index: { unique: true, sparse: true },
      maxlength: 20,
    },

    /**
     * A number the account claims but has not proved.
     *
     * Deliberately NOT unique and never a delivery destination: it is a delivery
     * contact for couriers and a convenience so the field is pre-filled when the
     * user retries verification. Two accounts may hold the same pendingPhone —
     * whoever verifies it first gets it, and it becomes `phone`.
     */
    pendingPhone: {
      type: String,
      required: false,
      trim: true,
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
    phone: this.phone || null,
    // Surfaced so the client can prompt to finish verifying a number that was
    // claimed while WhatsApp was unavailable.
    pendingPhone: this.pendingPhone || null,
    role: this.role,
    status: this.status,
    emailVerified: Boolean(this.emailVerifiedAt),
    phoneVerified: Boolean(this.phoneVerifiedAt),
    createdAt: this.createdAt,
  };
};

/**
 * Every destination a code may be delivered to, in preference order.
 *
 * Verified only, and that is load-bearing: a contact that receives codes is a way
 * into the account, so an unproven one must never appear here. `pendingPhone` is
 * deliberately absent.
 */
userSchema.methods.verifiedContacts = function verifiedContacts() {
  const contacts = [];
  if (this.phone && this.phoneVerifiedAt) contacts.push(this.phone);
  if (this.email && this.emailVerifiedAt) contacts.push(this.email);
  return contacts;
};

userSchema.methods.hasVerifiedContact = function hasVerifiedContact() {
  return this.verifiedContacts().length > 0;
};

/** The number to reach this person on, proven or not — couriers need one. */
userSchema.methods.contactPhone = function contactPhone() {
  return this.phone || this.pendingPhone || null;
};

const User = mongoose.model('User', userSchema);

module.exports = User;
module.exports.ROLES = ROLES;
module.exports.SELF_SERVICE_ROLES = SELF_SERVICE_ROLES;
