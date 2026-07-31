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

const notify = require('../services/notify');
const User = require('../models/User');
const { ApiError } = require('../middleware/errors');

test.before(startTestServer);
test.after(stopTestServer);

/** Records every delivery so a test can assert where a code actually went. */
function recordingTransport({ failOn = null } = {}) {
  const sent = [];
  return {
    sent,
    transport: {
      name: 'recording',
      async send(message) {
        if (failOn && message.channel === failOn) {
          // The same shape both real transports throw. A plain Error would
          // surface as a 500 and the test would be asserting the wrong contract.
          throw new ApiError(
            503,
            'Could not deliver the verification code. Please try again shortly.',
            'OTP_DELIVERY_FAILED'
          );
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

test.afterEach(() => {
  notify.setTransport(null);
});

/** Give a user a verified email the only way the API allows. */
async function verifyEmail(session, email) {
  const start = await api()
    .post('/api/auth/email/start')
    .set(auth(session.accessToken))
    .send({ email });

  assert.equal(start.status, 202, JSON.stringify(start.body));

  const verify = await api()
    .post('/api/auth/email/verify')
    .set(auth(session.accessToken))
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return verify.body.user;
}

// ---------------------------------------------------------------------------
// The takeover path this flow exists to close
// ---------------------------------------------------------------------------

test('the profile endpoint refuses to set an email', async () => {
  const session = await authenticatedUser();

  const before = await User.findById(session.user._id).lean();

  const res = await api()
    .patch(`/api/users/${session.user._id.toHexString()}`)
    .set(auth(session.accessToken))
    .send({ email: 'attacker@example.com' });

  // .strict() rejects the unknown key, so a session cannot point code delivery
  // at an address nobody proved control of.
  assert.equal(res.status, 400);

  const after = await User.findById(session.user._id).lean();
  assert.equal(after.email, before.email, 'the address must be untouched');
  assert.notEqual(after.email, 'attacker@example.com');
});

test('a name-only profile update still works', async () => {
  const session = await authenticatedUser();

  const res = await api()
    .patch(`/api/users/${session.user._id.toHexString()}`)
    .set(auth(session.accessToken))
    .send({ name: 'Renamed' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, 'Renamed');
});

// ---------------------------------------------------------------------------
// Verifying an address
// ---------------------------------------------------------------------------

test('verifying an email addresses the code to that email, not the phone', async () => {
  const session = await authenticatedUser();
  recorder.sent.length = 0;

  const start = await api()
    .post('/api/auth/email/start')
    .set(auth(session.accessToken))
    .send({ email: 'owner@example.com' });

  assert.equal(start.status, 202);
  assert.equal(recorder.sent.length, 1, 'exactly one message');
  assert.equal(recorder.sent[0].to, 'owner@example.com');
  assert.equal(recorder.sent[0].channel, 'email');
});

test('a verified email is recorded as verified', async () => {
  const session = await authenticatedUser();
  const user = await verifyEmail(session, 'owner@example.com');

  assert.equal(user.email, 'owner@example.com');
  assert.equal(user.emailVerified, true);
});

test('one account cannot verify an address already held by another', async () => {
  const first = await authenticatedUser();
  await verifyEmail(first, 'taken@example.com');

  const second = await authenticatedUser();
  const res = await api()
    .post('/api/auth/email/start')
    .set(auth(second.accessToken))
    .send({ email: 'taken@example.com' });

  assert.equal(res.status, 409);
});

test("an email challenge cannot be redeemed by another account's session", async () => {
  const owner = await authenticatedUser();
  const attacker = await authenticatedUser();

  const start = await api()
    .post('/api/auth/email/start')
    .set(auth(owner.accessToken))
    .send({ email: 'owner@example.com' });

  const res = await api()
    .post('/api/auth/email/verify')
    .set(auth(attacker.accessToken))
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(res.status, 403);
});

test('email verification requires authentication', async () => {
  const res = await api().post('/api/auth/email/start').send({ email: 'nobody@example.com' });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

test('a login code goes to both the phone and a verified email', async () => {
  const { user } = await createUser({ phone: '9876543210' });
  const session = await signIn({ phone: user.phone });
  await verifyEmail(session, 'owner@example.com');

  recorder.sent.length = 0;
  const res = await api().post('/api/auth/otp/start').send({ phone: user.phone });
  assert.equal(res.status, 202);

  assert.equal(recorder.sent.length, 2, 'phone and email');

  const destinations = recorder.sent.map((m) => m.to).sort();
  assert.deepEqual(destinations, ['9876543210', 'owner@example.com']);

  // Both copies must carry the SAME code — two different codes would mean only
  // one of them could ever verify.
  const codes = new Set(recorder.sent.map((m) => m.otp.code));
  assert.equal(codes.size, 1);
});

test('a login code is not copied to an unverified address', async () => {
  const { user } = await createUser({ phone: '9876543210' });
  // Written directly, simulating an address that never went through
  // /email/verify. The helper marks its users' emails verified, so the flag has
  // to be cleared explicitly or this would assert nothing.
  await User.updateOne(
    { _id: user._id },
    { $set: { email: 'unverified@example.com', emailVerifiedAt: null } }
  );

  recorder.sent.length = 0;
  await api().post('/api/auth/otp/start').send({ phone: user.phone });

  assert.equal(recorder.sent.length, 1);
  assert.equal(recorder.sent[0].to, user.phone);
});

test('a first-time sign-up sends only to the phone', async () => {
  recorder.sent.length = 0;
  const res = await api().post('/api/auth/otp/start').send({ phone: '9123456780' });

  assert.equal(res.status, 202);
  assert.equal(recorder.sent.length, 1);
  assert.equal(recorder.sent[0].channel, 'sms');
});

test('a code copied to email still verifies and issues a session', async () => {
  const { user } = await createUser({ phone: '9876543210' });
  const session = await signIn({ phone: user.phone });
  await verifyEmail(session, 'owner@example.com');

  const start = await api().post('/api/auth/otp/start').send({ phone: user.phone });
  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200);
  assert.ok(verify.body.accessToken);
});

// ---------------------------------------------------------------------------
// Failure isolation — the phone is the credential of record
// ---------------------------------------------------------------------------

test('a failing mail server does not break sign-in', async () => {
  const { user } = await createUser({ phone: '9876543210' });
  const session = await signIn({ phone: user.phone });
  await verifyEmail(session, 'owner@example.com');

  // Email now throws; the phone leg still succeeds.
  const failing = recordingTransport({ failOn: 'email' });
  notify.setTransport(failing.transport);

  const start = await api().post('/api/auth/otp/start').send({ phone: user.phone });

  assert.equal(start.status, 202, 'the copy is best effort and must not fail the request');
  assert.equal(failing.sent.length, 1);
  assert.equal(failing.sent[0].to, user.phone);

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200);
});

test('a failing phone transport does fail sign-in', async () => {
  const { user } = await createUser({ phone: '9876543210' });

  const failing = recordingTransport({ failOn: 'sms' });
  notify.setTransport(failing.transport);

  const res = await api().post('/api/auth/otp/start').send({ phone: user.phone });

  // The phone is the credential; if its code cannot be delivered there is no
  // sign-in to have. Contrast with the email case above.
  assert.equal(res.status, 503);
});

test('a phone delivery failure leaves no challenge behind to burn the cooldown', async () => {
  const { user } = await createUser({ phone: '9876543210' });

  const failing = recordingTransport({ failOn: 'sms' });
  notify.setTransport(failing.transport);
  await api().post('/api/auth/otp/start').send({ phone: user.phone });

  // A working transport must be able to issue immediately afterwards.
  notify.setTransport(recorder.transport);
  const res = await api().post('/api/auth/otp/start').send({ phone: user.phone });

  assert.equal(res.status, 202, 'a failed delivery must not arm the resend cooldown');
});
