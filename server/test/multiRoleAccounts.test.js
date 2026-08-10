'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  createUser,
  authenticatedUser,
  auth,
} = require('./helpers');

const User = require('../models/User');
const notify = require('../services/notify');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

// The dual-OTP registration tests below need BOTH legs to deliver — mirroring
// kyc.test.js's own setup — because the default test transport reports
// `reachesRecipient: false`, which is what makes the "WhatsApp unavailable"
// branch testable elsewhere but would silently skip the phone leg here.
test.beforeEach(() => {
  notify.setTransport({ name: 'recording', async send() {} });
});
test.afterEach(() => notify.setTransport(null));

/**
 * One contact can now back a separate customer, shopkeeper and delivery
 * account — uniqueness on User moved from `(email)` / `(phone)` to
 * `(email, role)` / `(phone, role)`. See the long comment on models/User.js
 * for why, and `APP_ROLE_SCOPE` in routes/auth.js for how sign-in resolves
 * which of them an app is asking about.
 */

// ---------------------------------------------------------------------------
// Uniqueness is per (contact, role), not per contact
// ---------------------------------------------------------------------------

test('the same email can hold a customer, a shopkeeper and a delivery account at once', async () => {
  const email = 'triple@example.com';
  await createUser({ role: 'customer', email });
  await createUser({ role: 'shopkeeper', email });
  await createUser({ role: 'delivery', email });

  const accounts = await User.find({ email }).select('role').lean();
  assert.deepEqual(accounts.map((a) => a.role).sort(), ['customer', 'delivery', 'shopkeeper']);
});

test('registering a second delivery account for an email that already has one is still refused', async () => {
  const { user } = await createUser({ role: 'delivery' });

  const res = await api()
    .post('/api/auth/delivery/register/start')
    .send({ phone: '9876500001', email: user.email });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ALREADY_REGISTERED');
});

/**
 * The full symmetric matrix, proved rather than inferred.
 *
 * `startRegistrationChallenge` is one shared function scoped by a `role`
 * parameter — customer, shopkeeper and delivery registration are the same
 * code path with a different role and OTP purpose, not three separate
 * implementations. That is WHY every pairing here behaves the same way, but
 * "the mechanism is generic" is a claim about the code, not a test result.
 * Only two of the six directed pairs (customer→shopkeeper, both ways of the
 * same-role block) had actually been exercised through the real routes
 * elsewhere; this fills in the rest so the symmetry is demonstrated, not
 * assumed.
 */
const REGISTER_START_ENDPOINT = {
  customer: '/api/auth/register/start',
  shopkeeper: '/api/auth/vendor/register/start',
  delivery: '/api/auth/delivery/register/start',
};

const SELF_SERVICE_ROLES_UNDER_TEST = ['customer', 'shopkeeper', 'delivery'];

let phoneCounter = 0;
function nextTestPhone() {
  phoneCounter += 1;
  return `98765${String(10000 + phoneCounter)}`;
}

for (const existingRole of SELF_SERVICE_ROLES_UNDER_TEST) {
  for (const registeringRole of SELF_SERVICE_ROLES_UNDER_TEST) {
    if (existingRole === registeringRole) continue; // the same-role block is covered separately, per role

    test(`an existing ${existingRole} account does not block registering a ${registeringRole} account for the same email`, async () => {
      const { user } = await createUser({ role: existingRole });

      const res = await api()
        .post(REGISTER_START_ENDPOINT[registeringRole])
        .send({ phone: nextTestPhone(), email: user.email });

      assert.equal(
        res.status,
        202,
        `registering ${registeringRole} should succeed when only a ${existingRole} account holds this email`
      );
    });
  }
}

test('a delivery account can be completed for an email that already has a shopkeeper account, and lands as a separate document', async () => {
  const email = 'shop-then-rider@example.com';
  const { user: shopkeeper } = await createUser({ role: 'shopkeeper', email });

  const start = await api()
    .post('/api/auth/delivery/register/start')
    .send({ phone: '9876500099', email });
  assert.equal(start.status, 202);

  const verify = await api()
    .post('/api/auth/delivery/register/verify')
    .send({
      emailChallengeId: start.body.email.challengeId,
      emailCode: start.body.devCodes.email,
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(verify.status, 201);
  assert.equal(verify.body.user.role, 'delivery');
  assert.notEqual(verify.body.user.id, shopkeeper.id);

  const accounts = await User.find({ email }).select('role').lean();
  assert.deepEqual(accounts.map((a) => a.role).sort(), ['delivery', 'shopkeeper']);
});

// ---------------------------------------------------------------------------
// Sign-in resolves the account for the asking app, not just any account
// ---------------------------------------------------------------------------

test('lookup on the shopkeeper app does not see a customer-only email', async () => {
  const { user } = await createUser({ role: 'customer' });

  const res = await api()
    .post('/api/auth/lookup')
    .send({ identifier: user.email, app: 'shopkeeper' });

  assert.equal(res.status, 200);
  assert.equal(res.body.exists, false);
});

test('lookup on the customer app does not see a shopkeeper-only email', async () => {
  const { user } = await createUser({ role: 'shopkeeper' });

  const res = await api()
    .post('/api/auth/lookup')
    .send({ identifier: user.email, app: 'customer' });

  assert.equal(res.status, 200);
  assert.equal(res.body.exists, false);
});

test('lookup on the shopkeeper app finds the shopkeeper account when both exist', async () => {
  const email = 'both@example.com';
  await createUser({ role: 'customer', email });
  await createUser({ role: 'shopkeeper', email });

  const res = await api().post('/api/auth/lookup').send({ identifier: email, app: 'shopkeeper' });

  assert.equal(res.body.exists, true);
});

test('signing in on the shopkeeper app reaches the shopkeeper account, not the customer one sharing its email', async () => {
  const email = 'both-signin@example.com';
  const { user: customer } = await createUser({ role: 'customer', email });
  const { user: shopkeeper } = await createUser({ role: 'shopkeeper', email });

  const start = await api()
    .post('/api/auth/otp/start')
    .send({ identifier: email, app: 'shopkeeper' });
  assert.equal(start.status, 202);
  assert.ok(start.body.challengeId, 'a real challenge is issued for the scoped match');

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 200);
  assert.equal(verify.body.user.role, 'shopkeeper');
  assert.equal(verify.body.user.id, shopkeeper.id);
  assert.notEqual(verify.body.user.id, customer.id);
});

test('a bare phone with no scoped match on the delivery app does not silently create a customer account', async () => {
  // Before app-scoping, ANY unmatched phone fell through to the auto-create
  // branch and minted a `customer` account regardless of which app asked —
  // the exact bug that made a rider's first sign-in create an account the
  // delivery app then refused to show them.
  const res = await api()
    .post('/api/auth/otp/start')
    .send({ phone: '9876500002', app: 'delivery' });

  assert.equal(res.status, 202);
  assert.equal(res.body.challengeId, null, 'no real challenge is issued for an unscoped miss');

  const created = await User.countDocuments({ phone: '9876500002' });
  assert.equal(created, 0, 'nothing was created for an app that never auto-creates');
});

test('a bare phone with no account on the customer app still auto-creates, unchanged', async () => {
  const start = await api()
    .post('/api/auth/otp/start')
    .send({ phone: '9876500003', app: 'customer' });

  assert.equal(start.status, 202);
  assert.ok(start.body.challengeId);

  const verify = await api()
    .post('/api/auth/otp/verify')
    .send({ challengeId: start.body.challengeId, code: start.body.devCode });

  assert.equal(verify.status, 201);
  assert.equal(verify.body.user.role, 'customer');
});

test('omitting app entirely keeps the old unrestricted lookup, for callers that predate scoping', async () => {
  const { user } = await createUser({ role: 'shopkeeper' });

  const res = await api().post('/api/auth/lookup').send({ identifier: user.email });

  assert.equal(res.body.exists, true);
});

// ---------------------------------------------------------------------------
// Promoting an account into a role its own identity already holds elsewhere
// ---------------------------------------------------------------------------

test('promoting an account into a role its own email already holds elsewhere is refused', async () => {
  const email = 'promote-collision@example.com';
  const { user: customer } = await createUser({ role: 'customer', email });
  await createUser({ role: 'shopkeeper', email });

  const admin = await authenticatedUser('developer');

  const res = await api()
    .patch(`/api/users/${customer.id}/role`)
    .set(auth(admin.accessToken))
    .send({ role: 'shopkeeper' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ROLE_ALREADY_HELD');

  const unchanged = await User.findById(customer.id);
  assert.equal(unchanged.role, 'customer');
});

test('promoting an account into a role nothing else holds still works', async () => {
  const { user: target } = await createUser({ role: 'customer' });
  const admin = await authenticatedUser('developer');

  const res = await api()
    .patch(`/api/users/${target.id}/role`)
    .set(auth(admin.accessToken))
    .send({ role: 'market_owner' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.role, 'market_owner');
});
