'use strict';

/**
 * A proved number filed as unproven is not a cosmetic problem.
 *
 * `findByIdentifier` has to rank an unproved claim against a proved one to
 * decide which account a sign-in resolves to, and the `(phone, role)` unique
 * index cannot constrain a number that is not in `phone` at all. So 24 of 32
 * live accounts sat outside the constraint that is supposed to keep one number
 * to one account per role.
 *
 * The repair must therefore be exactly as conservative as the index: where two
 * accounts claim one number in one role, one of them cannot be repaired, and
 * picking the wrong one would repair an account the user never signs into.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase } = require('./helpers');
const User = require('../models/User');
const { findByIdentifier } = require('../services/authSession');
const { findLegacy, partition, repairAll } = require('../scripts/repair-legacy-phones');

const PHONE = '9705541348';

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
/** A legacy row: number typed at registration, later proved, never re-filed. */
function legacy(overrides = {}) {
  seq += 1;
  return {
    name: `Legacy ${seq}`,
    email: `legacy${seq}@example.com`,
    pendingPhone: PHONE,
    role: 'customer',
    phoneVerifiedAt: new Date(),
    ...overrides,
  };
}

test('it finds a proved number filed as unproven', async () => {
  const user = await User.create(legacy());

  const found = await findLegacy();

  assert.equal(found.length, 1);
  assert.equal(String(found[0]._id), String(user._id));
});

/**
 * The one rule this script must never break. `pendingPhone` exists to hold
 * numbers nobody has demonstrated control of; promoting one into `phone` would
 * turn an unproven claim into the credential of record.
 */
test('an unverified number is never promoted into phone', async () => {
  await User.create(legacy({ phoneVerifiedAt: undefined }));

  assert.deepEqual(await findLegacy(), []);
});

test('an account that already has a phone is left alone', async () => {
  await User.create({
    name: 'Fine',
    email: 'fine@example.com',
    phone: PHONE,
    role: 'customer',
    phoneVerifiedAt: new Date(),
  });

  assert.deepEqual(await findLegacy(), []);
});

test('a deleted account is not repaired', async () => {
  await User.create(legacy({ status: 'deleted' }));

  assert.deepEqual(await findLegacy(), []);
});

test('repairing moves the number and changes nothing else', async () => {
  const user = await User.create(legacy());
  const before = await User.findById(user._id).lean();

  const { repair } = await partition(await findLegacy());
  const { done, failed } = await repairAll(repair);

  assert.equal(done.length, 1);
  assert.equal(failed.length, 0);

  const after = await User.findById(user._id).lean();
  assert.equal(after.phone, PHONE);
  assert.equal(after.pendingPhone, undefined, 'the number must not be in both places');
  assert.equal(after.role, before.role);
  assert.equal(
    after.tokenVersion,
    before.tokenVersion,
    'nothing about the session changed, so nobody is signed out'
  );
});

test('running it twice repairs nothing the second time', async () => {
  await User.create(legacy());

  await repairAll((await partition(await findLegacy())).repair);
  assert.deepEqual(await findLegacy(), [], 'the second run has nothing to do');
});

// ---------------------------------------------------------------------------
// Collisions — the reason this is a script and not a boot migration
// ---------------------------------------------------------------------------

/**
 * `pendingPhone` carries no unique index, deliberately, so any number of
 * accounts may claim one number. `(phone, role)` is unique, so only one of them
 * per role can be repaired.
 */
test('only the oldest claimant of a number in one role is repaired', async () => {
  const first = await User.create(legacy({ name: 'First' }));
  // createdAt is written by the same clock, so force an order the sort can see.
  await User.updateOne({ _id: first._id }, { $set: { createdAt: new Date(Date.now() - 60000) } });
  const second = await User.create(legacy({ name: 'Second' }));
  const third = await User.create(legacy({ name: 'Third' }));

  const { repair, blocked } = await partition(await findLegacy());

  assert.equal(repair.length, 1);
  assert.equal(String(repair[0]._id), String(first._id), 'the oldest wins');
  assert.equal(blocked.length, 2);
  assert.deepEqual(
    blocked.map((b) => String(b.user._id)).sort(),
    [String(second._id), String(third._id)].sort()
  );
});

/**
 * The winner must be the account a sign-in actually resolves to. Repairing any
 * other would file the number against an account the user never reaches.
 */
test('the repaired account is the one sign-in resolves to', async () => {
  const first = await User.create(legacy({ name: 'First' }));
  await User.updateOne({ _id: first._id }, { $set: { createdAt: new Date(Date.now() - 60000) } });
  await User.create(legacy({ name: 'Second' }));

  const { repair } = await partition(await findLegacy());
  await repairAll(repair);

  const resolved = await findByIdentifier(PHONE, ['customer', 'market_owner', 'developer']);
  assert.equal(String(resolved._id), String(first._id));
});

/** One number across different roles is not a collision — the index allows it. */
test('the same number in different roles is repaired for each', async () => {
  await User.create(legacy({ role: 'customer' }));
  await User.create(legacy({ role: 'shopkeeper' }));
  await User.create(legacy({ role: 'delivery' }));

  const { repair, blocked } = await partition(await findLegacy());

  assert.equal(repair.length, 3);
  assert.equal(blocked.length, 0);
});

/**
 * The blocker is checked against the database, not only within the batch: the
 * winner may already hold the number from an earlier run or its own sign-in.
 */
test('a number already held by a live account blocks the claimant', async () => {
  await User.create({
    name: 'Holder',
    email: 'holder@example.com',
    phone: PHONE,
    role: 'customer',
    phoneVerifiedAt: new Date(),
  });
  const claimant = await User.create(legacy({ name: 'Claimant' }));

  const { repair, blocked } = await partition(await findLegacy());

  assert.equal(repair.length, 0);
  assert.equal(blocked.length, 1);
  assert.equal(String(blocked[0].user._id), String(claimant._id));

  const after = await User.findById(claimant._id).lean();
  assert.equal(after.phone, undefined, 'a blocked account keeps its number where it was');
  assert.equal(after.pendingPhone, PHONE);
});

/**
 * A row that healed itself between the read and the write — by signing in —
 * must lose rather than be overwritten, and must not abandon the rest.
 */
test('an account repaired underneath the run is reported, not overwritten', async () => {
  const a = await User.create(legacy({ name: 'A' }));
  const b = await User.create(legacy({ name: 'B', pendingPhone: '9876543210' }));

  const { repair } = await partition(await findLegacy());

  // A signs in and repairs itself after the plan was read.
  await User.updateOne({ _id: a._id }, { $set: { phone: PHONE }, $unset: { pendingPhone: '' } });

  const { done, failed } = await repairAll(repair);

  assert.equal(failed.length, 1);
  assert.equal(String(failed[0].user._id), String(a._id));
  assert.equal(done.length, 1, 'the other account is still repaired');
  assert.equal(String(done[0]._id), String(b._id));
});
