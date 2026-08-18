'use strict';

/**
 * Test harness.
 *
 * Environment variables are assigned before anything requires config/env.js,
 * because that module validates and freezes configuration at load time.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000000';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-00000';
process.env.OTP_PEPPER = 'test-otp-pepper-that-is-long-enough-0000000000';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

// Marks email delivery as configured so the fan-out path is exercised. Nothing
// connects: transportFor answers with the null transport (or whatever a test
// installs via setTransport) before resolveEmailTransport is ever reached, so
// this host is never resolved.
process.env.SMTP_HOST = 'smtp.invalid.test';
process.env.SMTP_FROM = 'VegDrop <smtp-should-not-win@invalid.test>';
// Deliberately different from SMTP_FROM: the two used to collide in the config
// object and SMTP_FROM silently won, so a test asserting the sender is only
// meaningful when the two values can be told apart.
process.env.EMAIL_FROM = 'VegDrop <no-reply@invalid.test>';

// config/env.js skips dotenv under NODE_ENV=test, but clear these explicitly in
// case they were exported into the shell: a test run must never be able to reach
// a live payment provider with real credentials.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

// Same reasoning for payouts, and more urgently: these credentials can move
// money OUT. A test run must never be able to dispatch a real transfer.
delete process.env.RAZORPAYX_KEY_ID;
delete process.env.RAZORPAYX_KEY_SECRET;
delete process.env.RAZORPAYX_ACCOUNT_NUMBER;

process.env.KYC_ENCRYPTION_KEY = 'test-kyc-encryption-key-long-enough-000000000';

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const request = require('supertest');

const { connect, disconnect, mongoose } = require('../db/connect');
const { createApp } = require('../app');
const User = require('../models/User');
const VendorKyc = require('../models/VendorKyc');

let replSet = null;
let app = null;

/** A single-node replica set, so multi-document transactions actually execute. */
async function startTestServer() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connect(replSet.getUri('vegdrop_test'));
  app = createApp();

  /**
   * Wait for index builds before any test runs.
   *
   * Mongoose builds declared indexes in the background and nothing awaits them,
   * so a suite that starts writing immediately races them. Uniqueness is not an
   * assertion the application makes — it is enforced only by the index — which
   * means a test for a constraint that has not finished building silently
   * observes no constraint at all, and passes for the wrong reason.
   * `resetDatabase` clears documents rather than dropping collections, so this
   * is paid once per run.
   */
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));

  return app;
}

async function stopTestServer() {
  await disconnect();
  if (replSet) await replSet.stop();
}

async function resetDatabase() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

function api() {
  return request(app);
}

/**
 * Create a user directly, bypassing the public flow. Used to set up privileged
 * roles, which by design cannot be produced through the public API.
 */
async function createUser({ role = 'customer', ...overrides } = {}) {
  const suffix = Math.floor(Math.random() * 900000 + 100000);
  const user = await User.create({
    name: overrides.name || `Test ${role}`,
    email: overrides.email || `${role}${suffix}@example.com`,
    phone: overrides.phone || `9${String(suffix).padStart(9, '0')}`.slice(0, 10),
    role,
    phoneVerifiedAt: new Date(),
    ...(overrides.status ? { status: overrides.status } : {}),
  });
  return { user };
}

/**
 * Complete the OTP flow for a phone number. Creates the account if it is new,
 * exactly as the public flow does.
 * @returns {Promise<{ accessToken: string, refreshCookie: string, user: object }>}
 */
async function signIn({ phone, name }) {
  const start = await api()
    .post('/api/auth/otp/start')
    .send(name ? { phone, name } : { phone });

  if (start.status !== 202) {
    throw new Error(`otp/start failed: ${start.status} ${JSON.stringify(start.body)}`);
  }

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  if (![200, 201].includes(verify.status)) {
    throw new Error(`otp/verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  }

  const cookies = verify.headers['set-cookie'] || [];
  return {
    accessToken: verify.body.accessToken,
    refreshCookie: cookies.find((c) => c.startsWith('vb_rt=')) || '',
    user: verify.body.user,
  };
}

/** Create a user with a given role and sign in as them in one step. */
async function authenticatedUser(role = 'customer') {
  const { user } = await createUser({ role });
  const session = await signIn({ phone: user.phone });
  return { ...session, user };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Mark a shopkeeper's settlement account as verified, straight in the database.
 *
 * Catalog writes are gated on this (middleware/vendorVerified.js), so any test
 * about product ownership or pricing needs it as background state. Written
 * directly rather than driven through the penny-drop endpoints because those
 * tests are not about KYC — kyc.test.js exercises the real flow.
 */
async function verifyVendor(user) {
  return VendorKyc.create({
    user: user._id,
    legalName: user.name,
    bankName: 'HDFC Bank',
    ifsc: 'HDFC0001234',
    upiVpa: `vendor${Math.floor(Math.random() * 900000)}@okhdfcbank`,
    ...VendorKyc.buildSecrets({ bankAccount: '123456789012' }),
    status: 'verified',
    verifiedAt: new Date(),
  });
}

module.exports = {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  createUser,
  signIn,
  authenticatedUser,
  verifyVendor,
  auth,
};
