'use strict';

const mongoose = require('mongoose');

/**
 * A pending one-time-code challenge.
 *
 * The code itself is never stored — only an HMAC of it, keyed by a server-side
 * pepper. Verification is attempt-limited and time-limited, and a consumed
 * challenge can never be replayed.
 */
const otpChallengeSchema = new mongoose.Schema(
  {
    // Opaque handle handed to the client. Knowing it is not sufficient to pass.
    challengeId: { type: String, required: true, unique: true, index: true },

    /**
     * `login` covers signing up too — they are one flow, so a challenge issued
     * for a number with no account is the same kind of challenge as one for an
     * existing account. `phone_change` proves control of a new number before it
     * becomes the account's credential. `email_change` does the same for an
     * address before login codes are ever copied to it — an address nobody
     * proved control of would be a way in, not a convenience. `vendor_registration`
     * is kept separate from `registration` rather than reusing it with a payload
     * flag, so a code issued for a customer sign-up can never be redeemed to
     * mint a `shopkeeper` account and vice versa.
     *
     * Deliberately only the purposes that actually exist: a `password_reset`
     * value here would describe a flow that cannot exist, since there are no
     * passwords. `verifyChallenge` filters on this, so a code issued for one
     * purpose cannot be redeemed against another.
     */
    purpose: {
      type: String,
      required: true,
      enum: ['login', 'registration', 'vendor_registration', 'phone_change', 'email_change'],
      index: true,
    },

    // Normalized email or phone the code was sent to.
    destination: { type: String, required: true, index: true },
    channel: { type: String, required: true, enum: ['email', 'sms'] },

    codeHash: { type: String, required: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /**
     * Arbitrary server-held state carried across the challenge (e.g. the pending
     * registration payload). Never echoed back to the client.
     */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },

    // Indexed below as a TTL index, not here: declaring both produces two
    // definitions of `expiresAt_1` that differ only by expireAfterSeconds, and
    // MongoDB rejects the second. The rejection surfaced only as a background
    // warning, so the reaper silently never applied and consumed challenges
    // accumulated indefinitely.
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

otpChallengeSchema.virtual('isUsable').get(function isUsable() {
  return (
    !this.consumedAt &&
    this.attempts < this.maxAttempts &&
    this.expiresAt.getTime() > Date.now()
  );
});

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
