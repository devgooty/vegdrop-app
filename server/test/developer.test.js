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

const User = require('../models/User');
const Order = require('../models/Order');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('developer endpoints reject unauthenticated callers', async () => {
  const res = await api().get('/api/developer/overview');
  assert.equal(res.status, 401);
});

test('developer endpoints reject non-developer roles', async () => {
  const customer = await authenticatedUser('customer');
  const resCustomer = await api()
    .get('/api/developer/overview')
    .set(auth(customer.accessToken));
  assert.equal(resCustomer.status, 403);

  const shopkeeper = await authenticatedUser('shopkeeper');
  const resShopkeeper = await api()
    .get('/api/developer/overview')
    .set(auth(shopkeeper.accessToken));
  assert.equal(resShopkeeper.status, 403);
});

test('developer can fetch live overview KPIs, db status, and alerts', async () => {
  const developer = await authenticatedUser('developer');

  // Overview
  const resOverview = await api()
    .get('/api/developer/overview')
    .set(auth(developer.accessToken));
  assert.equal(resOverview.status, 200);
  assert.ok(resOverview.body.data.kpis);
  assert.equal(typeof resOverview.body.data.kpis.totalUsers, 'number');
  assert.ok(Array.isArray(resOverview.body.data.charts.last7Days));

  // DB Status
  const resDb = await api()
    .get('/api/developer/db-status')
    .set(auth(developer.accessToken));
  assert.equal(resDb.status, 200);
  assert.equal(resDb.body.data.database.connected, true);
  assert.ok(Array.isArray(resDb.body.data.collections));

  // Alerts
  const resAlerts = await api()
    .get('/api/developer/alerts')
    .set(auth(developer.accessToken));
  assert.equal(resAlerts.status, 200);
  assert.equal(typeof resAlerts.body.data.totalAlerts, 'number');

  // Shopkeepers & Riders
  const resShopkeepers = await api()
    .get('/api/developer/shopkeepers')
    .set(auth(developer.accessToken));
  assert.equal(resShopkeepers.status, 200);

  const resRiders = await api()
    .get('/api/developer/riders')
    .set(auth(developer.accessToken));
  assert.equal(resRiders.status, 200);

  // Payments & Dump
  const resPayments = await api()
    .get('/api/developer/payments')
    .set(auth(developer.accessToken));
  assert.equal(resPayments.status, 200);

  const resDump = await api()
    .get('/api/developer/dump')
    .set(auth(developer.accessToken));
  assert.equal(resDump.status, 200);
  assert.ok(resDump.body.data.snapshot);
});
