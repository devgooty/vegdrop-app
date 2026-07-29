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

test('registration issues a challenge and does not return a token', async () => {
  const res = await api().post('/api/auth/register/start').send({
    name: 'Asha Rao',
    phone: '9876543210',
    email: 'asha@example.com',
    password: 'CorrectHorse9!',
  });

  assert.equal(res.status, 202);
  assert.ok(res.body.challengeId, 'expected a challengeId');
  assert.equal(res.body.accessToken, undefined, 'no token may be issued before verification');
  // The destination is masked so the response cannot be used to confirm contacts.
  assert.match(res.body.destination, /\*/);
});

test('a self-registered account is always a customer, even when role is supplied', async () => {
  const res = await api().post('/api/auth/register/start').send({
    name: 'Escalation Attempt',
    phone: '9876543211',
    email: 'escalate@example.com',
    password: 'CorrectHorse9!',
    role: 'developer',
  });

  // .strict() rejects the unknown key outright rather than ignoring it.
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');

  const clean = await api().post('/api/auth/register/start').send({
    name: 'Escalation Attempt',
    phone: '9876543211',
    email: 'escalate@example.com',
    password: 'CorrectHorse9!',
  });
  const verified = await api()
    .post('/api/auth/register/verify')
    .send({ challengeId: clean.body.challengeId, code: clean.body.devCode });

  assert.equal(verified.status, 201);
  assert.equal(verified.body.user.role, 'customer');
});

test('weak passwords are rejected', async () => {
  const res = await api().post('/api/auth/register/start').send({
    name: 'Weak',
    phone: '9876543212',
    password: 'password123',
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'WEAK_PASSWORD');
});

test('login with a wrong password never issues a token', async () => {
  const { user } = await createUser({ password: 'CorrectHorse9!' });

  const res = await api().post('/api/auth/login').send({
    identifier: user.email,
    password: 'WrongPassword1!',
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(res.body.accessToken, undefined);
});

test('unknown and wrong-password failures are indistinguishable', async () => {
  const { user } = await createUser({ password: 'CorrectHorse9!' });

  const wrongPassword = await api()
    .post('/api/auth/login')
    .send({ identifier: user.email, password: 'WrongPassword1!' });

  const unknownUser = await api()
    .post('/api/auth/login')
    .send({ identifier: 'nobody@example.com', password: 'WrongPassword1!' });

  assert.equal(wrongPassword.status, unknownUser.status);

  // requestId is a per-request correlation id and is expected to differ; the
  // rest of the envelope must be byte-identical so the response cannot be used
  // to test whether an account exists.
  const withoutRequestId = ({ error }) => ({ code: error.code, message: error.message });
  assert.deepEqual(withoutRequestId(wrongPassword.body), withoutRequestId(unknownUser.body));
});

test('password alone does not authenticate: step 1 returns no token', async () => {
  const { user, password } = await createUser({ password: 'CorrectHorse9!' });

  const res = await api().post('/api/auth/login').send({ identifier: user.email, password });

  assert.equal(res.status, 202, 'correct password yields a challenge, not a session');
  assert.equal(res.body.accessToken, undefined);
  assert.ok(res.body.challengeId);
});

test('an incorrect OTP is rejected and the challenge dies after max attempts', async () => {
  const { user, password } = await createUser({ password: 'CorrectHorse9!' });
  const start = await api().post('/api/auth/login').send({ identifier: user.email, password });

  const wrong = start.body.devCode === '000000' ? '111111' : '000000';

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await api()
      .post('/api/auth/login/verify')
      .send({ challengeId: start.body.challengeId, code: wrong });
  }
  assert.ok([400, 429].includes(last.status));

  // Even the correct code must fail once the attempt budget is spent.
  const afterExhaustion = await api()
    .post('/api/auth/login/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.notEqual(afterExhaustion.status, 200, 'exhausted challenge must not authenticate');
});

test('an OTP cannot be replayed', async () => {
  const { user, password } = await createUser({ password: 'CorrectHorse9!' });
  const start = await api().post('/api/auth/login').send({ identifier: user.email, password });

  const first = await api()
    .post('/api/auth/login/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });
  assert.equal(first.status, 200);

  const replay = await api()
    .post('/api/auth/login/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });
  assert.notEqual(replay.status, 200, 'a consumed challenge must not authenticate again');
});

test('repeated failures lock the account', async () => {
  const { user } = await createUser({ password: 'CorrectHorse9!' });

  let last;
  for (let i = 0; i < 9; i += 1) {
    last = await api()
      .post('/api/auth/login')
      .send({ identifier: user.email, password: `Wrong${i}Password!` });
  }

  assert.equal(last.status, 423);
  assert.equal(last.body.error.code, 'ACCOUNT_LOCKED');

  // Correct credentials are refused while the lock is in force.
  const correct = await api()
    .post('/api/auth/login')
    .send({ identifier: user.email, password: 'CorrectHorse9!' });
  assert.equal(correct.status, 423);
});

test('a NoSQL operator payload cannot bypass the password check', async () => {
  await createUser({ email: 'victim@example.com', password: 'CorrectHorse9!' });

  const res = await api()
    .post('/api/auth/login')
    .send({ identifier: { $ne: null }, password: { $ne: null } });

  assert.equal(res.status, 400, 'operator objects must be rejected as invalid types');
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('phone matching is exact, not a substring', async () => {
  await createUser({ phone: '9876543210', password: 'CorrectHorse9!' });

  // The old implementation matched any identifier of 4+ chars via .includes().
  const res = await api()
    .post('/api/auth/login')
    .send({ identifier: '9876', password: 'CorrectHorse9!' });

  assert.equal(res.status, 401);
});

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
  await User.updateOne({ _id: user._id }, { $set: { role: 'market_owner' } });

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

test('changing a password revokes every other session', async () => {
  const { accessToken, user, password } = await authenticatedUser('customer');
  const other = await signIn({ identifier: user.email, password });

  const res = await api()
    .post('/api/auth/password')
    .set(auth(accessToken))
    .send({ currentPassword: password, newPassword: 'BrandNewSecret42!' });
  assert.equal(res.status, 200);

  const stale = await api().get('/api/auth/me').set(auth(other.accessToken));
  assert.equal(stale.status, 401, 'the other device must be signed out');
});

test('logout-all invalidates outstanding access tokens immediately', async () => {
  const { accessToken } = await authenticatedUser('customer');

  assert.equal((await api().get('/api/auth/me').set(auth(accessToken))).status, 200);

  await api().post('/api/auth/logout-all').set(auth(accessToken)).expect(204);

  const after = await api().get('/api/auth/me').set(auth(accessToken));
  assert.equal(after.status, 401);
});

test('a suspended account cannot use an existing token', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await User.updateOne({ _id: user._id }, { $set: { status: 'suspended' } });

  const res = await api().get('/api/auth/me').set(auth(accessToken));
  assert.equal(res.status, 401);
});
