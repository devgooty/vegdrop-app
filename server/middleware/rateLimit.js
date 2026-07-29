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

/** Credential endpoints: keyed on IP + the account being targeted. */
const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => {
    const target = typeof req.body?.identifier === 'string'
      ? req.body.identifier.trim().toLowerCase().slice(0, 120)
      : 'anonymous';
    return `${ipKeyGenerator(req.ip)}:${target}`;
  },
  // A correct login should not consume budget; only failures count.
  skipSuccessfulRequests: true,
  handler: jsonLimitHandler(
    'Too many sign-in attempts. Please wait a few minutes before trying again.',
    'AUTH_RATE_LIMITED'
  ),
});

/** Requesting a code is expensive (SMS cost) and enumerable, so keep it tight. */
const otpRequestLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => {
    const dest = typeof req.body?.identifier === 'string'
      ? req.body.identifier.trim().toLowerCase().slice(0, 120)
      : ipKeyGenerator(req.ip);
    return `otp:${dest}`;
  },
  handler: jsonLimitHandler(
    'Too many verification codes requested. Please wait before requesting another.',
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

const registrationLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  handler: jsonLimitHandler('Too many accounts created from this network. Try again later.', 'RATE_LIMITED'),
});

const paymentLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  handler: jsonLimitHandler('Too many payment requests. Please wait a moment.', 'RATE_LIMITED'),
});

module.exports = {
  globalLimiter,
  authLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  registrationLimiter,
  paymentLimiter,
};
