'use strict';

const mongoose = require('mongoose');

/**
 * A pending REVERSE one-time-code challenge.
 *
 * The ordinary `OtpChallenge` proves someone can RECEIVE at a number: we send a
 * code there and they read it back. This proves the opposite direction — that
 * they can SEND from it. We show the code, they message it to our inbox from
 * their own phone, and an inbound webhook checks the sender.
 *
 * WHAT ACTUALLY GATES VERIFICATION
 *
 * Not the code. The code is displayed on screen and travels through the user's
 * own messaging app; it is a session binder and a freshness token, not a secret.
 * What proves the claim is that the message arrived FROM the number being
 * claimed, attested by the inbound channel. The code only decides *which*
 * pending session an arriving message belongs to, and stops a message sent
 * yesterday from settling a login started today.
 *
 * That is why `codeHash` is an HMAC of the code alone, with no per-challenge
 * salt — unlike `services/otp.js`, which mixes the challenge id into the
 * preimage. We have to find the challenge FROM the code, so the code is the only
 * thing available to hash. Hashing is kept for defence in depth (a database read
 * still does not hand over live codes) but it is not load-bearing here the way
 * it is for an outbound code.
 *
 * ONE DOCUMENT, NOT THREE KEYS
 *
 * A key-value design for this wants three entries — code, poll token, and a
 * sender index — that must be written and expired together. Here they are three
 * indexes on one document, so they cannot drift apart and one TTL expires all of
 * it at once.
 */
const reverseOtpChallengeSchema = new mongoose.Schema(
  {
    /**
     * The polling handle, handed to the client. Opaque and unguessable so it can
     * be passed in a query string: it reveals nothing about the phone number it
     * stands for, which a phone-keyed status endpoint would.
     */
    token: { type: String, required: true, unique: true, index: true },

    /**
     * HMAC of the displayed code. Unique across every live challenge, which is
     * what makes an arriving code resolve to exactly one session — and makes a
     * spent code unusable until the TTL reaps it.
     */
    codeHash: { type: String, required: true, unique: true, index: true },

    /**
     * The number being CLAIMED, normalised to its last 10 digits — the same form
     * `fields.phone` stores. An inbound sender is normalised the same way and
     * compared against this; equality is the proof.
     */
    phone: { type: String, required: true, index: true },

    /**
     * Mirrors `OtpChallenge.purpose`, minus `email_change` — an address has no
     * phone leg to reverse. Same reasoning as there: the purpose is picked by the
     * route alongside the role, so a challenge raised for a customer sign-in can
     * never be redeemed to mint a shopkeeper.
     */
    purpose: {
      type: String,
      required: true,
      enum: ['login', 'registration', 'vendor_registration', 'delivery_registration', 'phone_change'],
      index: true,
    },

    /**
     * Which app asked. Stored rather than taken from the completing request,
     * because it decides whether an unknown number may be turned into an account:
     * only the customer app mints one from a bare phone. See routes/auth.js, where
     * /otp/start refuses the same thing for the same reason.
     */
    app: { type: String, enum: ['customer', 'shopkeeper', 'delivery'], default: null },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /** Server-held state (e.g. `{ name }` for a first-time sign-in). Never echoed back. */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Set by the matcher when a message arrives from the claimed number. */
    verifiedAt: { type: Date, default: null },

    /**
     * The right code arrived from the WRONG number. Refused — but recorded, so
     * the waiting screen can say why instead of sitting on "waiting" forever.
     */
    mismatch: { type: Boolean, default: false },
    mismatchFrom: { type: String, default: null },

    /**
     * A message arrived from the claimed number carrying no code we recognise —
     * a typo, or the prefilled text edited. Without this a mistyped code is
     * completely unattributable and the user just waits.
     */
    badCode: { type: Boolean, default: false },

    /** Set when redeemed for a session. Single use. */
    consumedAt: { type: Date, default: null },

    // TTL index declared below, not inline: two definitions of `expiresAt_1`
    // differing only by expireAfterSeconds make MongoDB reject the second one
    // as a background warning, and the reaper silently never runs. Same trap
    // documented on OtpChallenge.
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

reverseOtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Supports the "a message came from this number but matched no code" lookup,
 * which is the one query that starts from the sender rather than the code.
 */
reverseOtpChallengeSchema.index({ phone: 1, consumedAt: 1, verifiedAt: 1, createdAt: -1 });

reverseOtpChallengeSchema.virtual('isUsable').get(function isUsable() {
  return !this.consumedAt && this.expiresAt.getTime() > Date.now();
});

module.exports = mongoose.model('ReverseOtpChallenge', reverseOtpChallengeSchema);
