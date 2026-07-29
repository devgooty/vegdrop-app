'use strict';

/**
 * Environment configuration with fail-fast validation.
 *
 * Design rule: there are NO hardcoded secret fallbacks. In production a missing
 * secret aborts boot. In development/test a random ephemeral secret is generated
 * per process (so tokens simply don't survive a restart) and a loud warning is
 * printed. A committed literal would mean anyone with the source can forge tokens.
 */

const crypto = require('crypto');

// Under test, never read the developer's real .env — it holds live payment
// credentials, and a test run must not be able to reach a payment provider.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const fatal = [];
const ephemeral = [];

/** Secret that must be strong in production, ephemeral-random elsewhere. */
function secret(name, minLength = 32) {
  const value = process.env[name];

  if (value) {
    if (value.length < minLength) {
      fatal.push(`${name} must be at least ${minLength} characters (got ${value.length}).`);
    }
    return value;
  }

  if (isProduction) {
    fatal.push(`${name} is required in production but is not set.`);
    return undefined;
  }

  ephemeral.push(name);
  return crypto.randomBytes(48).toString('base64url');
}

/** Non-secret value with a safe default. */
function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    fatal.push(`${name} must be an integer (got "${raw}").`);
    return fallback;
  }
  return parsed;
}

// ---------------------------------------------------------------------------

const mongoUri = isProduction
  ? process.env.MONGODB_URI
  : optional('MONGODB_URI', 'mongodb://127.0.0.1:27017/vegbazzar');

if (isProduction && !mongoUri) {
  fatal.push('MONGODB_URI is required in production but is not set.');
}

const corsOrigins = list('CORS_ALLOWED_ORIGINS', isProduction ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']);
if (isProduction && corsOrigins.length === 0) {
  fatal.push('CORS_ALLOWED_ORIGINS is required in production (comma-separated absolute origins).');
}

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const razorpayConfigured = Boolean(razorpayKeyId && razorpayKeySecret);

// A real key id starts with rzp_live_ / rzp_test_. Refuse obvious placeholders in prod.
if (isProduction && (!razorpayConfigured || !/^rzp_(live|test)_/.test(razorpayKeyId))) {
  fatal.push('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET must be real credentials in production. Payments cannot run in mock mode.');
}

const config = Object.freeze({
  NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: !isProduction && !isTest,

  port: int('PORT', 5000),
  trustProxy: optional('TRUST_PROXY', isProduction ? '1' : ''),

  mongoUri,

  corsOrigins,

  jwt: Object.freeze({
    accessSecret: secret('JWT_ACCESS_SECRET'),
    refreshSecret: secret('JWT_REFRESH_SECRET'),
    accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 15 * 60), // 15 minutes
    refreshTtlSeconds: int('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60), // 30 days
    issuer: optional('JWT_ISSUER', 'vegbazzar'),
    audience: optional('JWT_AUDIENCE', 'vegbazzar-app'),
  }),

  // Pepper is mixed into OTP hashes so a database leak alone does not reveal codes.
  otp: Object.freeze({
    pepper: secret('OTP_PEPPER'),
    length: 6,
    ttlSeconds: int('OTP_TTL_SECONDS', 5 * 60),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 30),
  }),

  auth: Object.freeze({
    maxFailedLogins: int('AUTH_MAX_FAILED_LOGINS', 8),
    lockoutSeconds: int('AUTH_LOCKOUT_SECONDS', 15 * 60),
    minPasswordLength: int('AUTH_MIN_PASSWORD_LENGTH', 10),
  }),

  razorpay: Object.freeze({
    keyId: razorpayKeyId,
    keySecret: razorpayKeySecret,
    configured: razorpayConfigured,
    // Mock order creation is a development affordance only; prod is blocked above.
    allowMock: !isProduction && !razorpayConfigured,
  }),

  cookies: Object.freeze({
    refreshName: 'vb_rt',
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/auth',
  }),
});

if (fatal.length > 0) {
  const message = ['Invalid environment configuration:', ...fatal.map((e) => `  - ${e}`)].join('\n');
  throw new Error(message);
}

if (ephemeral.length > 0 && !isTest) {
  console.warn(
    `[config] ${ephemeral.join(', ')} not set — generated ephemeral secret(s) for this process.\n` +
    '[config] Sessions will not survive a restart. Set real values in .env before deploying.'
  );
}

module.exports = config;
