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

  const globalPolicy = await PlatformSharePolicy.findOne({
    scope: sharePolicy.GLOBAL_PLATFORM_POLICY_SCOPE,
  }).lean();
  assert.ok(globalPolicy);
  assert.equal(await PlatformSharePolicy.countDocuments(), 1);
  assert.equal(globalPolicy.platformBps, config.settlement.commissionBps);
  assert.equal(globalPolicy.shopkeeperBps, 10000 - config.settlement.commissionBps);
  assert.equal(globalPolicy.deliveryBps, 0);
  assert.equal(globalPolicy.marketOwnerBps, 0);
  assert.equal(globalPolicy.customerIncentiveBps, 0);
  assert.equal(globalPolicy.promosEnabled, true);
  assert.equal(bpsSum(globalPolicy), 10000);
});

test('ensureGlobalPolicy is idempotent under repeated upsert', async () => {
  await Promise.all([
    sharePolicy.ensureGlobalPolicy(),
    sharePolicy.ensureGlobalPolicy(),
    sharePolicy.ensureGlobalPolicy(),
  ]);
  assert.equal(await PlatformSharePolicy.countDocuments(), 1);
  assert.ok(
    await PlatformSharePolicy.findOne({ scope: sharePolicy.GLOBAL_PLATFORM_POLICY_SCOPE })
  );
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

test('admin can list markets for share-policy overrides', async () => {
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Share Policy Market',
    slug: `share-policy-mkt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  const res = await api().get('/api/admin/markets').set(auth(admin.accessToken));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ id: String(market._id), name: 'Share Policy Market' }]);
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

test('market PUT validates the next persisted override after partial updates', async () => {
  await sharePolicy.ensureGlobalPolicy();
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Partial Override Market',
    slug: `partial-mkt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  const initial = await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({
      platformBps: 1000,
      shopkeeperBps: 6000,
      deliveryBps: 3000,
      marketOwnerBps: 0,
      customerIncentiveBps: 0,
    });

  assert.equal(initial.status, 200);

  const res = await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({
      platformBps: 1000,
      deliveryBps: 4000,
      marketOwnerBps: 1000,
      customerIncentiveBps: 1,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'SHARE_BPS_INVALID');

  const after = await MarketSharePolicy.findOne({ market: market._id }).lean();
  assert.equal(after.shopkeeperBps, 6000);
  assert.equal(after.deliveryBps, 3000);
});

/**
 * The rebalance trap: a partial override leaves shopkeeper to be computed as
 * `10000 - others`, and "others" includes what the market INHERITS from the
 * global policy — so an explicit override that looks under 10000 on its own can
 * still drive the merged shopkeeper share negative. The old pre-merge check
 * summed only the explicit fields and waved this through; at settlement the
 * buckets then exceeded the order's gross while the stall was paid nothing.
 */
test('market PUT whose rebalanced shopkeeper share would go negative is refused', async () => {
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Negative Rebalance Market',
    slug: `neg-mkt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  const global = await api()
    .put('/api/admin/share-policy')
    .set(auth(admin.accessToken))
    .send({
      platformBps: 1000,
      shopkeeperBps: 9000,
      deliveryBps: 0,
      marketOwnerBps: 0,
      customerIncentiveBps: 0,
    });
  assert.equal(global.status, 200);

  // Explicit fields alone sum to 9500 — under 10000 — but merged with the
  // inherited platform 1000 the rebalanced shopkeeper share is -500.
  const res = await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({ deliveryBps: 9500 });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'SHARE_BPS_INVALID');
  assert.equal(await MarketSharePolicy.findOne({ market: market._id }), null);
});

/**
 * The drift trap: an override is validated against the global policy it was
 * saved under, but the merge is recomputed from the LIVE global on every
 * settlement. Letting a global edit through that invalidates a stored override
 * would leave that market's orders refusing to settle until someone noticed
 * the boot log. Refused here instead, naming the market.
 */
test('global PUT that would invalidate a stored market override is refused', async () => {
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Drift Market',
    slug: `drift-mkt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  await api()
    .put('/api/admin/share-policy')
    .set(auth(admin.accessToken))
    .send({
      platformBps: 1000,
      shopkeeperBps: 9000,
      deliveryBps: 0,
      marketOwnerBps: 0,
      customerIncentiveBps: 0,
    })
    .expect(200);

  // Valid under the current global: inherited platform 1000 + explicit
  // shopkeeper 7000 + delivery 2000 = 10000.
  await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({ shopkeeperBps: 7000, deliveryBps: 2000 })
    .expect(200);

  // Raising platform to 2000 would make that market's merged sum 11000.
  const res = await api()
    .put('/api/admin/share-policy')
    .set(auth(admin.accessToken))
    .send({
      platformBps: 2000,
      shopkeeperBps: 8000,
      deliveryBps: 0,
      marketOwnerBps: 0,
      customerIncentiveBps: 0,
    });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SHARE_POLICY_CONFLICT');
  assert.match(res.body.error.message, /Drift Market/);

  const globalAfter = await PlatformSharePolicy.findOne({
    scope: sharePolicy.GLOBAL_PLATFORM_POLICY_SCOPE,
  }).lean();
  assert.equal(globalAfter.platformBps, 1000, 'the global policy is untouched');

  // A fully explicit override sums to 10000 under any global, so the admin can
  // always fix the override first and then land the same global change.
  await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({ platformBps: 1000, shopkeeperBps: 7000, deliveryBps: 2000, marketOwnerBps: 0, customerIncentiveBps: 0 })
    .expect(200);

  await api()
    .put('/api/admin/share-policy')
    .set(auth(admin.accessToken))
    .send({
      platformBps: 2000,
      shopkeeperBps: 8000,
      deliveryBps: 0,
      marketOwnerBps: 0,
      customerIncentiveBps: 0,
    })
    .expect(200);
});

test('market PUT omitting promosEnabled inherits disabled global promos', async () => {
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Promo Inherit Market',
    slug: `promo-mkt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  const global = await api()
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
  assert.equal(global.status, 200);

  const put = await api()
    .put(`/api/admin/markets/${market._id}/share-policy`)
    .set(auth(admin.accessToken))
    .send({ deliveryBps: 1500 });

  assert.equal(put.status, 200);
  assert.equal(put.body.policy.promosEnabled, null);
  assert.equal(put.body.effective.promosEnabled, false);

  const effective = await sharePolicy.effectivePolicyForOrder({ market: market._id });
  assert.equal(effective.promosEnabled, false);
});
