'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergePolicies,
  splitGrossPaise,
  allocateShopkeeperAcrossStalls,
  forceNoMarketOwner,
  assertBpsSum,
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
