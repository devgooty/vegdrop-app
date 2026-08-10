'use strict';

/**
 * migrations.js runs on every boot, before ensureIndexes. These tests cover
 * migrateUserContactIndexes specifically: the per-role User uniqueness
 * rewrite (models/User.js) shipped without it, and the old single-field
 * unique index on `email`/`phone` was left standing in production —
 * silently continuing to enforce one-account-per-contact underneath the new
 * per-role rule the schema now declares. See the MIGRATION NOTE above the
 * `{ email: 1, role: 1 }` / `{ phone: 1, role: 1 }` indexes in
 * models/User.js, and the JSDoc on migrateUserContactIndexes itself.
 *
 * `installStaleContactIndex` below reproduces the exact state that was live:
 * a unique+sparse single-field index standing under the SAME auto-generated
 * name (`email_1`) the current schema's plain lookup index (`index: true`
 * on the field) also claims. That name collision, not just the presence of
 * an extra index, is what turned a routine index rebuild into a silent
 * no-op in production instead of a startup error.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, api, createUser } = require('./helpers');
const User = require('../models/User');
const notify = require('../services/notify');
const { migrateUserContactIndexes } = require('../db/migrations');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/** Single-key index on `field`, whatever its shape. */
function singleKeyIndex(indexes, field) {
  return indexes.find((i) => {
    const keys = Object.keys(i.key);
    return keys.length === 1 && keys[0] === field;
  });
}

/**
 * Tear down whatever index currently sits on `field` alone, and rebuild it in
 * the pre-migration shape: unique, sparse, and — because no name is given —
 * auto-named exactly the way both the old unique index and the current plain
 * lookup index would be.
 */
async function installStaleContactIndex(field) {
  const existing = await User.collection.indexes();
  const current = singleKeyIndex(existing, field);
  if (current) await User.collection.dropIndex(current.name);

  await User.collection.createIndex({ [field]: 1 }, { unique: true, sparse: true });
}

test('drops the stale unique single-field index on email', async () => {
  await installStaleContactIndex('email');

  const before = singleKeyIndex(await User.collection.indexes(), 'email');
  assert.ok(before, 'setup should have installed the stale index');
  assert.equal(before.unique, true);

  const { droppedIndexes } = await migrateUserContactIndexes();
  assert.deepEqual(droppedIndexes, [before.name]);

  const after = singleKeyIndex(await User.collection.indexes(), 'email');
  assert.equal(after, undefined, 'the stale single-field index must be gone');
});

test('drops the stale unique single-field index on phone', async () => {
  await installStaleContactIndex('phone');

  const { droppedIndexes } = await migrateUserContactIndexes();
  assert.equal(droppedIndexes.length, 1);

  const after = singleKeyIndex(await User.collection.indexes(), 'phone');
  assert.equal(after, undefined);
});

test('after dropping the stale index, createIndexes rebuilds with no conflict', async () => {
  await installStaleContactIndex('email');
  await migrateUserContactIndexes();

  /**
   * This is the exact call ensureIndexes() makes at boot, for this exact
   * model. Before the fix, this rejected with IndexOptionsConflict for
   * `email_1`, and db/connect.js swallows a per-model createIndexes()
   * rejection into a logged error rather than a boot failure — which is
   * *why* the compound unique index went un-built silently in production
   * instead of loudly.
   */
  await assert.doesNotReject(() => User.createIndexes());

  const after = await User.collection.indexes();
  const compound = after.find((i) => {
    const keys = Object.keys(i.key);
    return keys.length === 2 && keys[0] === 'email' && keys[1] === 'role';
  });
  assert.ok(compound, 'the compound (email, role) unique index must exist after rebuild');
  assert.equal(compound.unique, true);
  assert.ok(compound.partialFilterExpression, 'must stay partial, not sparse');
});

test('a database with no stale index is left alone', async () => {
  // Fresh from startTestServer, the compound index is already correctly built
  // and there is nothing left over from an older release.
  const before = await User.collection.indexes();
  const compoundBefore = before.find((i) => {
    const keys = Object.keys(i.key);
    return keys.length === 2 && keys[0] === 'email' && keys[1] === 'role';
  });
  assert.ok(compoundBefore, 'test setup should already have the current index shape');

  const { droppedIndexes } = await migrateUserContactIndexes();
  assert.equal(droppedIndexes.length, 0, 'a clean database has nothing stale to drop');

  const after = await User.collection.indexes();
  assert.ok(after.some((i) => i.name === compoundBefore.name), 'the current index must survive untouched');
});

test('is idempotent: a second run finds nothing left to drop', async () => {
  await installStaleContactIndex('email');
  await migrateUserContactIndexes();

  const second = await migrateUserContactIndexes();
  assert.equal(second.droppedIndexes.length, 0);
});

test('per-role uniqueness actually holds once the migration and rebuild have run', async () => {
  await installStaleContactIndex('email');
  await migrateUserContactIndexes();
  await User.createIndexes();

  const email = 'shared@example.com';
  await User.create({ name: 'Customer', email, phone: '9000000010', role: 'customer' });

  /**
   * Same email, different role. This is the entire point of the migration:
   * under the stale index this would have been refused with a duplicate-key
   * error, which is exactly the bug the shipped feature could not actually
   * demonstrate in production despite its own test suite passing — the tests
   * run against a freshly-built test database that never had the stale index
   * to begin with.
   */
  await assert.doesNotReject(() =>
    User.create({ name: 'Shopkeeper', email, phone: '9000000011', role: 'shopkeeper' })
  );

  // Same email, SAME role — still refused. The rule is per-role, not absent.
  await assert.rejects(
    () => User.create({ name: 'Second customer', email, phone: '9000000012', role: 'customer' }),
    /duplicate key|E11000/
  );
});

/**
 * The same thing again, but through the HTTP routes a person actually touches.
 *
 * Everything above proves the constraint at the model layer. What was reported
 * from production was not a constraint — it was a sentence: "An account already
 * exists for those details. Try signing in instead.", on the shopkeeper app,
 * for an email whose only account was a customer one. That message is raised in
 * routes/auth.js from an E11000 on `User.create`, i.e. AFTER the role-scoped
 * application pre-check has already passed. So the failure only exists end to
 * end, and only a request that goes all the way to the insert can demonstrate
 * it is gone.
 *
 * Both legs of the dual-OTP flow have to deliver for this, so the transport is
 * stubbed the way kyc.test.js does it — the default test transport reports
 * `reachesRecipient: false`, which would silently skip the phone leg.
 */
test('the shopkeeper app can register an email that already has a customer account', async () => {
  notify.setTransport({ name: 'recording', async send() {} });

  try {
    await installStaleContactIndex('email');
    const { user } = await createUser({ role: 'customer' });

    async function registerVendor(phone) {
      const start = await api()
        .post('/api/auth/vendor/register/start')
        .send({ phone, email: user.email });

      // The pre-check IS role-scoped, so this step succeeds either way. That is
      // exactly why the bug reached the second step before showing itself.
      assert.equal(start.status, 202, JSON.stringify(start.body));

      return api()
        .post('/api/auth/vendor/register/verify')
        .send({
          emailChallengeId: start.body.email.challengeId,
          emailCode: start.body.devCodes.email,
          phoneChallengeId: start.body.phone.challengeId,
          phoneCode: start.body.devCodes.phone,
        });
    }

    const blocked = await registerVendor('9000000020');
    assert.equal(blocked.status, 409, 'the stale index must still turn the insert into a 409');
    assert.equal(blocked.body.error.code, 'ALREADY_REGISTERED');

    await migrateUserContactIndexes();
    await User.createIndexes();

    const allowed = await registerVendor('9000000021');
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(allowed.body.user.role, 'shopkeeper');
    assert.equal(allowed.body.user.email, user.email);

    const roles = await User.find({ email: user.email }).select('role').lean();
    assert.deepEqual(roles.map((r) => r.role).sort(), ['customer', 'shopkeeper']);
  } finally {
    notify.setTransport(null);
  }
});
