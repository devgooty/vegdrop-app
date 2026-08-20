'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  createUser,
  signIn,
  authenticatedUser,
  auth,
} = require('./helpers');

const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

// ---------------------------------------------------------------------------
// Requesting a code
// ---------------------------------------------------------------------------

test('requesting a code issues a challenge and does not return a token', async () => {
  const res = await api().post('/api/auth/otp/start').send({ phone: '9876543210' });

  assert.equal(res.status, 202);
  assert.ok(res.body.challengeId, 'expected a challengeId');
  assert.equal(res.body.accessToken, undefined, 'no token may be issued before verification');
  // The destination is masked so the response cannot be used to confirm contacts.
  assert.match(res.body.destination, /\*/);
});

test('a known and an unknown number are indistinguishable at the start step', async () => {
  const { user } = await createUser({ phone: '9876543210' });

  const known = await api().post('/api/auth/otp/start').send({ phone: user.phone });
  const unknown = await api().post('/api/auth/otp/start').send({ phone: '9111111111' });

  assert.equal(known.status, unknown.status);
  assert.deepEqual(
    Object.keys(known.body).sort(),
    Object.keys(unknown.body).sort(),
    'the response shape must not reveal whether the number is registered'
  );
});

test('a suspended account is not disclosed at the start step', async () => {
  const { user } = await createUser({ phone: '9876543210', status: 'suspended' });

  const res = await api().post('/api/auth/otp/start').send({ phone: user.phone });

  assert.equal(res.status, 202, 'status must not betray the account state');
});

test('a number beginning 91 is not mistaken for a country code', async () => {
  // 9111111111 is a valid 10-digit mobile. Stripping the leading "91" by
  // pattern rather than by length left 11111111 and made the account
  // unreachable — which, now that the number is the credential, means the
  // owner simply cannot sign in.
  const session = await signIn({ phone: '9111111111', name: 'Prefix Case' });

  assert.equal(session.user.phone, '9111111111');
});

test('the same number is recognised with or without its country code', async () => {
  await signIn({ phone: '9876543210', name: 'Country Code' });

  const start = await api().post('/api/auth/otp/start').send({ phone: '+91 98765 43210' });
  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200, 'an existing account, not a second one');
  assert.equal(await User.countDocuments({ phone: '9876543210' }), 1);
});

test('an invalid phone number is rejected outright', async () => {
  // The old identifier matching used .includes() with a 4-character floor, so a
  // fragment like this could authenticate against another account.
  await createUser({ phone: '9876543210' });

  const res = await api().post('/api/auth/otp/start').send({ phone: '9876' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('a NoSQL operator payload cannot stand in for a phone number', async () => {
  await createUser({ phone: '9876543210' });

  const res = await api().post('/api/auth/otp/start').send({ phone: { $ne: null } });

  assert.equal(res.status, 400, 'operator objects must be rejected as invalid types');
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// Verifying a code
// ---------------------------------------------------------------------------

test('a new number gets a customer account on first verification', async () => {
  const start = await api()
    .post('/api/auth/otp/start')
    .send({ phone: '9876543210', name: 'Asha Rao' });

  const res = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'customer');
  assert.equal(res.body.user.name, 'Asha Rao');
  assert.equal(res.body.user.phone, '9876543210');
  assert.equal(res.body.user.phoneVerified, true);
  assert.ok(res.body.accessToken);
});

test('a self-created account is a customer even when a role is supplied', async () => {
  const res = await api().post('/api/auth/otp/start').send({
    phone: '9876543211',
    name: 'Escalation Attempt',
    role: 'developer',
  });

  // .strict() rejects the unknown key outright rather than ignoring it.
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('signing up without a name still produces a usable account', async () => {
  const session = await signIn({ phone: '9876543210' });

  assert.equal(session.user.role, 'customer');
  assert.ok(session.user.name.length > 0, 'a display name is always present');
});

test('an existing account signs in rather than being duplicated', async () => {
  const { user } = await createUser({ phone: '9876543210', name: 'Original Name' });

  const session = await signIn({ phone: '9876543210' });

  assert.equal(session.user.id, user._id.toHexString());
  assert.equal(await User.countDocuments({ phone: '9876543210' }), 1);
});

test('the name field cannot rename an existing account', async () => {
  const { user } = await createUser({ phone: '9876543210', name: 'Original Name' });

  const session = await signIn({ phone: '9876543210', name: 'Attacker Chosen' });

  assert.equal(session.user.name, 'Original Name');
  const fresh = await User.findById(user._id);
  assert.equal(fresh.name, 'Original Name');
});

test('a privileged role survives signing in through the public flow', async () => {
  const { user } = await createUser({ role: 'shopkeeper', phone: '9876543210' });

  const session = await signIn({ phone: '9876543210' });

  assert.equal(session.user.role, 'shopkeeper', 'sign-in must not downgrade a provisioned role');
});

test('a suspended account cannot complete sign-in', async () => {
  const { user } = await createUser({ phone: '9876543210', status: 'suspended' });

  const start = await api().post('/api/auth/otp/start').send({ phone: user.phone });
  const res = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ACCOUNT_INACTIVE');
  assert.equal(res.body.accessToken, undefined);
});

test('an incorrect code is rejected and the challenge dies after max attempts', async () => {
  const start = await api().post('/api/auth/otp/start').send({ phone: '9876543210' });

  const wrong = start.body.devCode === '000000' ? '111111' : '000000';

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await api()
      .post('/api/auth/otp/verify')
      .send({ challengeId: start.body.challengeId, code: wrong });
  }
  assert.ok([400, 429].includes(last.status));

  // Even the correct code must fail once the attempt budget is spent.
  const afterExhaustion = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.ok(
    ![200, 201].includes(afterExhaustion.status),
    'exhausted challenge must not authenticate'
  );
  assert.equal(await User.countDocuments({ phone: '9876543210' }), 0, 'and must not create an account');
});

test('a code cannot be replayed', async () => {
  const start = await api().post('/api/auth/otp/start').send({ phone: '9876543210' });

  const first = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });
  assert.equal(first.status, 201);

  const replay = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.ok(![200, 201].includes(replay.status), 'a consumed challenge must not authenticate again');
  assert.equal(await User.countDocuments({ phone: '9876543210' }), 1, 'and must not create a second account');
});

test('requesting a second code immediately is refused', async () => {
  await api().post('/api/auth/otp/start').send({ phone: '9876543210' });

  const again = await api().post('/api/auth/otp/start').send({ phone: '9876543210' });

  assert.equal(again.status, 429);
  assert.equal(again.body.error.code, 'OTP_COOLDOWN');
});

// ---------------------------------------------------------------------------
// Tokens and session lifecycle
// ---------------------------------------------------------------------------

test('a tampered access token is rejected', async () => {
  const { accessToken } = await authenticatedUser('customer');

  const [header, payload, signature] = accessToken.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  decoded.role = 'developer';
  const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');

  const res = await api()
    .get('/api/auth/me')
    .set(auth(`${header}.${forgedPayload}.${signature}`));

  assert.equal(res.status, 401);
});

test('an unsigned (alg:none) token is rejected', async () => {
  const { user } = await createUser({ role: 'developer' });

  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: user._id.toHexString(), role: 'developer', tv: 0 })
  ).toString('base64url');

  const res = await api().get('/api/auth/me').set(auth(`${header}.${payload}.`));

  assert.equal(res.status, 401);
});

test('the role in a token is not trusted over the database', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  // Promote out of band, then confirm the still-"customer" token gains access.
  await User.updateOne({ _id: user._id }, { $set: { role: 'developer' } });

  const res = await api().get('/api/users').set(auth(accessToken));
  assert.equal(res.status, 200, 'authorization reads the live role, not the token claim');
});

test('refresh rotates the token and detects reuse', async () => {
  const { refreshCookie } = await authenticatedUser('customer');

  const first = await api().post('/api/auth/refresh').set('Cookie', refreshCookie);
  assert.equal(first.status, 200);
  assert.ok(first.body.accessToken);

  const rotated = (first.headers['set-cookie'] || []).find((c) => c.startsWith('vb_rt='));
  assert.ok(rotated, 'refresh must issue a replacement cookie');
  assert.notEqual(rotated, refreshCookie, 'the refresh token must change on use');

  // Presenting the retired token signals theft.
  const reuse = await api().post('/api/auth/refresh').set('Cookie', refreshCookie);
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error.code, 'REFRESH_INVALID');

  // Reuse detection revokes the whole family, so the rotated token dies too.
  const afterBreach = await api().post('/api/auth/refresh').set('Cookie', rotated);
  assert.equal(afterBreach.status, 401, 'the entire token family must be revoked');
});

test('the refresh cookie is httpOnly and SameSite=Strict', async () => {
  const { refreshCookie } = await authenticatedUser('customer');

  assert.match(refreshCookie, /HttpOnly/i, 'refresh token must be unreadable from JavaScript');
  assert.match(refreshCookie, /SameSite=Strict/i);
});

test('logout-all invalidates outstanding access tokens immediately', async () => {
  const { accessToken } = await authenticatedUser('customer');

  assert.equal((await api().get('/api/auth/me').set(auth(accessToken))).status, 200);

  await api().post('/api/auth/logout-all').set(auth(accessToken)).expect(204);

  const after = await api().get('/api/auth/me').set(auth(accessToken));
  assert.equal(after.status, 401);
});

/**
 * The case the feature exists for.
 *
 * Revoking the caller's own access token proves little — it expires on its own
 * within minutes. What "sign out on all devices" has to do is kill the long-
 * lived refresh cookie sitting on a device the user is not holding, because
 * with no password that is the only way to end a session someone else has.
 */
test('logout-all kills another device refresh cookie', async () => {
  const { user } = await createUser({ role: 'customer' });

  // Two independent sign-ins for one account: two refresh families.
  const laptop = await signIn({ phone: user.phone });
  const stolen = await signIn({ phone: user.phone });

  // The other device can still mint access tokens before the revocation.
  const before = await api().post('/api/auth/refresh').set('Cookie', stolen.refreshCookie);
  assert.equal(before.status, 200, 'precondition: the second session works');

  await api().post('/api/auth/logout-all').set(auth(laptop.accessToken)).expect(204);

  // Its newest cookie, not the one already rotated away, so this is a
  // revocation rather than the reuse detector firing.
  const rotated = (before.headers['set-cookie'] || []).find((c) => c.startsWith('vb_rt='));
  assert.ok(rotated, 'precondition: refresh issued a replacement cookie');

  const after = await api().post('/api/auth/refresh').set('Cookie', rotated);
  assert.equal(after.status, 401, 'the other device must not be able to refresh');
});

test('a suspended account cannot use an existing token', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await User.updateOne({ _id: user._id }, { $set: { status: 'suspended' } });

  const res = await api().get('/api/auth/me').set(auth(accessToken));
  assert.equal(res.status, 401);
});

test('there is no password endpoint left to call', async () => {
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .post('/api/auth/password')
    .set(auth(accessToken))
    .send({ currentPassword: 'anything', newPassword: 'anything-else' });

  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Changing the phone number — the credential itself
// ---------------------------------------------------------------------------

test('the profile endpoint cannot move the phone number', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  // Without this, a stolen session becomes permanent ownership: rewrite the
  // number, then receive every future sign-in code.
  const res = await api()
    .patch(`/api/users/${user._id.toHexString()}`)
    .set(auth(accessToken))
    .send({ phone: '9111111111' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');

  const fresh = await User.findById(user._id);
  assert.equal(fresh.phone, user.phone, 'the number must be untouched');
});

test('moving the phone number requires a code sent to the new number', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const start = await api()
    .post('/api/auth/phone/start')
    .set(auth(accessToken))
    .send({ phone: '9111111111' });

  assert.equal(start.status, 202);
  assert.equal(start.body.accessToken, undefined, 'no session change before verification');

  // Still on the old number until the code is verified.
  assert.equal((await User.findById(user._id)).phone, user.phone);

  const verify = await api()
    .post('/api/auth/phone/verify')
    .set(auth(accessToken))
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200);
  assert.equal(verify.body.user.phone, '9111111111');
  assert.equal((await User.findById(user._id)).phone, '9111111111');
});

test('a wrong code leaves the phone number alone', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const start = await api()
    .post('/api/auth/phone/start')
    .set(auth(accessToken))
    .send({ phone: '9111111111' });

  const wrong = start.body.devCode === '000000' ? '111111' : '000000';
  const verify = await api()
    .post('/api/auth/phone/verify')
    .set(auth(accessToken))
    .send({ challengeId: start.body.challengeId, code: wrong });

  assert.equal(verify.status, 400);
  assert.equal((await User.findById(user._id)).phone, user.phone);
});

test('one account cannot redeem another account phone-change challenge', async () => {
  const attacker = await authenticatedUser('customer');
  const victim = await authenticatedUser('customer');

  const start = await api()
    .post('/api/auth/phone/start')
    .set(auth(victim.accessToken))
    .send({ phone: '9111111111' });

  const stolen = await api()
    .post('/api/auth/phone/verify')
    .set(auth(attacker.accessToken))
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(stolen.status, 403);
  assert.equal(
    (await User.findById(attacker.user._id)).phone,
    attacker.user.phone,
    'the attacker must not acquire the number'
  );
});

test('a number already in use cannot be taken over', async () => {
  const { user: existing } = await createUser({ phone: '9111111111' });
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .post('/api/auth/phone/start')
    .set(auth(accessToken))
    .send({ phone: existing.phone });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DUPLICATE');
});

test('moving the phone number signs other devices out', async () => {
  const { accessToken, user } = await authenticatedUser('customer');
  // A second device on the same account, authenticated against the OLD number.
  const other = await signIn({ phone: user.phone });
  assert.equal((await api().get('/api/auth/me').set(auth(other.accessToken))).status, 200);

  const start = await api()
    .post('/api/auth/phone/start')
    .set(auth(accessToken))
    .send({ phone: '9111111111' });
  await api()
    .post('/api/auth/phone/verify')
    .set(auth(accessToken))
    .send({ challengeId: start.body.challengeId, code: start.body.devCode })
    .expect(200);

  const stale = await api().get('/api/auth/me').set(auth(other.accessToken));
  assert.equal(stale.status, 401, 'a session issued against the old number must not survive');
});

test('a login code cannot be redeemed as a phone change', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const login = await api().post('/api/auth/otp/start').send({ phone: '9111111111' });

  const res = await api()
    .post('/api/auth/phone/verify')
    .set(auth(accessToken))
    .send({ challengeId: login.body.challengeId, code: login.body.devCode });

  assert.equal(res.status, 400, 'purpose must be part of what a challenge authorises');
  assert.equal((await User.findById(user._id)).phone, user.phone);
});

/**
 * The dev sign-in is not merely disabled without DEV_LOGIN, it is never mounted.
 * This file does not set the flag, so it is the place that can prove the absence.
 * devLogin.test.js sets it and covers the enabled behaviour.
 */
test('the dev sign-in route does not exist without DEV_LOGIN', async () => {
  const { user } = await authenticatedUser('developer');

  const res = await api().get(`/api/auth/dev/login?phone=${user.phone}`);

  assert.equal(res.status, 404);
  assert.equal(res.headers['set-cookie'], undefined, 'no session is established');
});
