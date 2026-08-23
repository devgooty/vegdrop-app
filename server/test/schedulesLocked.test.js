'use strict';

/**
 * Scheduled orders are locked off by default, and the lock has two halves.
 *
 * Hiding the Scheduled Deliveries tab is not a lock: `services/scheduler.js`
 * places standing orders from the sweeper with no UI involved, so a client-only
 * lock would keep debiting wallets on a schedule while removing the only screen
 * that can pause or cancel it. These assert on both halves.
 *
 * The default is LOCKED, so this file needs no environment setup — it is the
 * unlocked case that has to be spawned into its own process, because
 * config/env.js freezes at load.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  authenticatedUser,
  auth,
} = require('./helpers');
const config = require('../config/env');
const scheduler = require('../services/scheduler');
const ScheduledOrder = require('../models/ScheduledOrder');
const Order = require('../models/Order');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('locked by default, without anything being set', () => {
  assert.equal(config.scheduledOrdersLocked, true);
});

test('creating a schedule is refused', async () => {
  const { accessToken } = await authenticatedUser('customer');

  const res = await api()
    .post('/api/schedules')
    .set(auth(accessToken))
    .send({
      items: [{ productId: '6a6b4c62e0607d1b75d79edd', quantity: 1 }],
      address: 'Flat 402, Green Meadows, Hyderabad',
      paymentMethod: 'cod',
      frequency: 'daily',
      hour: 8,
    });

  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, 'SCHEDULES_LOCKED');
  assert.equal(await ScheduledOrder.countDocuments(), 0, 'nothing is written');
});

/**
 * The lock runs ahead of validation, so a locked feature says it is locked
 * whatever the caller sent — rather than grading a request for a route that was
 * never going to write anything.
 */
test('a malformed body is still answered as locked, not as a validation error', async () => {
  const { accessToken } = await authenticatedUser('customer');

  const res = await api().post('/api/schedules').set(auth(accessToken)).send({ nonsense: true });

  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, 'SCHEDULES_LOCKED');
});

/** An anonymous caller learns nothing about the feature's state. */
test('an unauthenticated caller gets 401, not the lock', async () => {
  const res = await api().post('/api/schedules').send({});

  assert.equal(res.status, 401);
  assert.equal(res.body.error?.code, 'UNAUTHENTICATED');
});

/**
 * The half with no UI in it. A schedule that is already due and would otherwise
 * be placed must not be placed while the feature is locked.
 */
test('a due schedule places no order while locked', async () => {
  const { user } = await authenticatedUser('customer');

  await ScheduledOrder.create({
    customer: user._id,
    items: [{ product: '6a6b4c62e0607d1b75d79edd', quantity: 1 }],
    address: 'Flat 402, Green Meadows, Hyderabad',
    paymentMethod: 'cod',
    frequency: 'daily',
    hour: 8,
    status: 'active',
    nextRunAt: new Date(Date.now() - 60 * 1000),
  });

  const result = await scheduler.runDueSchedules();

  assert.equal(result.locked, true);
  assert.equal(result.placed, 0);
  assert.equal(await Order.countDocuments(), 0, 'no standing order is placed');
});

/**
 * Locking must not strand anyone. Someone who already has a standing order has
 * to be able to see it and get rid of it, so only creation is refused.
 */
test('an existing schedule can still be read and cancelled', async () => {
  const { user, accessToken } = await authenticatedUser('customer');

  const schedule = await ScheduledOrder.create({
    customer: user._id,
    items: [{ product: '6a6b4c62e0607d1b75d79edd', quantity: 1 }],
    address: 'Flat 402, Green Meadows, Hyderabad',
    paymentMethod: 'cod',
    frequency: 'daily',
    hour: 8,
    status: 'active',
    nextRunAt: new Date(Date.now() + 3600 * 1000),
  });

  const listed = await api().get('/api/schedules').set(auth(accessToken));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 1);

  const removed = await api().delete(`/api/schedules/${schedule._id}`).set(auth(accessToken));
  assert.ok(removed.status === 200 || removed.status === 204, `cancel answered ${removed.status}`);
});

/**
 * The lock is a switch, not a deletion — unlocking has to restore the feature
 * with no migration. Spawned because config freezes at load.
 */
test('SCHEDULED_ORDERS_UNLOCK=1 opens it again', () => {
  const probe = `
    const config = require('./server/config/env');
    process.stdout.write('<<' + JSON.stringify({ locked: config.scheduledOrdersLocked }) + '>>');
  `;

  const run = (value) =>
    spawnSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development', SCHEDULED_ORDERS_UNLOCK: value },
    });

  const read = (result) => {
    const match = /<<(.*)>>/s.exec(result.stdout || '');
    assert.ok(match, `probe produced no payload: ${result.stdout} ${result.stderr}`);
    return JSON.parse(match[1]);
  };

  assert.equal(read(run('1')).locked, false, 'the documented value unlocks it');
  // Anything else is locked. A truthy-looking value must not open a lock by
  // accident — only the exact opt-in does.
  assert.equal(read(run('true')).locked, true);
  assert.equal(read(run('0')).locked, true);
  assert.equal(read(run('')).locked, true);
});
