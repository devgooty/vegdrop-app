'use strict';

/**
 * DEV_LOGIN must be set before ./helpers requires config/env.js, which validates
 * and freezes configuration at load — the same reason reverseOtp.test.js sets
 * WHATSAPP_APP_SECRET at the top of its file. `node --test` gives each file its
 * own process, so this affects only this one; auth.test.js runs without it and
 * asserts the route is not there at all.
 */
process.env.DEV_LOGIN = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { startTestServer, stopTestServer, resetDatabase, api, createUser } = require('./helpers');
const config = require('../config/env');
const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('DEV_LOGIN=1 outside production enables the route', () => {
  assert.equal(config.devLoginEnabled, true);
});

test('signs a seeded account in with no code, and the session is real', async () => {
  await createUser({ role: 'developer', phone: '9000000005' });

  const res = await api().get('/api/auth/dev/login?phone=9000000005');

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');

  const cookies = res.headers['set-cookie'] || [];
  const refresh = cookies.find((c) => c.startsWith(`${config.cookies.refreshName}=`));
  assert.ok(refresh, 'a refresh cookie is set');

  // The redirect is worthless unless the cookie it carries actually restores a
  // session — which is the whole mechanism: the app's restoreSession() trades
  // this cookie for an access token on mount.
  const restored = await api().post('/api/auth/refresh').set('Cookie', refresh);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.user.role, 'developer');
  assert.equal(restored.body.user.phone, '9000000005');
  assert.ok(restored.body.accessToken, 'an access token comes back');
});

test('follows ?next= only into an in-app hash route', async () => {
  await createUser({ role: 'shopkeeper', phone: '9000000002' });

  const ok = await api().get('/api/auth/dev/login?phone=9000000002&next=/%23/shopkeeper');
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/#/shopkeeper');

  // Anything that is not an in-app hash route falls back to the app root rather
  // than becoming an open redirect that hands the session cookie to a stranger.
  const offsite = await api().get('/api/auth/dev/login?phone=9000000002&next=https://evil.test/');
  assert.equal(offsite.status, 302);
  assert.equal(offsite.headers.location, '/');
});

test('refuses to mint an account for an unknown number', async () => {
  const res = await api().get('/api/auth/dev/login?phone=9123456789');

  assert.equal(res.status, 404);
  assert.equal(res.body.error?.code, 'DEV_LOGIN_NO_ACCOUNT');
  // The failure mode worth guarding: conjuring a privileged role the seed never
  // created. Nothing was written.
  assert.equal(await User.countDocuments({ phone: '9123456789' }), 0);
});

test('rejects a malformed phone', async () => {
  const res = await api().get('/api/auth/dev/login?phone=notaphone');
  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code, 'DEV_LOGIN_BAD_PHONE');
});

/**
 * The guard that actually matters. Everything above only proves the convenience
 * works; this proves it cannot ship. A child process is required because
 * config/env.js freezes at load and throws on a bad environment — there is no
 * way to observe this in-process.
 */
test('DEV_LOGIN in production is a boot-time fatal', () => {
  const run = (env) =>
    spawnSync(process.execPath, ['-e', "require('./server/config/env')"], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DEV_LOGIN: '',
        // A production boot fails on plenty of other counts; supply enough that
        // the DEV_LOGIN line is the only difference between the two runs.
        MONGODB_URI: 'mongodb://localhost:27017/x?replicaSet=rs0',
        CORS_ALLOWED_ORIGINS: 'https://example.test',
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
        OTP_PEPPER: 'c'.repeat(48),
        KYC_ENCRYPTION_KEY: 'd'.repeat(64),
        NOTIFY_TRANSPORT: 'whatsapp',
        WHATSAPP_PHONE_NUMBER_ID: '1',
        WHATSAPP_ACCESS_TOKEN: 'e'.repeat(48),
        WHATSAPP_TEMPLATE_NAME: 'otp_code',
        RAZORPAY_KEY_ID: 'rzp_test_abcdefghij',
        RAZORPAY_KEY_SECRET: 'f'.repeat(24),
        RAZORPAYX_KEY_ID: 'rzp_test_abcdefghij',
        RAZORPAYX_KEY_SECRET: 'g'.repeat(24),
        RAZORPAYX_ACCOUNT_NUMBER: '1234567890',
        ...env,
      },
    });

  const withFlag = run({ DEV_LOGIN: '1' });
  assert.notEqual(withFlag.status, 0, 'production boot fails with DEV_LOGIN=1');
  assert.match(withFlag.stderr, /DEV_LOGIN must never be set on a deployed host/);

  // And the flag is the cause, not an unrelated production requirement that
  // would have failed the boot either way.
  const without = run({});
  assert.doesNotMatch(without.stderr || '', /DEV_LOGIN/);
});

/**
 * The guard that matters MORE here, because NODE_ENV cannot be trusted.
 *
 * NODE_ENV is whatever the host was configured to say, so a deployment can be
 * serving real traffic without it — in which case the test above passes and
 * proves nothing about that host. A deployed environment has to be recognisable
 * without taking NODE_ENV's word for it, which is what the platform markers do.
 */
test('DEV_LOGIN on a deployed host is fatal even when NODE_ENV is not production', () => {
  const run = (env) =>
    spawnSync(process.execPath, ['-e', "require('./server/config/env')"], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DEV_LOGIN: '1',
        // Cleared so a marker leaking in from the real shell cannot make the
        // control case below pass for the wrong reason.
        RAILWAY_ENVIRONMENT: '',
        RAILWAY_SERVICE_ID: '',
        VERCEL: '',
        RENDER: '',
        FLY_APP_NAME: '',
        DYNO: '',
        ...env,
      },
    });

  for (const marker of ['RAILWAY_ENVIRONMENT', 'RAILWAY_SERVICE_ID', 'VERCEL', 'RENDER', 'FLY_APP_NAME', 'DYNO']) {
    const res = run({ [marker]: '1' });
    assert.notEqual(res.status, 0, `boot must fail with DEV_LOGIN=1 and ${marker} set`);
    assert.match(res.stderr, new RegExp(`DEV_LOGIN must never be set on a deployed host \\(${marker} is set\\)`));
  }

  // A plain developer machine carries none of them and is unaffected.
  assert.equal(run({}).status, 0, 'a local dev boot with DEV_LOGIN=1 still works');
});
