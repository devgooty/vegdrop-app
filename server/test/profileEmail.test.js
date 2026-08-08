'use strict';

/**
 * Editing a profile, and attaching an email to one.
 *
 * `PATCH /api/users/:id` stopped accepting `email` when login codes started
 * being copied there — an unverified address is a way in. The client kept
 * sending it, and `.strict()` turns an unknown key into a 400 for the WHOLE
 * request, so the name never saved either.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
} = require('./helpers');

const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('PATCH /users/:id refuses email, and the whole request fails with it', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .patch(`/api/users/${user._id}`)
    .set(auth(accessToken))
    .send({ name: 'Renamed', email: 'new@example.com' });

  assert.equal(res.status, 400, 'email is not a profile field');
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');

  const unchanged = await User.findById(user._id);
  assert.notEqual(unchanged.name, 'Renamed', 'the name must not save either — strict rejects the request');
});

test('a name-only profile edit succeeds', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .patch(`/api/users/${user._id}`)
    .set(auth(accessToken))
    .send({ name: 'Renamed' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.name, 'Renamed');
});

/**
 * The route an email must take instead: prove control of the NEW address
 * before it becomes a destination for login codes.
 */
test('attaching an email goes through its own verified challenge', async () => {
  const { accessToken, user } = await authenticatedUser('customer');
  await User.updateOne({ _id: user._id }, { $unset: { email: 1 }, $set: { emailVerifiedAt: null } });

  const start = await api()
    .post('/api/auth/email/start')
    .set(auth(accessToken))
    .send({ email: 'fresh@example.com' });

  assert.equal(start.status, 202, JSON.stringify(start.body));
  assert.ok(start.body.challengeId);

  const verify = await api()
    .post('/api/auth/email/verify')
    .set(auth(accessToken))
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.user.email, 'fresh@example.com');
  assert.equal(verify.body.user.emailVerified, true);

  const stored = await User.findById(user._id);
  assert.equal(stored.email, 'fresh@example.com');
  assert.ok(stored.emailVerifiedAt, 'only a proved address becomes a code destination');
});

test('a wrong code does not attach the address', async () => {
  const { accessToken, user } = await authenticatedUser('customer');
  await User.updateOne({ _id: user._id }, { $unset: { email: 1 }, $set: { emailVerifiedAt: null } });

  const start = await api()
    .post('/api/auth/email/start')
    .set(auth(accessToken))
    .send({ email: 'attacker@example.com' });
  assert.equal(start.status, 202);

  const wrong = start.body.devCode === '000000' ? '111111' : '000000';
  const verify = await api()
    .post('/api/auth/email/verify')
    .set(auth(accessToken))
    .send({ challengeId: start.body.challengeId, code: wrong });

  assert.notEqual(verify.status, 200);

  const stored = await User.findById(user._id);
  assert.ok(!stored.email, 'an unproved address must never be written');
});

test('another session cannot redeem someone else email challenge', async () => {
  const alice = await authenticatedUser('customer');
  const mallory = await authenticatedUser('customer');
  await User.updateOne({ _id: alice.user._id }, { $unset: { email: 1 }, $set: { emailVerifiedAt: null } });

  const start = await api()
    .post('/api/auth/email/start')
    .set(auth(alice.accessToken))
    .send({ email: 'alice-new@example.com' });
  assert.equal(start.status, 202);

  const stolen = await api()
    .post('/api/auth/email/verify')
    .set(auth(mallory.accessToken))
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(stolen.status, 403);
});
