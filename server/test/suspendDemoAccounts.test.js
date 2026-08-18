'use strict';

/**
 * scripts/suspend-demo-accounts.js is the immediate lock on the seeded demo
 * accounts that reached production — passwordless, and one of them holding
 * `developer`.
 *
 * Asserting that a field changed would prove almost nothing. What matters is
 * that a suspended account is actually refused: both on the token it already
 * holds and on a fresh sign-in. Those two are the tests worth having.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, api, auth, signIn } = require('./helpers');

const User = require('../models/User');
const { seedIfEmpty, SEED_ACCOUNTS } = require('../utils/seed');
const { findDemoAccounts, suspend, restore } = require('../scripts/suspend-demo-accounts');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('it finds every seeded account, whatever role', async () => {
  await seedIfEmpty();

  const users = await findDemoAccounts();

  assert.equal(users.length, SEED_ACCOUNTS.length);
  assert.ok(users.some((u) => u.role === 'developer' && u.phone === '9000000005'));
});

test('suspending sets status and bumps tokenVersion', async () => {
  await seedIfEmpty();

  const before = await User.findOne({ phone: '9000000005' }).lean();
  assert.equal(before.status, 'active');

  const result = await suspend(await findDemoAccounts());
  assert.equal(result.changed, SEED_ACCOUNTS.length);

  const after = await User.findOne({ phone: '9000000005' }).lean();
  assert.equal(after.status, 'suspended');
  assert.equal(after.tokenVersion, before.tokenVersion + 1);
});

/**
 * The point of the whole exercise. A token minted before suspension must stop
 * working — middleware/auth.js re-reads the user on every request, so this is
 * immediate rather than waiting for expiry.
 */
test('a token issued before suspension is refused afterwards', async () => {
  await seedIfEmpty();

  const session = await signIn({ phone: '9000000005' });
  const before = await api().get('/api/auth/me').set(auth(session.accessToken));
  assert.equal(before.status, 200, 'the developer account should work before suspension');

  await suspend(await findDemoAccounts());

  const after = await api().get('/api/auth/me').set(auth(session.accessToken));
  assert.equal(after.status, 401);
  assert.equal(after.body.error.code, 'ACCOUNT_INACTIVE');
});

/** And they cannot simply sign in again — the account is closed, not logged out. */
test('a suspended demo account cannot sign in again', async () => {
  await seedIfEmpty();
  await suspend(await findDemoAccounts());

  await assert.rejects(
    () => signIn({ phone: '9000000005' }),
    /403|ACCOUNT_INACTIVE/,
    'sign-in must be refused, not merely unprivileged'
  );
});

test('a real account is not touched', async () => {
  await seedIfEmpty();

  const real = await User.create({
    name: 'Real Customer',
    email: 'real@realdomain.example',
    phone: '9777777777',
    role: 'customer',
    phoneVerifiedAt: new Date(),
  });

  await suspend(await findDemoAccounts());

  const after = await User.findById(real._id).lean();
  assert.equal(after.status, 'active');
  assert.equal(after.tokenVersion, real.tokenVersion);
});

/**
 * Re-running must not keep incrementing tokenVersion on rows already closed.
 * Harmless in itself, but a script that is not safe to run twice invites
 * someone to avoid running it at all.
 */
test('running it twice changes nothing the second time', async () => {
  await seedIfEmpty();

  await suspend(await findDemoAccounts());
  const afterFirst = await User.findOne({ phone: '9000000005' }).lean();

  const second = await suspend(await findDemoAccounts());
  assert.equal(second.changed, 0);

  const afterSecond = await User.findOne({ phone: '9000000005' }).lean();
  assert.equal(afterSecond.tokenVersion, afterFirst.tokenVersion);
});

test('restore puts them back, and sign-in works again', async () => {
  await seedIfEmpty();
  await suspend(await findDemoAccounts());

  const result = await restore(await findDemoAccounts());
  assert.equal(result.changed, SEED_ACCOUNTS.length);

  const after = await User.findOne({ phone: '9000000005' }).lean();
  assert.equal(after.status, 'active');

  const session = await signIn({ phone: '9000000005' });
  assert.ok(session.accessToken, 'the account should be usable again after restore');
});

/** `deleted` is a decision someone made deliberately; restore must not undo it. */
test('restore never revives an account marked deleted', async () => {
  await seedIfEmpty();
  await User.updateOne({ phone: '9000000003' }, { $set: { status: 'deleted' } });

  await restore(await findDemoAccounts());

  const after = await User.findOne({ phone: '9000000003' }).lean();
  assert.equal(after.status, 'deleted');
});
