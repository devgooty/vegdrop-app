'use strict';

/**
 * Promoting an account to a privileged role from outside the API.
 *
 * This script is the only way a `market_owner` or `developer` comes into
 * existence on a real deployment, so the things it REFUSES to do carry as much
 * weight as the promotion itself — chiefly that it never creates an account,
 * and never picks between two accounts on one number.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase } = require('./helpers');

const User = require('../models/User');
const { normalisePhone, accountsFor, promote } = require('../scripts/promote-user');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedUser({ phone, role, status = 'active' }) {
  return User.create({
    name: `${role} ${uniq()}`,
    phone,
    email: `${role}-${uniq()}@example.com`,
    role,
    status,
  });
}

test('a typed number is normalised the way the API normalises it', () => {
  assert.equal(normalisePhone('9281401201'), '9281401201');
  assert.equal(normalisePhone('+91 92814 01201'), '9281401201');
  assert.equal(normalisePhone('+91-92814-01201'), '9281401201');
  assert.equal(normalisePhone('09281401201'), '9281401201');

  /**
   * The trap this mirrors from middleware/validate.js: 9111111111 is a real
   * ten-digit mobile that merely begins "91". Stripping the prefix by pattern
   * rather than by length would turn it into an eight-digit number and report
   * "no such account" to someone who has one.
   */
  assert.equal(normalisePhone('9111111111'), '9111111111');

  assert.equal(normalisePhone('12345'), null);
  assert.equal(normalisePhone('5281401201'), null, 'Indian mobiles start 6-9');
});

test('promotion changes the role and invalidates existing sessions', async () => {
  const user = await seedUser({ phone: '9281401201', role: 'customer' });
  const before = await User.findById(user._id).lean();

  const changed = await promote(before, 'market_owner');
  assert.equal(changed, true);

  const after = await User.findById(user._id).lean();
  assert.equal(after.role, 'market_owner');

  /**
   * middleware/auth.js compares the token's `tv` claim against the live record,
   * so bumping this is what forces a fresh sign-in. Without it the account
   * carries a token asserting its old role until that token expires.
   */
  assert.equal(after.tokenVersion, before.tokenVersion + 1);
});

test('a concurrent change loses rather than overwriting a decision', async () => {
  const user = await seedUser({ phone: '9281401201', role: 'customer' });
  const stale = await User.findById(user._id).lean();

  // Somebody else acts between the read and the write.
  await User.updateOne({ _id: user._id }, { $set: { role: 'shopkeeper' } });

  const changed = await promote(stale, 'developer');
  assert.equal(changed, false, 'the filter pins the role that was read');

  const after = await User.findById(user._id).lean();
  assert.equal(after.role, 'shopkeeper', 'the other decision stands');
});

/**
 * One contact backs one account PER ROLE, so a number can hold several. The
 * script reports them all and refuses to choose; these assert the data it works
 * from, since the choosing itself lives in the CLI.
 */
test('every account on a number is reported, so the operator picks', async () => {
  await seedUser({ phone: '9281401201', role: 'customer' });
  await seedUser({ phone: '9281401201', role: 'shopkeeper' });
  await seedUser({ phone: '9000000009', role: 'customer' });

  const found = await accountsFor('9281401201');

  assert.equal(found.length, 2);
  assert.deepEqual(found.map((u) => u.role).sort(), ['customer', 'shopkeeper']);
});

test('a number with no account yields nothing to promote', async () => {
  const found = await accountsFor('9281401201');
  assert.equal(found.length, 0);

  // The script's refusal to create one is the point: possession of the number
  // is proved by signing in, never by a database script.
  assert.equal(await User.countDocuments({}), 0);
});
