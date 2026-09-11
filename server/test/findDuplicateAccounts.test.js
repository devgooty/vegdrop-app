'use strict';

/**
 * Deleting an account is not reversible, so the criterion has to be exact.
 *
 * "Unreachable" is a claim about the login path, not a guess about intent: an
 * account whose number is held by another account of the same role can never be
 * signed into, because `findByIdentifier` resolves the holder first. These tests
 * pin that alignment, and pin every case where the script must refuse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, verifyVendor } = require('./helpers');
const User = require('../models/User');
const Order = require('../models/Order');
const VendorKyc = require('../models/VendorKyc');
const RefreshToken = require('../models/RefreshToken');
const { findByIdentifier } = require('../services/authSession');
const {
  assertFiltersDiscriminate,
  findUnreachable,
  findSameNameSameRole,
  findEntanglements,
  entanglementTotal,
  removeAccount,
} = require('../scripts/find-duplicate-accounts');

const PHONE = '9705541348';
const CUSTOMER_SCOPE = ['customer', 'market_owner', 'developer'];

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
function account(overrides = {}) {
  seq += 1;
  return {
    name: `Person ${seq}`,
    email: `person${seq}@example.com`,
    role: 'customer',
    ...overrides,
  };
}

/** The account that holds the number — the one sign-in resolves to. */
function holder(overrides = {}) {
  return account({ phone: PHONE, phoneVerifiedAt: new Date(), ...overrides });
}

/** The account that only claims it. */
function claimant(overrides = {}) {
  return account({ pendingPhone: PHONE, ...overrides });
}

/**
 * A KYC record that got as far as the penny drop and stopped.
 *
 * `helpers.verifyVendor` covers the verified case; this is its unfinished
 * counterpart, and every required field still has to be present — an abandoned
 * record is a real row holding real bank details, which is the whole reason
 * deleting one is a decision rather than a tidy-up.
 */
async function abandonedKyc(user) {
  const VendorKycModel = require('../models/VendorKyc');
  return VendorKycModel.create({
    user: user._id,
    legalName: user.name,
    bankName: 'HDFC Bank',
    ifsc: 'HDFC0001234',
    upiVpa: 'trader@okhdfcbank',
    ...VendorKycModel.buildSecrets({ bankAccount: '123456789012' }),
    status: 'penny_sent',
  });
}

// ---------------------------------------------------------------------------
// The guard that exists because this script got it wrong once
// ---------------------------------------------------------------------------

test('the filter guard passes when every field name is right', async () => {
  await assertFiltersDiscriminate();
});

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

test('a claimant of a held number in the same role is unreachable', async () => {
  const held = await User.create(holder({ name: 'Holder' }));
  const dead = await User.create(claimant({ name: 'Dead' }));

  const found = await findUnreachable();

  assert.equal(found.length, 1);
  assert.equal(String(found[0].user._id), String(dead._id));
  assert.equal(String(found[0].holder._id), String(held._id));
});

/**
 * The whole criterion in one assertion: the row the script deletes is exactly
 * the row sign-in cannot reach, and the row it keeps is the one sign-in finds.
 */
test('what is deleted is precisely what sign-in cannot resolve to', async () => {
  const held = await User.create(holder({ name: 'Holder' }));
  await User.create(claimant({ name: 'Dead' }));

  const [{ user: dead }] = await findUnreachable();
  const resolved = await findByIdentifier(PHONE, CUSTOMER_SCOPE);

  assert.equal(String(resolved._id), String(held._id));
  assert.notEqual(String(resolved._id), String(dead._id));
});

test('a claimant with no holder is reachable and is left alone', async () => {
  await User.create(claimant({ name: 'Only claimant' }));

  assert.deepEqual(await findUnreachable(), []);

  const resolved = await findByIdentifier(PHONE, CUSTOMER_SCOPE);
  assert.ok(resolved, 'it can still be signed into, so it is not a duplicate');
});

test('the same number in another role is not a duplicate', async () => {
  await User.create(holder({ role: 'customer' }));
  await User.create(claimant({ role: 'shopkeeper' }));

  assert.deepEqual(await findUnreachable(), []);
});

test('a deleted account is neither a duplicate nor a holder', async () => {
  await User.create(holder({ status: 'deleted' }));
  await User.create(claimant({ name: 'Claimant' }));

  assert.deepEqual(await findUnreachable(), [], 'a deleted holder holds nothing');
});

// ---------------------------------------------------------------------------
// Same name, same role — reported, never deleted
// ---------------------------------------------------------------------------

test('one name in one role on two numbers is reported', async () => {
  await User.create(account({ name: 'Hemanth Gandra', phone: '9705541348', phoneVerifiedAt: new Date() }));
  await User.create(account({ name: 'hemanth  gandra', pendingPhone: '9281401201' }));

  const groups = await findSameNameSameRole();

  assert.equal(groups.length, 1, 'case and spacing must not hide the match');
  assert.equal(groups[0].length, 2);
});

test('a same-name pair is never returned as deletable', async () => {
  await User.create(account({ name: 'Same Person', phone: '9705541348', phoneVerifiedAt: new Date() }));
  await User.create(account({ name: 'Same Person', pendingPhone: '9281401201' }));

  assert.deepEqual(await findUnreachable(), [], 'two numbers are two people to this system');
});

test('the same name in different roles is not flagged', async () => {
  await User.create(account({ name: 'One Person', role: 'customer', phone: '9705541348', phoneVerifiedAt: new Date() }));
  await User.create(account({ name: 'One Person', role: 'shopkeeper', phone: '9705541348', phoneVerifiedAt: new Date() }));

  assert.deepEqual(await findSameNameSameRole(), [], 'that is the model working as designed');
});

// ---------------------------------------------------------------------------
// Refusing
// ---------------------------------------------------------------------------

test('an account carrying an order is never deleted', async () => {
  await User.create(holder());
  const dead = await User.create(claimant());
  // Written through the raw collection: this test is about whether the count
  // sees the row, not about whether a valid order can be built.
  await Order.collection.insertOne({ customer: dead._id, orderNumber: 'VBTEST0000000001' });

  const tangles = await findEntanglements(dead._id);

  assert.equal(tangles.orders, 1);
  assert.ok(entanglementTotal(tangles) > 0, 'and it blocks');
});

test('a verified KYC blocks even with --with-abandoned-kyc', async () => {
  await User.create(holder());
  const dead = await User.create(claimant());
  await verifyVendor(dead);

  const tangles = await findEntanglements(dead._id);

  assert.equal(tangles.kycVerified, 1);
  assert.ok(
    entanglementTotal(tangles, { withAbandonedKyc: true }) > 0,
    'the flag forgives an abandoned record, never a verified one'
  );
});

test('an abandoned KYC blocks by default and is forgiven only when asked', async () => {
  await User.create(holder());
  const dead = await User.create(claimant());
  await abandonedKyc(dead);

  const tangles = await findEntanglements(dead._id);

  assert.equal(tangles.kycAbandoned, 1);
  assert.ok(entanglementTotal(tangles) > 0, 'default refuses');
  assert.equal(entanglementTotal(tangles, { withAbandonedKyc: true }), 0, 'the flag allows it');
});

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

test('removing takes the sessions and leaves the holder untouched', async () => {
  const held = await User.create(holder({ name: 'Holder' }));
  const dead = await User.create(claimant({ name: 'Dead' }));
  await RefreshToken.create({
    user: dead._id,
    tokenHash: 'x'.repeat(64),
    family: 'test-family',
    expiresAt: new Date(Date.now() + 86400000),
  });

  const removed = await removeAccount(dead._id);

  assert.equal(removed.users, 1);
  assert.equal(removed.refreshTokens, 1);
  assert.equal(await User.countDocuments({ _id: dead._id }), 0);

  const survivor = await User.findById(held._id).lean();
  assert.equal(survivor.phone, PHONE, 'the holder keeps the number');
});

test('a verified KYC survives removal even when the flag is set', async () => {
  const dead = await User.create(claimant());
  await verifyVendor(dead);

  await removeAccount(dead._id, { withAbandonedKyc: true });

  assert.equal(
    await VendorKyc.countDocuments({ user: dead._id, status: 'verified' }),
    1,
    'the filter pins status, so no caller can waive this'
  );
});

test('removing the duplicate makes the number resolve to the holder alone', async () => {
  const held = await User.create(holder({ name: 'Holder' }));
  const dead = await User.create(claimant({ name: 'Dead' }));

  await removeAccount(dead._id);

  const resolved = await findByIdentifier(PHONE, CUSTOMER_SCOPE);
  assert.equal(String(resolved._id), String(held._id));
  assert.deepEqual(await findUnreachable(), [], 'and there is nothing left to find');
});
