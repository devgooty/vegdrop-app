'use strict';

/**
 * Which account a number signs into must not depend on storage order.
 *
 * `findByIdentifier` matched `phone` and `pendingPhone` in one `$or`, so
 * `findOne` returned whichever document the index reached first. On the live
 * database one number carries a `market_owner` holding it in `phone` and two
 * `customer` rows holding it in `pendingPhone` — and the same sign-in resolved
 * to different accounts on different attempts, bouncing the user out of the
 * market owner app at random.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase } = require('./helpers');
const User = require('../models/User');
const { findByIdentifier } = require('../services/authSession');

const PHONE = '9705541348';
const CUSTOMER_SCOPE = ['customer', 'market_owner', 'developer'];

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/** A legacy row: the number was typed at registration but never proved. */
function legacy(overrides) {
  return {
    name: 'Legacy',
    pendingPhone: PHONE,
    role: 'customer',
    ...overrides,
  };
}

test('an account that proved the number beats one that only claims it', async () => {
  // Created FIRST, so a createdAt tiebreak alone would pick the wrong one.
  await User.create(legacy({ email: 'claimant@example.com', name: 'Claimant' }));
  const owner = await User.create({
    name: 'Owner',
    email: 'owner@example.com',
    phone: PHONE,
    role: 'market_owner',
    phoneVerifiedAt: new Date(),
  });

  const found = await findByIdentifier(PHONE, CUSTOMER_SCOPE);

  assert.equal(String(found._id), String(owner._id), 'the proved number wins');
});

/**
 * The security half. `pendingPhone` carries no unique index and never did, so
 * any number of accounts may claim one number unproven. Ranking them equally
 * with the account that proved it lets an unproved claim capture a sign-in.
 */
test('a second unproved claim cannot capture the proved account\'s sign-in', async () => {
  const owner = await User.create({
    name: 'Owner',
    email: 'owner@example.com',
    phone: PHONE,
    role: 'customer',
    phoneVerifiedAt: new Date(),
  });
  await User.create(legacy({ email: 'a@example.com' }));
  await User.create(legacy({ email: 'b@example.com' }));

  for (let i = 0; i < 5; i += 1) {
    const found = await findByIdentifier(PHONE, CUSTOMER_SCOPE);
    assert.equal(String(found._id), String(owner._id), `attempt ${i + 1} resolved elsewhere`);
  }
});

test('among legacy rows the original account wins, and does so every time', async () => {
  const first = await User.create(legacy({ email: 'first@example.com', name: 'First' }));
  await User.create(legacy({ email: 'second@example.com', name: 'Second' }));
  await User.create(legacy({ email: 'third@example.com', name: 'Third' }));

  for (let i = 0; i < 5; i += 1) {
    const found = await findByIdentifier(PHONE, CUSTOMER_SCOPE);
    assert.equal(String(found._id), String(first._id), `attempt ${i + 1} was not stable`);
  }
});

/**
 * The preference must not widen the scope. A number proved on a `market_owner`
 * account is still invisible to the shopkeeper app.
 */
test('the app scope still decides, ahead of any preference', async () => {
  await User.create({
    name: 'Owner',
    email: 'owner@example.com',
    phone: PHONE,
    role: 'market_owner',
    phoneVerifiedAt: new Date(),
  });
  const shop = await User.create(legacy({ email: 'shop@example.com', role: 'shopkeeper' }));

  const found = await findByIdentifier(PHONE, ['shopkeeper']);

  assert.equal(String(found._id), String(shop._id), 'scope is not a preference to be outranked');
});

test('a deleted account is never resolved, proved or not', async () => {
  await User.create({
    name: 'Gone',
    email: 'gone@example.com',
    phone: PHONE,
    role: 'customer',
    status: 'deleted',
    phoneVerifiedAt: new Date(),
  });
  const live = await User.create(legacy({ email: 'live@example.com' }));

  const found = await findByIdentifier(PHONE, CUSTOMER_SCOPE);

  assert.equal(String(found._id), String(live._id));
});

test('a number with no account resolves to nothing', async () => {
  assert.equal(await findByIdentifier('9999999999', CUSTOMER_SCOPE), null);
});

/**
 * Dual-role phones: the customer-app scope must prefer the shopper account.
 *
 * Without this, `createdAt` alone sent anyone who also owns a market into
 * `#/market-owner` when they opened the storefront.
 */
test('customer scope prefers the customer account over an older market_owner', async () => {
  const owner = await User.create({
    name: 'Owner',
    email: 'owner@example.com',
    phone: PHONE,
    role: 'market_owner',
    phoneVerifiedAt: new Date(),
  });
  const shopper = await User.create({
    name: 'Shopper',
    email: 'shopper@example.com',
    phone: PHONE,
    role: 'customer',
    phoneVerifiedAt: new Date(),
  });

  const found = await findByIdentifier(PHONE, CUSTOMER_SCOPE);

  assert.equal(String(found._id), String(shopper._id), 'shopper wins on the storefront');
  assert.notEqual(String(found._id), String(owner._id));
});

test('market_owner scope still reaches the owner when a customer account shares the number', async () => {
  await User.create({
    name: 'Shopper',
    email: 'shopper@example.com',
    phone: PHONE,
    role: 'customer',
    phoneVerifiedAt: new Date(),
  });
  const owner = await User.create({
    name: 'Owner',
    email: 'owner@example.com',
    phone: PHONE,
    role: 'market_owner',
    phoneVerifiedAt: new Date(),
  });

  const found = await findByIdentifier(PHONE, ['market_owner']);

  assert.equal(String(found._id), String(owner._id));
});

test('customer scope still resolves a lone market_owner so the storefront can redirect', async () => {
  const owner = await User.create({
    name: 'Owner',
    email: 'owner@example.com',
    phone: PHONE,
    role: 'market_owner',
    phoneVerifiedAt: new Date(),
  });

  const found = await findByIdentifier(PHONE, CUSTOMER_SCOPE);

  assert.equal(String(found._id), String(owner._id));
});
