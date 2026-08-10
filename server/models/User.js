'use strict';

const mongoose = require('mongoose');

const ROLES = Object.freeze(['customer', 'delivery', 'shopkeeper', 'market_owner', 'developer']);

/** Roles permitted to self-register. Everything else is provisioned by an admin. */
const SELF_SERVICE_ROLES = Object.freeze(['customer']);

const geoPointSchema = require('./geoPoint');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * VERIFIED contacts. A value only ever lands here once someone has proved
     * they receive codes at it.
     *
     * That is the whole reason `phone` is no longer required. Registration has to
     * survive WhatsApp being unavailable, and the alternative — writing an
     * unproven number here — would reserve it: anyone could type a stranger's
     * number, take it out of circulation, and stop its real owner from ever
     * registering. An unproven number goes to `pendingPhone` below, which
     * reserves nothing.
     *
     * UNIQUE PER ROLE, NOT GLOBALLY — see the compound indexes below.
     *
     * One phone or email used to identify at most one account, full stop. That
     * meant a person could hold exactly one role in the whole system: a customer
     * who wanted to also run a stall or ride for the platform had to invent a
     * second phone number and a second inbox, because the vendor and delivery
     * self-registration routes refused any contact already claimed by ANY
     * account, including their own customer one.
     *
     * The identity that matters here is the contact, not the account — a phone
     * number is a person, and a person plausibly wants to shop, sell, and
     * deliver through the same one. So the uniqueness constraint moved from
     * `(email)` / `(phone)` to `(email, role)` / `(phone, role)`: one contact may
     * back at most one `customer` account, at most one `shopkeeper` account, at
     * most one `delivery` account — one per role, never two of the same role
     * fighting over one identity. `market_owner` and `developer` are never
     * self-registered, so this only ever bites the three self-service roles in
     * practice; it costs those two nothing.
     *
     * Each such account is a fully separate document with its own `_id`, own
     * order history, own duty status — there is no shared "profile" object above
     * them. Which one a sign-in resolves to is decided by which app asked (see
     * `APP_ROLE_SCOPE` in routes/auth.js), not by anything stored here.
     *
     * An account must end up with at least one of these; `hasVerifiedContact()`
     * is the check, and routes/auth.js refuses to create an account without one.
     */
    email: {
      type: String,
      required: false,
      trim: true,
      lowercase: true,
      index: true,
      maxlength: 254,
    },
    phone: {
      type: String,
      required: false,
      trim: true,
      index: true,
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
     * Delivery-agent state. Only meaningful for `role: 'delivery'`.
     *
     * Dispatch picks the rider nearest the market, so a live position is not a
     * nicety here — without it the engine has nobody to offer a pickup to. The
     * delivery app already runs a `watchPosition` while the agent is online; it
     * just never sent the result anywhere.
     */
    rider: {
      dutyStatus: {
        type: String,
        enum: ['offline', 'online', 'busy'],
        default: 'offline',
      },
      lastLocation: { type: geoPointSchema, default: undefined },
      /**
       * When that position was reported. Dispatch treats anything older than
       * `marketplace.riderStaleLocationSeconds` as gone, whatever dutyStatus
       * claims — an app killed by the OS never gets to say goodbye.
       */
      lastLocationAt: { type: Date, default: null },
    },

    /**
     * Independent-shop state. Only meaningful for `role: 'shopkeeper'`.
     *
     * A shopkeeper who trades at a market is reached THROUGH that market and is
     * never listed as a shop — see the exclusion in routes/shops.js. This is for
     * the ones who sell from their own premises, who until now had nowhere to
     * exist: Stall.market is required, so a market-less stall is impossible, and
     * Stall carries no coordinates of its own.
     */
    shop: {
      /**
       * What customers see. Copied from `name` when the pin is first set, and
       * never read through to `user.name` at response time — that keeps a
       * person's own name out of a public list by construction rather than by
       * remembering to project it out.
       */
      name: { type: String, default: '', trim: true, maxlength: 160 },
      address: { type: String, default: '', trim: true, maxlength: 500 },

      // `default: undefined` is load-bearing — see the comment in geoPoint.js.
      // A materialised empty coordinate array fails the 2dsphere build for the
      // whole collection, which would take rider dispatch down with it.
      location: { type: geoPointSchema, default: undefined },
      locationUpdatedAt: { type: Date, default: null },

      /** How far this shop will deliver. Mirrors Market.serviceRadiusMeters. */
      serviceRadiusMeters: { type: Number, default: 6000, min: 100, max: 50000 },

      /** Shutter switch. A closed shop is listed as closed, not hidden. */
      isOpen: { type: Boolean, default: true },
    },

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

/**
 * One contact, one account per role — see the long comment on `email` above.
 *
 * A PARTIAL filter rather than `sparse: true`, and the difference matters here.
 * `sparse` on a COMPOUND index only excludes a document when EVERY indexed
 * field is missing; a document with `email: null, role: 'customer'` would still
 * be indexed, and Mongo would then enforce uniqueness on `(null, 'customer')`
 * — silently blocking a second phone-only customer account from ever being
 * created, because to the index they'd look identical. The partial filter
 * excludes on `email` specifically, regardless of what `role` holds, which is
 * the exclusion actually wanted: no email, don't enforce, full stop.
 *
 * MIGRATION NOTE: this replaces the old single-field unique indexes on `email`
 * and `phone`. `db/connect.js` builds indexes with `createIndexes()`, not
 * `syncIndexes()`, specifically so a rollback cannot delete an index a newer
 * release added — which also means it will NOT drop the old ones on its own.
 * Declaring these compound indexes therefore changes NOTHING on a database that
 * still carries `email_1` / `phone_1`: both sets of indexes coexist, and the old
 * global-unique pair keeps vetoing a second-role registration with E11000 no
 * matter what this schema says.
 *
 * `db/migrations.js` → `migrateUserContactIndexes()` drops them, on every boot,
 * before `ensureIndexes()` runs. That is the ONLY thing that makes this
 * declaration take effect on an existing deployment; it is not an optimisation
 * and it must not be removed while any database predating this change survives.
 *
 * Do not "tidy up" the plain `index: true` on the two fields above either. Once
 * the legacy pair is gone, `createIndexes()` rebuilds them as NON-unique lookup
 * indexes, and that non-uniqueness is exactly what makes the migration
 * idempotent rather than a drop/recreate loop on every restart.
 */
userSchema.index(
  { email: 1, role: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);
userSchema.index(
  { phone: 1, role: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } }
);

/**
 * Required by the $geoNear stage that finds the rider nearest a market. Without
 * it that aggregation throws rather than degrading to a slow scan.
 */
userSchema.index({ 'rider.lastLocation': '2dsphere' });
/** Narrows the geo search to agents who are actually on duty. */
userSchema.index({ role: 1, 'rider.dutyStatus': 1 });

/**
 * Required by the $geoNear that finds shops near a customer.
 *
 * This is the SECOND 2dsphere index on this collection. MongoDB will not guess
 * between two of them: every $geoNear on User must now name its `key`
 * explicitly, or it fails outright at query time — not at index build, so it
 * surfaces as a broken feature rather than a failed deploy. services/dispatch.js
 * already passes `key: 'rider.lastLocation'`; routes/shops.js passes
 * `key: 'shop.location'`. Adding a third caller means doing the same.
 */
userSchema.index({ 'shop.location': '2dsphere' });

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
    // Duty status only — never the position. A rider's live coordinates are
    // dispatch input, not something to hand back out on a profile read.
    dutyStatus: this.role === 'delivery' ? this.rider?.dutyStatus || 'offline' : undefined,
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
