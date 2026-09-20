'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
  createUser,
} = require('./helpers');
const { APP_ROLE_SCOPE } = require('../services/authSession');
const { ROLES } = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('ROLES and APP_ROLE_SCOPE include admin', () => {
  assert.ok(ROLES.includes('admin'));
  assert.deepEqual(APP_ROLE_SCOPE.admin, ['admin', 'developer']);
});

test('admin can restore a session; shopkeeper cannot hit a future admin gate pattern', async () => {
  const admin = await authenticatedUser('admin');
  const me = await api().get('/api/auth/me').set(auth(admin.accessToken));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
});

test('developer can promote a customer to admin', async () => {
  const dev = await authenticatedUser('developer');
  const { user } = await createUser({ role: 'customer' });
  const res = await api()
    .patch(`/api/users/${user._id}/role`)
    .set(auth(dev.accessToken))
    .send({ role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.role, 'admin');
});

test('admin cannot change roles', async () => {
  const admin = await authenticatedUser('admin');
  const { user } = await createUser({ role: 'customer' });
  const res = await api()
    .patch(`/api/users/${user._id}/role`)
    .set(auth(admin.accessToken))
    .send({ role: 'shopkeeper' });
  assert.equal(res.status, 403);
});
