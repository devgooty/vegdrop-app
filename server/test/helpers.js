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

// config/env.js skips dotenv under NODE_ENV=test, but clear these explicitly in
// case they were exported into the shell: a test run must never be able to reach
// a live payment provider with real credentials.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const request = require('supertest');

const { connect, disconnect, ensureIndexes, mongoose } = require('../db/connect');
const { createApp } = require('../app');
const User = require('../models/User');
const passwords = require('../services/password');

let replSet = null;
let app = null;

/** A single-node replica set, so multi-document transactions actually execute. */
async function startTestServer() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connect(replSet.getUri('vegbazzar_test'));
  app = createApp();
  // Mirrors server/index.js: geo queries fail hard without their 2dsphere index.
  await ensureIndexes();
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
 * Create a user directly, bypassing registration. Used to set up privileged
 * roles, which by design cannot be produced through the public API.
 */
async function createUser({ role = 'customer', password = 'CorrectHorse9!', ...overrides } = {}) {
  const suffix = Math.floor(Math.random() * 900000 + 100000);
  const user = await User.create({
    name: overrides.name || `Test ${role}`,
    email: overrides.email || `${role}${suffix}@example.com`,
    phone: overrides.phone || `9${String(suffix).padStart(9, '0')}`.slice(0, 10),
    passwordHash: await passwords.hash(password),
    role,
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: new Date(),
    ...(overrides.status ? { status: overrides.status } : {}),
  });
  return { user, password };
}

/**
 * Complete the full password + OTP flow.
 * @returns {Promise<{ accessToken: string, refreshCookie: string, user: object }>}
 */
async function signIn({ identifier, password }) {
  const start = await api().post('/api/auth/login').send({ identifier, password });
  if (start.status !== 202) {
    throw new Error(`login step 1 failed: ${start.status} ${JSON.stringify(start.body)}`);
  }

  const verify = await api()
    .post('/api/auth/login/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  if (verify.status !== 200) {
    throw new Error(`login step 2 failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  }

  const cookies = verify.headers['set-cookie'] || [];
  return {
    accessToken: verify.body.accessToken,
    refreshCookie: cookies.find((c) => c.startsWith('vb_rt=')) || '',
    user: verify.body.user,
  };
}

/** Create a user and sign in as them in one step. */
async function authenticatedUser(role = 'customer') {
  const { user, password } = await createUser({ role });
  const session = await signIn({ identifier: user.email, password });
  return { ...session, user, password };
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
