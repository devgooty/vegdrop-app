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
} = require('./helpers');
const config = require('../config/env');
const Market = require('../models/Market');
const PlatformSharePolicy = require('../models/PlatformSharePolicy');
const MarketSharePolicy = require('../models/MarketSharePolicy');
const sharePolicy = require('../services/sharePolicy');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

function bpsSum(policy) {
  return (
    policy.platformBps +
    policy.shopkeeperBps +
    policy.deliveryBps +
    policy.marketOwnerBps +
    policy.customerIncentiveBps
  );
}

test('ensureGlobalPolicy seeds from commissionBps', async () => {
  await sharePolicy.ensureGlobalPolicy();

  const globalPolicy = await PlatformSharePolicy.findOne().lean();
  assert.ok(globalPolicy);
  assert.equal(globalPolicy.platformBps, config.settlement.commissionBps);
  assert.equal(globalPolicy.shopkeeperBps, 10000 - config.settlement.commissionBps);
  assert.equal(globalPolicy.deliveryBps, 0);
  assert.equal(globalPolicy.marketOwnerBps, 0);
  assert.equal(globalPolicy.customerIncentiveBps, 0);
  assert.equal(globalPolicy.promosEnabled, true);
  assert.equal(bpsSum(globalPolicy), 10000);
});

test('admin can PUT global policy; shopkeeper cannot read it', async () => {
  const admin = await authenticatedUser('admin');
  const ok = await api()
    .put('/api/admin/share-policy')
    .set(auth(admin.accessToken))
    .send({
      platformBps: 800,
      shopkeeperBps: 7200,
      deliveryBps: 1000,
      marketOwnerBps: 500,
      customerIncentiveBps: 500,
      promosEnabled: false,
    });

  assert.equal(ok.status, 200);
  assert.equal(ok.body.policy.platformBps, 800);
  assert.equal(ok.body.policy.promosEnabled, false);

  const shopkeeper = await authenticatedUser('shopkeeper');
  const no = await api()
    .get('/api/admin/share-policy')
    .set(auth(shopkeeper.accessToken));
  assert.equal(no.status, 403);
});

test('PUT rejecting bad global sum returns SHARE_BPS_INVALID', async () => {
  const admin = await authenticatedUser('admin');
  const res = await api()
    .put('/api/admin/share-policy')
    .set(auth(admin.accessToken))
    .send({
      platformBps: 1000,
      shopkeeperBps: 1000,
      deliveryBps: 1000,
      marketOwnerBps: 1000,
      customerIncentiveBps: 1000,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'SHARE_BPS_INVALID');
});

test('market override merge and DELETE restores global-only policy', async () => {
  await sharePolicy.ensureGlobalPolicy();
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Override Market',
    slug: `mkt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  const put = await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({ promosEnabled: false, deliveryBps: 2000 });

  assert.equal(put.status, 200);
  assert.equal(put.body.policy.promosEnabled, false);
  assert.equal(put.body.effective.promosEnabled, false);
  assert.equal(put.body.effective.deliveryBps, 2000);
  assert.equal(bpsSum(put.body.effective), 10000);

  const effective = await sharePolicy.effectivePolicyForOrder({ market: market._id });
  assert.equal(effective.promosEnabled, false);
  assert.equal(effective.deliveryBps, 2000);
  assert.equal(bpsSum(effective), 10000);

  const del = await api()
    .delete(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken));

  assert.equal(del.status, 200);
  assert.equal(del.body.policy, null);
  assert.equal(del.body.effective.promosEnabled, true);
  const after = await MarketSharePolicy.findOne({ market: market._id });
  assert.equal(after, null);
});

test('market PUT rejects override fields over 10000 before shopkeeper rebalance', async () => {
  await sharePolicy.ensureGlobalPolicy();
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Invalid Override Market',
    slug: `bad-mkt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  const res = await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({
      platformBps: 4000,
      deliveryBps: 4000,
      marketOwnerBps: 3000,
      customerIncentiveBps: 1,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'SHARE_BPS_INVALID');
  const after = await MarketSharePolicy.findOne({ market: market._id });
  assert.equal(after, null);
});
