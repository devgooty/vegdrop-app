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

    purpose: {
      type: String,
      required: true,
      enum: ['login', 'register', 'profile_update', 'password_reset'],
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

    expiresAt: { type: Date, required: true, index: true },
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
