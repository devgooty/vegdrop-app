'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('../config/env');

/**
 * Rate limiting.
 *
 * The previous configuration was commented out entirely, leaving credential
 * stuffing and OTP brute force unbounded. Limits are tiered: cheap read traffic
 * gets a generous global budget, while anything that guesses a secret is
 * throttled hard and keyed on the target as well as the source IP (so one
 * attacker rotating IPs still cannot hammer a single account).
 */

function jsonLimitHandler(message, code) {
  return (req, res) => {
    res.status(429).json({
      error: {
        code,
        message,
        retryAfterSeconds: Math.ceil(req.rateLimit.resetTime ? (req.rateLimit.resetTime - Date.now()) / 1000 : 60),
      },
    });
  };
}

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Tests would otherwise trip limits across cases and fail nondeterministically.
  skip: () => config.isTest,
};

/** Broad protection for the whole API surface. */
const globalLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 600,
  handler: jsonLimitHandler('Too many requests. Please slow down.', 'RATE_LIMITED'),
});

/**
 * Requesting a code costs a message and is the whole credential, so keep it
 * tight. Keyed on the destination number rather than the caller: an attacker
 * rotating IPs still cannot flood one person's WhatsApp.
 */
const otpRequestLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => {
    // Runs before validation, so read defensively. Either key may carry the
    // destination: `identifier` is the single sign-in box, `phone` the original
    // narrower form. An email is keyed whole; a number is reduced to its last
    // ten digits so +91/0 prefixed spellings share one budget.
    const raw = req.body?.identifier ?? req.body?.phone;
    if (typeof raw !== 'string' || raw.length === 0) {
      return `otp:${ipKeyGenerator(req.ip)}`;
    }
    const dest = raw.includes('@')
      ? raw.trim().toLowerCase().slice(0, 254)
      : raw.replace(/\D/g, '').slice(-10);
    return `otp:${dest}`;
  },
  handler: jsonLimitHandler(
    'Too many verification codes requested. Please wait before requesting another.',
    'OTP_RATE_LIMITED'
  ),
});

/**
 * The per-destination limit above says nothing about someone walking a list of
 * numbers, one code each — which is unsolicited messaging, and the fastest way
 * to get the WhatsApp number banned. This bounds that per source.
 */
const otpStartIpLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 20,
  handler: jsonLimitHandler(
    'Too many verification codes requested from this network. Try again later.',
    'OTP_RATE_LIMITED'
  ),
});

/** Guessing a 6-digit code must be far slower than the keyspace allows. */
const otpVerifyLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 12,
  keyGenerator: (req) => {
    const challenge = typeof req.body?.challengeId === 'string'
      ? req.body.challengeId.slice(0, 80)
      : ipKeyGenerator(req.ip);
    return `otpv:${challenge}`;
  },
  handler: jsonLimitHandler('Too many verification attempts. Request a new code.', 'OTP_RATE_LIMITED'),
});

/**
 * POST /auth/lookup answers whether an identifier has an account, which is an
 * account-enumeration oracle by construction — the sign-in flow was built to
 * avoid exactly this, and the UX now requires it.
 *
 * Since the leak cannot be closed, it is priced instead: this is the tightest
 * budget in the app. 20/hour per source makes a targeted check of one person
 * trivial and a sweep of a number range useless — walking Indian mobile prefixes
 * at this rate would take millennia. Keyed on the caller, because the whole
 * point is bounding how many DIFFERENT identifiers one source can test.
 */
const lookupLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 20,
  handler: jsonLimitHandler(
    'Too many lookups from this network. Try again later.',
    'LOOKUP_RATE_LIMITED'
  ),
});

const paymentLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  handler: jsonLimitHandler('Too many payment requests. Please wait a moment.', 'RATE_LIMITED'),
});

/**
 * A rider's position heartbeat.
 *
 * Generous by design: this is the highest-frequency authenticated call in the
 * system, and the whole dispatch engine is only as good as how fresh these are.
 * Keyed per rider rather than per IP so a depot full of agents on one office
 * Wi-Fi does not share — and exhaust — a single budget.
 */
const riderLocationLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => `rloc:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Location updates are coming in too fast.', 'RATE_LIMITED'),
});

/**
 * Accepting and packing, keyed per shopkeeper.
 *
 * Not a security boundary — the claim itself is atomic and a losing claim costs
 * one indexed write. This is a backstop against a wedged client retry loop
 * turning one shop's bad network into database load for the whole market.
 */
const stallActionLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: (req) => `stall:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Too many actions. Please slow down.', 'RATE_LIMITED'),
});

module.exports = {
  globalLimiter,
  otpRequestLimiter,
  otpStartIpLimiter,
  otpVerifyLimiter,
  lookupLimiter,
  paymentLimiter,
  riderLocationLimiter,
  stallActionLimiter,
};
