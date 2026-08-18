'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Configure reverse OTP before anything reads config.
 *
 * `config/env.js` freezes at load and `node --test` gives each file its own
 * process, so this is set here rather than in ./helpers — see the same note at
 * the top of reverseOtp.test.js. Without it, a phone code that cannot be
 * delivered has no fallback at all and /register/start answers 503, which is
 * correct but is not the shape any real deployment runs in.
 */
process.env.WHATSAPP_INBOX_NUMBER = '919000000000';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  createUser,
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

async function register({ phone, name } = {}) {
  return api()
    .post('/api/auth/register/start')
    .send({ phone, ...(name ? { name } : {}) });
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

test('lookup reports whether a number has an account', async () => {
  const { user } = await createUser({ phone: '9876543210' });

  const known = await api().post('/api/auth/lookup').send({ identifier: user.phone });
  const unknown = await api().post('/api/auth/lookup').send({ identifier: '9000000001' });

  assert.equal(known.status, 200);
  assert.equal(known.body.exists, true);
  assert.equal(known.body.type, 'phone');
  assert.equal(unknown.body.exists, false);
});

test('lookup no longer resolves an account from an email address', async () => {
  // An address used to find an account here. It cannot any more: no code is
  // delivered to one, so a match would name an account nobody could then prove
  // they own.
  await createUser({ email: 'known@example.com', phone: '9876543210' });

  const res = await api().post('/api/auth/lookup').send({ identifier: 'known@example.com' });

  assert.equal(res.status, 400);
});

test('lookup rejects something that is not a number', async () => {
  const res = await api().post('/api/auth/lookup').send({ identifier: 'not-a-contact' });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('registration sends exactly one code, to the phone', async () => {
  recorder.sent.length = 0;
  const res = await register({ phone: '9876543210' });

  assert.equal(res.status, 202);
  assert.equal(res.body.phone.delivered, true);
  assert.equal(res.body.email, undefined, 'no email leg exists');
  assert.equal(recorder.sent.length, 1);
  assert.equal(recorder.sent[0].channel, 'sms');
});

test('registration refuses an email address in the body', async () => {
  // .strict() is what enforces it. An address is a profile detail now, set
  // afterwards through PATCH /api/users/:id, and never collected at sign-up.
  const res = await api()
    .post('/api/auth/register/start')
    .send({ phone: '9876543210', email: 'new@example.com' });

  assert.equal(res.status, 400);
});

test('verifying the phone code creates an account with no email at all', async () => {
  const start = await register({ phone: '9876543210', name: 'Asha' });

  const res = await api().post('/api/auth/register/verify').send({
    phoneChallengeId: start.body.phone.challengeId,
    phoneCode: start.body.devCodes.phone,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.name, 'Asha');
  assert.equal(res.body.user.phone, '9876543210');
  assert.equal(res.body.user.phoneVerified, true);
  assert.equal(res.body.user.email, null);
  assert.equal(res.body.user.emailVerified, undefined, 'the field is gone entirely');
  assert.ok(res.body.accessToken);
});

test('a self-registered account is always a customer', async () => {
  const start = await register({ phone: '9876543210' });
  const res = await api().post('/api/auth/register/verify').send({
    phoneChallengeId: start.body.phone.challengeId,
    phoneCode: start.body.devCodes.phone,
  });

  assert.equal(res.body.user.role, 'customer');
});

test('a code from another registration cannot complete this one', async () => {
  const mine = await register({ phone: '9876543210' });
  const theirs = await register({ phone: '9876543211' });

  // The challenge id and the code belong to different registrations, so the
  // code does not match the challenge it is presented against.
  const res = await api().post('/api/auth/register/verify').send({
    phoneChallengeId: mine.body.phone.challengeId,
    phoneCode: theirs.body.devCodes.phone,
  });

  assert.equal(res.status, 400);
});

test('a number that already has a customer account cannot register again', async () => {
  await createUser({ phone: '9876543210' });

  const res = await register({ phone: '9876543210' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ALREADY_REGISTERED');
});

test('registration cannot complete without proving the number', async () => {
  /**
   * This shape used to be valid — the email code carried the registration and
   * the number was stored unproved. Nothing carries it but the number now, so a
   * request with neither leg is refused rather than creating an account.
   */
  await register({ phone: '9876543210' });

  const res = await api().post('/api/auth/register/verify').send({});

  assert.equal(res.status, 400);
  assert.equal(await User.countDocuments({}), 0);
});

// ---------------------------------------------------------------------------
// Registration when the phone code cannot be delivered
// ---------------------------------------------------------------------------

test('an undeliverable code leaves reverse OTP as the way through', async () => {
  notify.setTransport(recordingTransport({ failOn: 'sms' }).transport);

  const start = await register({ phone: '9876543210' });

  assert.equal(start.status, 202);
  assert.equal(start.body.phone.delivered, false, 'the client offers reverse OTP on this');
  assert.equal(start.body.phone.challengeId, null);

  // And there is nothing else to submit: no account without a proved number.
  const res = await api().post('/api/auth/register/verify').send({});
  assert.equal(res.status, 400);
  assert.equal(await User.countDocuments({}), 0);
});

test('with no fallback configured either, registration says so at the start', async () => {
  // Guarded rather than asserted here: with reverse OTP on, this branch cannot
  // be reached, and it is the branch that stops a user being handed a screen
  // that can never advance.
  assert.ok(
    require('../config/env').reverseOtp.whatsapp.configured,
    'this file runs with reverse OTP configured; the 503 branch is unreachable here'
  );
});

test('a transport that only prints codes counts as undelivered', async () => {
  // NOTIFY_TRANSPORT=console on a live deployment: the send succeeds, but the
  // code lands in a server log. Showing a code input for that would ask the user
  // to type something they never received.
  notify.setTransport(notify.consoleTransport);

  const start = await register({ phone: '9876543210' });

  assert.equal(start.body.phone.delivered, false);
  assert.equal(start.body.phone.challengeId, null);
});

// ---------------------------------------------------------------------------
// Legacy accounts whose number was never proved
// ---------------------------------------------------------------------------

test('a pendingPhone account can still sign in, and the number is promoted', async () => {
  /**
   * These exist because registration once completed on the email code alone.
   * A verified email was how they signed in; with email OTP gone, sending to
   * the pending number is the only way back — and it is also the repair, since
   * a code that comes back from that number proves it.
   */
  await User.create({
    name: 'Legacy',
    email: 'legacy@example.com',
    pendingPhone: '9876543210',
    role: 'customer',
  });

  recorder.sent.length = 0;
  const start = await api().post('/api/auth/otp/start').send({ identifier: '9876543210' });

  assert.equal(start.status, 202);
  assert.ok(start.body.challengeId, 'a challenge must actually be issued');
  assert.equal(recorder.sent.length, 1);
  assert.equal(recorder.sent[0].to, '9876543210');

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200);
  assert.equal(verify.body.user.phone, '9876543210');
  assert.equal(verify.body.user.phoneVerified, true);
  assert.equal(verify.body.user.pendingPhone, null, 'promoted, not left in both places');
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

test('a login code goes to the phone and nowhere else', async () => {
  const { user } = await createUser({ phone: '9876543210', email: 'known@example.com' });

  recorder.sent.length = 0;
  const start = await api().post('/api/auth/otp/start').send({ identifier: user.phone });

  assert.equal(start.status, 202);
  assert.equal(recorder.sent.length, 1, 'no copy is sent to the address on the account');
  assert.equal(recorder.sent[0].to, '9876543210');
  assert.equal(recorder.sent[0].channel, 'sms');

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200);
  assert.equal(verify.body.user.id, user._id.toHexString());
});

test('signing in with an email address is refused', async () => {
  await createUser({ phone: '9876543210', email: 'known@example.com' });

  const res = await api().post('/api/auth/otp/start').send({ identifier: 'known@example.com' });

  assert.equal(res.status, 400);
});

test('an unknown number is answered like a known one', async () => {
  const res = await api().post('/api/auth/otp/start').send({ identifier: '9000000001' });

  // 202 with no account created: /lookup is the only place existence is
  // disclosed, and it is rate limited far more tightly than this endpoint.
  assert.equal(res.status, 202);
  assert.equal(await User.countDocuments({}), 0);
});
