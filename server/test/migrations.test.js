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
const Product = require('../models/Product');
const notify = require('../services/notify');
const {
  migrateUserContactIndexes,
  migrateDroppedEmailVerification,
  migrateProductCatalogItem,
} = require('../db/migrations');

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
 * for a number whose only account was a customer one. That message is raised in
 * routes/auth.js from an E11000 on `User.create`, i.e. AFTER the role-scoped
 * application pre-check has already passed. So the failure only exists end to
 * end, and only a request that goes all the way to the insert can demonstrate
 * it is gone.
 *
 * The phone code has to deliver for this, so the transport is stubbed the way
 * kyc.test.js does it — the default test transport reports
 * `reachesRecipient: false`, which would silently skip the phone leg.
 *
 * Staged on the stale `phone_1` index rather than `email_1`: registration no
 * longer collects an address, so a new shopkeeper account has none and could
 * never collide on one. The number is the contact both accounts share.
 */
test('the shopkeeper app can register a number that already has a customer account', async () => {
  notify.setTransport({ name: 'recording', async send() {} });

  try {
    await installStaleContactIndex('phone');
    const { user } = await createUser({ role: 'customer' });

    async function registerVendor() {
      const start = await api()
        .post('/api/auth/vendor/register/start')
        .send({ phone: user.phone });

      // The pre-check IS role-scoped, so this step succeeds either way. That is
      // exactly why the bug reached the second step before showing itself.
      assert.equal(start.status, 202, JSON.stringify(start.body));

      return api()
        .post('/api/auth/vendor/register/verify')
        .send({
          phoneChallengeId: start.body.phone.challengeId,
          phoneCode: start.body.devCodes.phone,
        });
    }

    const blocked = await registerVendor();
    assert.equal(blocked.status, 409, 'the stale index must still turn the insert into a 409');
    assert.equal(blocked.body.error.code, 'ALREADY_REGISTERED');

    await migrateUserContactIndexes();
    await User.createIndexes();

    const allowed = await registerVendor();
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(allowed.body.user.role, 'shopkeeper');
    assert.equal(allowed.body.user.email, null, 'sign-up collects no address');

    const roles = await User.find({ phone: user.phone }).select('role').lean();
    assert.deepEqual(roles.map((r) => r.role).sort(), ['customer', 'shopkeeper']);
  } finally {
    notify.setTransport(null);
  }
});

// ---------------------------------------------------------------------------
// Dropped email verification
// ---------------------------------------------------------------------------

/**
 * The model no longer declares `emailVerifiedAt`, which means Mongoose will not
 * write one — and equally will not remove one already sitting in a document.
 * These write through the raw collection for exactly that reason: the field
 * cannot be created through the model any more, so the only way to reproduce a
 * pre-migration account is to bypass it.
 */
test('clears emailVerifiedAt from accounts that still carry one', async () => {
  const { user } = await createUser({ phone: '9000000030', email: 'legacy@example.com' });
  await User.collection.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });

  const { cleared } = await migrateDroppedEmailVerification();

  assert.equal(cleared, 1);

  const after = await User.collection.findOne({ _id: user._id });
  assert.equal('emailVerifiedAt' in after, false, 'the field must be gone, not set to null');
  assert.equal(after.email, 'legacy@example.com', 'the address itself is kept — notices go there');
});

test('the migration is idempotent and writes nothing on a clean database', async () => {
  const { user } = await createUser({ phone: '9000000031', email: 'clean@example.com' });
  await User.collection.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });

  await migrateDroppedEmailVerification();

  // Runs on every boot, including boots of a database already migrated, and
  // including two instances starting at once.
  const second = await migrateDroppedEmailVerification();
  assert.equal(second.cleared, 0);
});

test('an account that never had the field is untouched', async () => {
  const { user } = await createUser({ phone: '9000000032' });

  const { cleared } = await migrateDroppedEmailVerification();

  assert.equal(cleared, 0);
  const after = await User.collection.findOne({ _id: user._id });
  assert.equal('emailVerifiedAt' in after, false);
});

// ---------------------------------------------------------------------------
// Product.catalogItem — linking a shop's listings to the shared catalog
// ---------------------------------------------------------------------------

/**
 * Written through the raw collection, exactly as the email-verification cases
 * above are, because that is the point of these tests: `catalogItem` now has a
 * default, so a row created through the model can never reproduce the state a
 * database predating the field is actually in.
 */
let catalogSeq = 0;
async function rawProduct({ name, owner = null, catalogItem }) {
  catalogSeq += 1;
  const doc = {
    sku: `MIG-${catalogSeq}`,
    categoryId: 1,
    name,
    pricePaise: 4000,
    stock: 10,
    owner,
    createdBy: owner,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // Omitted entirely rather than set to null when unspecified: a row written
  // before the field existed has no such key at all.
  if (catalogItem !== undefined) doc.catalogItem = catalogItem;
  const { insertedId } = await Product.collection.insertOne(doc);
  return insertedId;
}

test('links a shop listing to the catalog item of the same name', async () => {
  const { user: shopkeeper } = await createUser({ role: 'shopkeeper', phone: '9000000040' });
  const catalogId = await rawProduct({ name: 'Desi Tomatoes' });
  const listingId = await rawProduct({ name: 'desi   tomatoes', owner: shopkeeper._id });

  const { linked, unmatched, ambiguous } = await migrateProductCatalogItem();

  assert.equal(linked, 1, 'case and whitespace are normalised before matching');
  assert.equal(unmatched, 0);
  assert.equal(ambiguous, 0);

  const after = await Product.collection.findOne({ _id: listingId });
  assert.equal(String(after.catalogItem), String(catalogId));
});

/**
 * The rule that matters: a name matching two catalog rows is left alone, never
 * resolved by taking the first. A wrong link makes a shop look like it stocks
 * something it does not and routes an order there that it cannot fill — strictly
 * worse than the listing staying invisible until a vendor picks the right item.
 */
test('a name matching two catalog items is left unlinked, not guessed', async () => {
  const { user: shopkeeper } = await createUser({ role: 'shopkeeper', phone: '9000000041' });
  await rawProduct({ name: 'Tomato' });
  await rawProduct({ name: 'tomato' });
  const listingId = await rawProduct({ name: 'Tomato', owner: shopkeeper._id });

  const { linked, ambiguous } = await migrateProductCatalogItem();

  assert.equal(linked, 0);
  assert.equal(ambiguous, 1);

  const after = await Product.collection.findOne({ _id: listingId });
  assert.equal(after.catalogItem ?? null, null);
});

test('a listing matching no catalog item is reported, not linked', async () => {
  const { user: shopkeeper } = await createUser({ role: 'shopkeeper', phone: '9000000042' });
  await rawProduct({ name: 'Tomato' });
  const listingId = await rawProduct({ name: 'Dragon Fruit', owner: shopkeeper._id });

  const { linked, unmatched } = await migrateProductCatalogItem();

  assert.equal(linked, 0);
  assert.equal(unmatched, 1, 'counted so the boot log can say it out loud');

  const after = await Product.collection.findOne({ _id: listingId });
  assert.equal(after.catalogItem ?? null, null);
});

/** A shared catalog row IS the canonical item; it must never point at another. */
test('shared catalog rows are never linked to anything', async () => {
  await rawProduct({ name: 'Tomato' });
  const otherId = await rawProduct({ name: 'Tomato' });

  const { linked } = await migrateProductCatalogItem();

  assert.equal(linked, 0);
  const after = await Product.collection.findOne({ _id: otherId });
  assert.equal(after.catalogItem ?? null, null);
});

test('is idempotent: a second run relinks nothing', async () => {
  const { user: shopkeeper } = await createUser({ role: 'shopkeeper', phone: '9000000043' });
  await rawProduct({ name: 'Onion' });
  await rawProduct({ name: 'Onion', owner: shopkeeper._id });

  const first = await migrateProductCatalogItem();
  assert.equal(first.linked, 1);

  // Runs on every boot, including boots of a database already migrated, and
  // including two instances starting at once.
  const second = await migrateProductCatalogItem();
  assert.equal(second.linked, 0);
});

test('an already-linked listing is left exactly as it was', async () => {
  const { user: shopkeeper } = await createUser({ role: 'shopkeeper', phone: '9000000044' });
  const realId = await rawProduct({ name: 'Potato' });
  const decoyId = await rawProduct({ name: 'Potato Deluxe' });
  const listingId = await rawProduct({
    name: 'Potato Deluxe',
    owner: shopkeeper._id,
    catalogItem: realId,
  });

  const { linked } = await migrateProductCatalogItem();

  assert.equal(linked, 0, 'a hand-made link outranks anything a name would suggest');
  const after = await Product.collection.findOne({ _id: listingId });
  assert.equal(String(after.catalogItem), String(realId));
  assert.notEqual(String(after.catalogItem), String(decoyId));
});
