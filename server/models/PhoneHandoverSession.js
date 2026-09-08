'use strict';

const mongoose = require('mongoose');

/**
 * Cross-device reverse-OTP handover.
 *
 * Browser starts a session bound to a phone. Helper device claims it (first
 * scan wins) and shows a 4-digit pair number. Only after the browser types
 * that number is a ReverseOtpChallenge minted — a stolen QR alone cannot
 * produce a code to send.
 *
 * Tokens: `claimToken` on the browser, `phoneToken` on the helper; only hashes
 * are stored. `pairNumber` stays plaintext until paired (phone must display it)
 * then is cleared.
 */
const phoneHandoverSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },

    /** SHA-256 of the browser claim token. */
    claimHash: { type: String, required: true },

    /** SHA-256 of the phone token — set on first successful scan. */
    phoneHash: { type: String, default: null },

    /**
     * pending → scanned → paired | failed
     * `expired` is derived from expiresAt on read, not stored.
     */
    state: {
      type: String,
      enum: ['pending', 'scanned', 'paired', 'failed'],
      required: true,
      default: 'pending',
    },

    /** 10 local digits — same normalisation as ReverseOtpChallenge. */
    phone: { type: String, required: true, index: true },

    purpose: { type: String, required: true },
    app: { type: String, default: null },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Carried into ReverseOtpChallenge.payload (e.g. registration name). */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Shown on the phone until paired; cleared after a successful pair. */
    pairNumber: { type: String, default: null },
    pairAttempts: { type: Number, default: 0 },

    /**
     * After pair: minted reverse-OTP binder + plaintext code for send links.
     * Cleared when the session expires via TTL.
     */
    reverseToken: { type: String, default: null },
    reverseCode: { type: String, default: null },

    scannedAt: { type: Date, default: null },
    pairedAt: { type: Date, default: null },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL reaps the whole row — claim, pair, and reverse binder together.
phoneHandoverSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PhoneHandoverSession', phoneHandoverSessionSchema);
