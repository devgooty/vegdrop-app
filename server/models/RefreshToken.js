'use strict';

const mongoose = require('mongoose');

/**
 * Rotating refresh tokens with reuse detection.
 *
 * Only a SHA-256 hash of the token is stored, so a database leak does not yield
 * usable sessions. Each login starts a token "family"; using a token that has
 * already been rotated away indicates theft, and the whole family is revoked.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Shared by every token descended from a single login.
    family: { type: String, required: true, index: true },

    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },

    // Captured for audit only; never used as an authorization signal.
    userAgent: { type: String, default: null, maxlength: 400 },
    ip: { type: String, default: null, maxlength: 64 },
  },
  { timestamps: true }
);

// Let MongoDB reap expired documents rather than accumulating dead sessions.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.virtual('isActive').get(function isActive() {
  return !this.revokedAt && this.expiresAt.getTime() > Date.now();
});

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
