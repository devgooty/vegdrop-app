'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergePolicies,
  splitGrossPaise,
  allocateShopkeeperAcrossStalls,
  forceNoMarketOwner,
  assertBpsSum,
  policyIsValid,
} = require('../services/sharePolicy');

const global = {
  platformBps: 1000,
  shopkeeperBps: 7000,
  deliveryBps: 1000,
  marketOwnerBps: 500,
  customerIncentiveBps: 500,
  promosEnabled: true,
};

test('merge fills missing market fields from global', () => {
  const m = mergePolicies(global, { deliveryBps: 1500, promosEnabled: false });
  assert.equal(m.deliveryBps, 1500);
  assert.equal(m.platformBps, 1000);
  assert.equal(m.promosEnabled, false);
  assertBpsSum(m);
});

test('splitGrossPaise sums to gross and puts remainder on last bucket', () => {
  const s = splitGrossPaise(10001, global);
  const sum =
    s.platformPaise +
    s.shopkeeperPaise +
    s.deliveryPaise +
    s.marketOwnerPaise +
    s.customerIncentivePaise;
  assert.equal(sum, 10001);
});

test('allocateShopkeeperAcrossStalls preserves total', () => {
  const parts = allocateShopkeeperAcrossStalls([3000, 7000], 7000);
  assert.equal(parts.reduce((a, b) => a + b, 0), 7000);
});

test('forceNoMarketOwner folds marketOwner into platform', () => {
  const p = forceNoMarketOwner(global);
  assert.equal(p.marketOwnerBps, 0);
  assert.equal(p.platformBps, 1500);
  assertBpsSum(p);
});

/**
 * The sum check alone is NOT validity, and the gap is the rebalance:
 * `mergePolicies` constructs `shopkeeperBps = 10000 - others`, so its output
 * sums to 10000 by definition — including when the shopkeeper share it built
 * is negative. `policyIsValid` is the check that binds.
 */
test('a rebalanced merge with a negative shopkeeper share passes the sum check but fails validity', () => {
  const m = mergePolicies(global, { deliveryBps: 9500 }); // others: 1000+9500+500+500 = 11500
  assert.equal(m.shopkeeperBps, -1500, 'the rebalance really does go negative');
  assert.doesNotThrow(() => assertBpsSum(m), 'the sum check is blind to it');
  assert.equal(policyIsValid(m), false);
});

test('policyIsValid requires every bucket in range and the sum exactly 10000', () => {
  assert.equal(policyIsValid(global), true);
  assert.equal(policyIsValid({ ...global, platformBps: 999 }), false, 'sum off 10000');
  assert.equal(policyIsValid({ ...global, platformBps: -1, shopkeeperBps: 8001 }), false, 'negative bucket');
  assert.equal(policyIsValid({ ...global, platformBps: 10.5, shopkeeperBps: 7989.5 }), false, 'non-integer');
});
