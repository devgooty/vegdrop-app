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
} = require('./helpers');

const notify = require('../services/notify');
const User = require('../models/User');
const { ApiError } = require('../middleware/errors');

test.before(startTestServer);
test.after(stopTestServer);

function recordingTransport({ failOn = null } = {}) {
  const sent = [];
  return {
    sent,
    transport: {
      name: 'recording',
      async send(message) {
        if (failOn && message.channel === failOn) {
          throw new ApiError(503, 'undeliverable', 'OTP_DELIVERY_FAILED');
        }
        sent.push(message);
      },
    },
  };
}

let recorder;

test.beforeEach(async () => {
  await resetDatabase();
  recorder = recordingTransport();
  notify.setTransport(recorder.transport);
});

test.afterEach(() => notify.setTransport(null));

async function register({ phone, email, name } = {}) {
  const start = await api()
    .post('/api/auth/register/start')
    .send({ phone, email, ...(name ? { name } : {}) });
  return start;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

test('lookup reports an existing phone and an unknown one differently', async () => {
  const { user } = await createUser({ phone: '9876543210' });

  const known = await api().post('/api/auth/lookup').send({ identifier: user.phone });
  const unknown = await api().post('/api/auth/lookup').send({ identifier: '9000000001' });

  assert.equal(known.status, 200);
  assert.equal(known.body.exists, true);
  assert.equal(known.body.type, 'phone');
  assert.equal(unknown.body.exists, false);
});

test('lookup accepts an email and reports its type', async () => {
  const { user } = await createUser({ email: 'known@example.com' });

  const res = await api().post('/api/auth/lookup').send({ identifier: 'known@example.com' });

  assert.equal(res.body.exists, true);
  assert.equal(res.body.type, 'email');
  assert.ok(user);
});

test('lookup rejects something that is neither', async () => {
  const res = await api().post('/api/auth/lookup').send({ identifier: 'not-a-contact' });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Registration, both codes deliverable
// ---------------------------------------------------------------------------

test('registration sends two DIFFERENT codes, one per contact', async () => {
  recorder.sent.length = 0;
  const res = await register({ phone: '9876543210', email: 'new@example.com' });

  assert.equal(res.status, 202);
  assert.equal(res.body.phone.delivered, true);
  assert.equal(res.body.email.delivered, true);
  assert.equal(recorder.sent.length, 2);

  const codes = new Set(recorder.sent.map((m) => m.otp.code));
  assert.equal(codes.size, 2, 'each contact must be proved independently');
});

test('verifying both codes creates an account with both contacts verified', async () => {
  const start = await register({ phone: '9876543210', email: 'new@example.com', name: 'Asha' });

  const res = await api().post('/api/auth/register/verify').send({
    emailChallengeId: start.body.email.challengeId,
    emailCode: start.body.devCodes.email,
    phoneChallengeId: start.body.phone.challengeId,
    phoneCode: start.body.devCodes.phone,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.name, 'Asha');
  assert.equal(res.body.user.phone, '9876543210');
  assert.equal(res.body.user.email, 'new@example.com');
  assert.equal(res.body.user.phoneVerified, true);
  assert.equal(res.body.user.emailVerified, true);
  assert.ok(res.body.accessToken);
});

test('a self-registered account is always a customer', async () => {
  const start = await register({ phone: '9876543210', email: 'new@example.com' });
  const res = await api().post('/api/auth/register/verify').send({
    emailChallengeId: start.body.email.challengeId,
    emailCode: start.body.devCodes.email,
    phoneChallengeId: start.body.phone.challengeId,
    phoneCode: start.body.devCodes.phone,
  });

  assert.equal(res.body.user.role, 'customer');
});

test('codes from two different registrations cannot be combined', async () => {
  const mine = await register({ phone: '9876543210', email: 'mine@example.com' });
  const theirs = await register({ phone: '9876543211', email: 'theirs@example.com' });

  const res = await api().post('/api/auth/register/verify').send({
    emailChallengeId: mine.body.email.challengeId,
    emailCode: mine.body.devCodes.email,
    phoneChallengeId: theirs.body.phone.challengeId,
    phoneCode: theirs.body.devCodes.phone,
  });

  assert.equal(res.status, 400);
  assert.equal(await User.countDocuments({}), 0);
});

test('registering against an already-verified contact is refused', async () => {
  await createUser({ phone: '9876543210', email: 'taken@example.com' });

  const byPhone = await register({ phone: '9876543210', email: 'other@example.com' });
  const byEmail = await register({ phone: '9000000002', email: 'taken@example.com' });

  assert.equal(byPhone.status, 409);
  assert.equal(byEmail.status, 409);
});

// ---------------------------------------------------------------------------
// Registration while WhatsApp is down
// ---------------------------------------------------------------------------

test('registration continues when the phone code cannot be delivered', async () => {
  notify.setTransport(recordingTransport({ failOn: 'sms' }).transport);

  const start = await register({ phone: '9876543210', email: 'new@example.com' });

  assert.equal(start.status, 202);
  assert.equal(start.body.phone.delivered, false, 'the client hides the phone code input on this');
  assert.equal(start.body.phone.challengeId, null);
  assert.equal(start.body.email.delivered, true);

  const res = await api().post('/api/auth/register/verify').send({
    emailChallengeId: start.body.email.challengeId,
    emailCode: start.body.devCodes.email,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.emailVerified, true);
  assert.equal(res.body.user.phoneVerified, false);
  // Stored for the courier and for a later retry, but not as the credential.
  assert.equal(res.body.user.phone, null);
  assert.equal(res.body.user.pendingPhone, '9876543210');
});

test('a transport that only prints codes counts as undelivered', async () => {
  // NOTIFY_TRANSPORT=console on a live deployment: the send succeeds, but the
  // code lands in a server log. Showing a code input for that would ask the user
  // to type something they never received.
  notify.setTransport(notify.consoleTransport);

  const start = await register({ phone: '9876543210', email: 'new@example.com' });

  assert.equal(start.body.phone.delivered, false);
  assert.equal(start.body.phone.challengeId, null);
});

test('an unproven number reserves nothing and the real owner can still claim it', async () => {
  // A squatter registers someone else's number while WhatsApp is down.
  notify.setTransport(recordingTransport({ failOn: 'sms' }).transport);
  const squat = await register({ phone: '9876543210', email: 'squatter@example.com' });
  await api().post('/api/auth/register/verify').send({
    emailChallengeId: squat.body.email.challengeId,
    emailCode: squat.body.devCodes.email,
  });

  // WhatsApp recovers; the real owner registers the same number.
  notify.setTransport(recorder.transport);
  const owner = await register({ phone: '9876543210', email: 'owner@example.com' });
  assert.equal(owner.status, 202, 'an unproven number must not block the real owner');

  const res = await api().post('/api/auth/register/verify').send({
    emailChallengeId: owner.body.email.challengeId,
    emailCode: owner.body.devCodes.email,
    phoneChallengeId: owner.body.phone.challengeId,
    phoneCode: owner.body.devCodes.phone,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.phone, '9876543210');
  assert.equal(res.body.user.phoneVerified, true);
});

test('an unproven number never receives a login code', async () => {
  notify.setTransport(recordingTransport({ failOn: 'sms' }).transport);
  const start = await register({ phone: '9876543210', email: 'new@example.com' });
  await api().post('/api/auth/register/verify').send({
    emailChallengeId: start.body.email.challengeId,
    emailCode: start.body.devCodes.email,
  });

  notify.setTransport(recorder.transport);
  recorder.sent.length = 0;

  await api().post('/api/auth/otp/start').send({ identifier: 'new@example.com' });

  assert.equal(recorder.sent.length, 1);
  assert.equal(recorder.sent[0].to, 'new@example.com');
});

test('someone who registered without a proven phone can sign in by typing it', async () => {
  notify.setTransport(recordingTransport({ failOn: 'sms' }).transport);
  const start = await register({ phone: '9876543210', email: 'new@example.com' });
  await api().post('/api/auth/register/verify').send({
    emailChallengeId: start.body.email.challengeId,
    emailCode: start.body.devCodes.email,
  });

  notify.setTransport(recorder.transport);
  recorder.sent.length = 0;

  // They only know the number they typed, so lookup has to find them by it.
  const found = await api().post('/api/auth/lookup').send({ identifier: '9876543210' });
  assert.equal(found.body.exists, true);

  const login = await api().post('/api/auth/otp/start').send({ identifier: '9876543210' });
  assert.equal(login.status, 202);

  // Delivered to the verified email, not to the unproven number.
  assert.equal(recorder.sent.length, 1);
  assert.equal(recorder.sent[0].to, 'new@example.com');

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: login.body.challengeId, code: login.body.devCode });

  assert.equal(verify.status, 200);
});

// ---------------------------------------------------------------------------
// Signing in with either identifier
// ---------------------------------------------------------------------------

test('an existing user can sign in by email', async () => {
  const { user } = await createUser({ phone: '9876543210', email: 'known@example.com' });

  const start = await api().post('/api/auth/otp/start').send({ identifier: 'known@example.com' });
  assert.equal(start.status, 202);

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200);
  assert.equal(verify.body.user.id, user._id.toHexString());
});

test('signing in by either identifier reaches both verified contacts with one code', async () => {
  const { user } = await createUser({ phone: '9876543210', email: 'known@example.com' });
  await signIn({ phone: user.phone });

  recorder.sent.length = 0;
  await api().post('/api/auth/otp/start').send({ identifier: 'known@example.com' });

  assert.equal(recorder.sent.length, 2);
  const codes = new Set(recorder.sent.map((m) => m.otp.code));
  assert.equal(codes.size, 1, 'a login code is shared across channels');
});

test('an unknown email is answered like a known one', async () => {
  const res = await api().post('/api/auth/otp/start').send({ identifier: 'nobody@example.com' });

  // 202 with no code sent: /lookup is the only place existence is disclosed, and
  // it is rate limited far more tightly than this endpoint.
  assert.equal(res.status, 202);
  assert.equal(await User.countDocuments({}), 0);
});
