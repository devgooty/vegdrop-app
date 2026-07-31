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
process.env.SMTP_FROM = 'VegBazzar <no-reply@invalid.test>';

// config/env.js skips dotenv under NODE_ENV=test, but clear these explicitly in
// case they were exported into the shell: a test run must never be able to reach
// a live payment provider with real credentials.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const request = require('supertest');

const { connect, disconnect, mongoose } = require('../db/connect');
const { createApp } = require('../app');
const User = require('../models/User');

let replSet = null;
let app = null;

/** A single-node replica set, so multi-document transactions actually execute. */
async function startTestServer() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connect(replSet.getUri('vegbazzar_test'));
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
    emailVerifiedAt: new Date(),
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

module.exports = {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  createUser,
  signIn,
  authenticatedUser,
  auth,
};
