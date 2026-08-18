'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, api } = require('./helpers');

const notify = require('../services/notify');
const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/**
 * Delivery agent self-registration — the same dual-OTP flow as customer and
 * vendor signup, differing only in the endpoint, which is what selects the
 * `delivery` role.
 *
 * These live in their own file rather than auth.test.js because the dual-OTP
 * assertions need BOTH legs to deliver, and the default test transport reports
 * `reachesRecipient: false` — the setting that makes the "WhatsApp
 * unavailable" branch testable elsewhere and would quietly send every
 * assertion here down the single-leg path instead. Same reasoning, and the
 * same override, as the vendor registration tests in kyc.test.js.
 */
test.beforeEach(() => {
  notify.setTransport({ name: 'recording', async send() {} });
});
test.afterEach(() => notify.setTransport(null));

test('delivery registration proves the number before creating an account', async () => {
  const start = await api()
    .post('/api/auth/delivery/register/start')
    .send({ phone: '9876543210', name: 'New Rider' });

  assert.equal(start.status, 202);
  assert.ok(start.body.phone.delivered);
  assert.equal(
    await User.countDocuments({ phone: '9876543210' }),
    0,
    'the account must not exist until the number is proved'
  );

  const verify = await api()
    .post('/api/auth/delivery/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(verify.status, 201);
  assert.equal(verify.body.user.role, 'delivery');

  const created = await User.findOne({ phone: '9876543210' });
  assert.equal(created.role, 'delivery');
  assert.equal(created.phone, '9876543210');
});

test('a customer registration code cannot be redeemed as a delivery registration', async () => {
  const start = await api()
    .post('/api/auth/register/start')
    .send({ phone: '9876543212' });

  // Same code, wrong endpoint: the OTP purpose differs (`registration` vs
  // `delivery_registration`), so verifyChallenge must refuse it outright.
  // Without this, any customer signup could be escalated into a rider account.
  const res = await api()
    .post('/api/auth/delivery/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'OTP_INVALID');
  assert.equal(await User.findOne({ phone: '9876543212' }), null);
});

test('a vendor registration code cannot be redeemed as a delivery registration', async () => {
  const start = await api()
    .post('/api/auth/vendor/register/start')
    .send({ phone: '9876543213' });

  // The two privileged sign-ups must be isolated from EACH OTHER, not merely
  // from the customer one — otherwise whichever is vetted more loosely becomes
  // a way into the other role.
  const res = await api()
    .post('/api/auth/delivery/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'OTP_INVALID');
  assert.equal(await User.findOne({ phone: '9876543213' }), null);
});

test('a delivery registration code cannot be redeemed as a customer registration', async () => {
  const start = await api()
    .post('/api/auth/delivery/register/start')
    .send({ phone: '9876543214' });

  const res = await api()
    .post('/api/auth/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'OTP_INVALID');
  assert.equal(await User.findOne({ phone: '9876543214' }), null);
});

test('the delivery role comes from the route, never from the request body', async () => {
  const res = await api()
    .post('/api/auth/delivery/register/start')
    // A body field that must be ignored rather than honoured. `.strict()`
    // refuses it outright, which is the strongest form of ignoring it.
    .send({ phone: '9876543215', role: 'developer' });

  assert.equal(res.status, 400, 'an unexpected body field must be refused, not silently dropped');
  assert.equal(await User.findOne({ phone: '9876543215' }), null);
});

test('a self-registered rider starts off duty and holds no location', async () => {
  const start = await api()
    .post('/api/auth/delivery/register/start')
    .send({ phone: '9876543216' });

  const verify = await api()
    .post('/api/auth/delivery/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  /**
   * Immediate access is the product decision, but becoming dispatchable must
   * still take a deliberate act: findNearestRider requires `online` AND a
   * fresh position, and registration supplies neither. If this ever fails,
   * a brand-new account is being handed live pickups — with the customer's
   * name, phone, address and COD cash — at the moment it is created.
   */
  assert.equal(verify.status, 201);
  const created = await User.findOne({ phone: '9876543216' });
  assert.equal(created.rider?.dutyStatus || 'offline', 'offline');
  assert.equal(created.rider?.lastLocation, undefined);
  assert.equal(verify.body.user.dutyStatus, 'offline');
});

test('a rider who registered can sign in again and keeps the delivery role', async () => {
  const start = await api()
    .post('/api/auth/delivery/register/start')
    .send({ phone: '9876543217' });

  await api()
    .post('/api/auth/delivery/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  // The ordinary login flow, which creates a `customer` for an unknown number.
  // An existing rider must come back as a rider, not be downgraded by it.
  const login = await api().post('/api/auth/otp/start').send({ phone: '9876543217' });
  const session = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: login.body.challengeId, code: login.body.devCode });

  assert.equal(session.status, 200);
  assert.equal(session.body.user.role, 'delivery');
});
