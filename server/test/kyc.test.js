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

const notify = require('../services/notify');
const Product = require('../models/Product');
const User = require('../models/User');
const VendorKyc = require('../models/VendorKyc');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

// The vendor registration tests below need BOTH legs to deliver, mirroring
// registration.test.js's own setup: the default test transport reports
// `reachesRecipient: false`, which is what makes the "WhatsApp unavailable"
// branch testable elsewhere but would make every dual-OTP assertion here
// exercise the wrong path.
test.beforeEach(() => {
  notify.setTransport({ name: 'recording', async send() {} });
});
test.afterEach(() => notify.setTransport(null));

const VALID_DETAILS = {
  legalName: 'Ramesh Kumar',
  bankName: 'HDFC Bank',
  bankAccount: '123456789012',
  ifsc: 'HDFC0001234',
  upiVpa: 'ramesh@okhdfcbank',
};

async function seedProduct(overrides = {}) {
  return Product.create({
    sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
    categoryId: 1,
    name: 'Test Tomatoes',
    pricePaise: 4000,
    stock: 10,
    ...overrides,
  });
}

/** Walk a vendor all the way through submit -> penny drop -> confirm. */
async function completeKyc(accessToken, overrides = {}) {
  const submit = await api()
    .post('/api/kyc/me')
    .set(auth(accessToken))
    .send({ ...VALID_DETAILS, ...overrides });
  assert.equal(submit.status, 201);

  const drop = await api().post('/api/kyc/me/penny-drop').set(auth(accessToken)).send();
  assert.equal(drop.status, 202);

  const verify = await api()
    .post('/api/kyc/me/penny-drop/verify')
    .set(auth(accessToken))
    .send({ amountPaise: drop.body.devAmountPaise });
  assert.equal(verify.status, 200);

  return { amountPaise: drop.body.devAmountPaise };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('an unverified shopkeeper cannot update stock', async () => {
  const product = await seedProduct();
  const { accessToken } = await authenticatedUser('shopkeeper');

  const res = await api()
    .patch(`/api/products/${product._id}/stock`)
    .set(auth(accessToken))
    .send({ stock: 42 });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'KYC_REQUIRED');

  const unchanged = await Product.findById(product._id);
  assert.equal(unchanged.stock, 10);
});

test('an unverified shopkeeper cannot create or edit products either', async () => {
  const product = await seedProduct();
  const { accessToken } = await authenticatedUser('shopkeeper');

  const create = await api()
    .post('/api/products')
    .set(auth(accessToken))
    .send({ sku: 'NEW-1', categoryId: 1, name: 'New Item', price: 10, stock: 5 });
  assert.equal(create.status, 403);

  const edit = await api()
    .patch(`/api/products/${product._id}`)
    .set(auth(accessToken))
    .send({ price: 99 });
  assert.equal(edit.status, 403);
});

test('completing KYC unlocks stock updates', async () => {
  const { accessToken } = await authenticatedUser('shopkeeper');

  await completeKyc(accessToken);

  /**
   * Listed through the API, not seeded: a vendor may only write to products
   * they created, and only the create route stamps `createdBy`. Seeding here
   * would test the ownership rule rather than the KYC gate this case is about.
   */
  const created = await api()
    .post('/api/products')
    .set(auth(accessToken))
    .send({ sku: `SKU-KYC-${Date.now()}`, categoryId: 1, name: 'Unlocked', price: 30, stock: 5 });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const res = await api()
    .patch(`/api/products/${created.body.data.id}/stock`)
    .set(auth(accessToken))
    .send({ stock: 42 });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.stock, 42);
});

test('a market owner is not subject to the vendor gate', async () => {
  const { accessToken } = await authenticatedUser('market_owner');
  const product = await seedProduct();

  const res = await api()
    .patch(`/api/products/${product._id}/stock`)
    .set(auth(accessToken))
    .send({ stock: 7 });

  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// Penny drop
// ---------------------------------------------------------------------------

test('the wrong amount does not verify, and attempts are capped', async () => {
  const { accessToken } = await authenticatedUser('shopkeeper');

  await api().post('/api/kyc/me').set(auth(accessToken)).send(VALID_DETAILS);
  const drop = await api().post('/api/kyc/me/penny-drop').set(auth(accessToken)).send();
  const actual = drop.body.devAmountPaise;

  const wrong = actual === 1 ? 2 : actual - 1;

  const first = await api()
    .post('/api/kyc/me/penny-drop/verify')
    .set(auth(accessToken))
    .send({ amountPaise: wrong });

  assert.equal(first.status, 400);
  assert.equal(first.body.error.code, 'PENNY_DROP_MISMATCH');

  const stillLocked = await VendorKyc.findOne({});
  assert.notEqual(stillLocked.status, 'verified');

  for (let i = 0; i < 10; i += 1) {
    await api().post('/api/kyc/me/penny-drop/verify').set(auth(accessToken)).send({ amountPaise: wrong });
  }

  const exhausted = await VendorKyc.findOne({});
  assert.equal(exhausted.status, 'rejected');
});

test('the expected amount is never stored in the clear or returned', async () => {
  const { accessToken } = await authenticatedUser('shopkeeper');

  await api().post('/api/kyc/me').set(auth(accessToken)).send(VALID_DETAILS);
  const drop = await api().post('/api/kyc/me/penny-drop').set(auth(accessToken)).send();

  const raw = await VendorKyc.findOne({}).select('+pennyDrop.amountHash').lean();
  assert.equal(typeof raw.pennyDrop.amountHash, 'string');
  assert.equal(raw.pennyDrop.amountHash.length, 64);
  assert.notEqual(raw.pennyDrop.amountHash, String(drop.body.devAmountPaise));

  const status = await api().get('/api/kyc/me').set(auth(accessToken));
  assert.equal(status.body.data.pennyDrop.amountHash, undefined);
});

test('a penny drop cannot be requested before details are submitted', async () => {
  const { accessToken } = await authenticatedUser('shopkeeper');

  const res = await api().post('/api/kyc/me/penny-drop').set(auth(accessToken)).send();

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'KYC_NOT_SUBMITTED');
});

// ---------------------------------------------------------------------------
// Stored data
// ---------------------------------------------------------------------------

test('bank account is encrypted at rest and masked in responses', async () => {
  const { accessToken } = await authenticatedUser('shopkeeper');

  await api().post('/api/kyc/me').set(auth(accessToken)).send(VALID_DETAILS);

  const raw = await VendorKyc.findOne({}).select('+bankAccountEncrypted').lean();

  const serialized = JSON.stringify(raw);
  assert.ok(!serialized.includes(VALID_DETAILS.bankAccount), 'bank account found in plaintext');

  assert.ok(raw.bankAccountEncrypted.startsWith('v1.'));
  assert.equal(raw.bankAccountLast4, '9012');

  const res = await api().get('/api/kyc/me').set(auth(accessToken));
  assert.equal(res.body.data.bankName, 'HDFC Bank');
  assert.equal(res.body.data.bankAccount, '••••9012');
  assert.equal(res.body.data.bankAccountEncrypted, undefined);
});

test('verified details cannot be silently replaced', async () => {
  const { accessToken } = await authenticatedUser('shopkeeper');
  await completeKyc(accessToken);

  const res = await api()
    .post('/api/kyc/me')
    .set(auth(accessToken))
    .send({ ...VALID_DETAILS, bankAccount: '999999999999' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'KYC_ALREADY_VERIFIED');
});

test('a client cannot mark itself verified through the submit body', async () => {
  const product = await seedProduct();
  const { accessToken } = await authenticatedUser('shopkeeper');

  const res = await api()
    .post('/api/kyc/me')
    .set(auth(accessToken))
    .send({ ...VALID_DETAILS, status: 'verified', verifiedAt: new Date().toISOString() });

  // .strict() rejects the unknown keys outright.
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');

  const blocked = await api()
    .patch(`/api/products/${product._id}/stock`)
    .set(auth(accessToken))
    .send({ stock: 5 });
  assert.equal(blocked.status, 403);
});

test('malformed IFSC and UPI IDs are rejected', async () => {
  const { accessToken } = await authenticatedUser('shopkeeper');

  const cases = [
    { ...VALID_DETAILS, ifsc: 'HDFC1001234' },
    { ...VALID_DETAILS, upiVpa: 'not-a-vpa' },
    { ...VALID_DETAILS, bankAccount: '12345' },
  ];

  for (const body of cases) {
    const res = await api().post('/api/kyc/me').set(auth(accessToken)).send(body);
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(body)}`);
  }
});

test('a customer cannot reach the vendor KYC endpoints', async () => {
  const { accessToken } = await authenticatedUser('customer');

  const res = await api().get('/api/kyc/me').set(auth(accessToken));
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// Vendor registration — passwordless, dual-OTP, distinct from customer signup
// ---------------------------------------------------------------------------

test('vendor registration proves both contacts before creating an account', async () => {
  const start = await api()
    .post('/api/auth/vendor/register/start')
    .send({ phone: '9876543210', name: 'New Vendor' });

  assert.equal(start.status, 202);
  assert.equal(await User.countDocuments({ phone: '9876543210' }), 0);
  assert.ok(start.body.phone.delivered);

  const verify = await api()
    .post('/api/auth/vendor/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(verify.status, 201);
  assert.equal(verify.body.user.role, 'shopkeeper');
  assert.equal(verify.body.nextStep, 'kyc');

  const created = await User.findOne({ phone: '9876543210' });
  assert.equal(created.role, 'shopkeeper');
  assert.equal(created.phone, '9876543210');
});

test('a freshly registered vendor cannot write to the catalog until KYC clears', async () => {
  const start = await api()
    .post('/api/auth/vendor/register/start')
    .send({ phone: '9876543211' });

  const verify = await api()
    .post('/api/auth/vendor/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  const kyc = await api().get('/api/kyc/me').set(auth(verify.body.accessToken));
  assert.equal(kyc.body.data.status, 'missing');
  assert.equal(kyc.body.data.canUpdateStock, false);
});

test('a customer registration code cannot be redeemed as a vendor registration', async () => {
  const start = await api()
    .post('/api/auth/register/start')
    .send({ phone: '9876543212' });

  // Same code, wrong endpoint: the OTP purpose differs (`registration` vs
  // `vendor_registration`), so verifyChallenge must refuse it outright.
  const res = await api()
    .post('/api/auth/vendor/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'OTP_INVALID');

  const created = await User.findOne({ phone: '9876543212' });
  assert.equal(created, null);
});

test('vendor registration is not blocked by a customer account on the same number', async () => {
  // One contact, several roles: uniqueness on User is per (contact, role), not
  // per contact — see the long comment on models/User.js. A customer account
  // must not stand in the way of the SAME number registering as a shopkeeper.
  //
  // The shared contact is the phone now. It used to be demonstrated with an
  // email, back when registration collected one; it does not, so the number is
  // the only contact a sign-up has.
  const { user } = await createUser({ role: 'customer', phone: '9876543213' });

  const res = await api()
    .post('/api/auth/vendor/register/start')
    .send({ phone: user.phone });

  assert.equal(res.status, 202);

  // Still exactly one customer account, and the vendor registration has not
  // created a shopkeeper account yet either — /start only issues codes.
  const accounts = await User.find({ phone: user.phone }).select('role').lean();
  assert.deepEqual(
    accounts.map((a) => a.role).sort(),
    ['customer']
  );
});

test('vendor registration still refuses a second shopkeeper account for the same number', async () => {
  // The part of the old behaviour that must survive: a contact may back at
  // most ONE account per role. Two shopkeeper accounts fighting over the same
  // number is still nonsense, even though a customer account sharing it is not.
  const { user } = await createUser({ role: 'shopkeeper', phone: '9876543213' });

  const res = await api()
    .post('/api/auth/vendor/register/start')
    .send({ phone: user.phone });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ALREADY_REGISTERED');
});

test('the same number can complete registration as a customer and a shopkeeper independently', async () => {
  const phone = '9876543215';
  const { user: customer } = await createUser({ role: 'customer', phone });

  const start = await api().post('/api/auth/vendor/register/start').send({ phone });
  assert.equal(start.status, 202);

  const verify = await api()
    .post('/api/auth/vendor/register/verify')
    .send({
      phoneChallengeId: start.body.phone.challengeId,
      phoneCode: start.body.devCodes.phone,
    });

  assert.equal(verify.status, 201);
  assert.equal(verify.body.user.role, 'shopkeeper');
  assert.notEqual(verify.body.user.id, customer.id);

  const accounts = await User.find({ phone }).select('role').lean();
  assert.deepEqual(
    accounts.map((a) => a.role).sort(),
    ['customer', 'shopkeeper']
  );
});

test('vendor registration cannot smuggle a privileged role through the body', async () => {
  const res = await api()
    .post('/api/auth/vendor/register/start')
    .send({ phone: '9876543214', role: 'developer' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});
