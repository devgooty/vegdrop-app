'use strict';

const { ApiError } = require('../middleware/errors');

const BUCKETS = ['platform', 'shopkeeper', 'delivery', 'marketOwner', 'customerIncentive'];

const BPS_FIELDS = [
  'platformBps',
  'shopkeeperBps',
  'deliveryBps',
  'marketOwnerBps',
  'customerIncentiveBps',
];

const PAISE_FIELDS = [
  'platformPaise',
  'shopkeeperPaise',
  'deliveryPaise',
  'marketOwnerPaise',
  'customerIncentivePaise',
];

function assertBpsSum(policy) {
  const sum = BPS_FIELDS.reduce((acc, key) => acc + (policy[key] ?? 0), 0);
  if (sum !== 10000) {
    throw new ApiError(400, 'Share basis points must sum to exactly 10000.', 'SHARE_BPS_INVALID');
  }
}

/**
 * Merge global platform policy with an optional per-market override.
 * Null or missing override fields inherit from global.
 */
function mergePolicies(global, marketOverride) {
  const merged = {};
  for (const key of BPS_FIELDS) {
    const overrideVal = marketOverride?.[key];
    merged[key] = overrideVal != null ? overrideVal : global[key];
  }
  merged.promosEnabled =
    marketOverride != null && marketOverride.promosEnabled !== undefined
      ? marketOverride.promosEnabled
      : global.promosEnabled;

  if (marketOverride != null && marketOverride.shopkeeperBps == null) {
    const otherSum = BPS_FIELDS.filter((k) => k !== 'shopkeeperBps').reduce(
      (acc, key) => acc + merged[key],
      0
    );
    merged.shopkeeperBps = 10000 - otherSum;
  }

  return merged;
}

/**
 * Split gross order value into bucket paise. Remainder paise land on the last bucket.
 */
function splitGrossPaise(grossPaise, policy) {
  const result = {};
  let sumOthers = 0;
  for (let i = 0; i < BPS_FIELDS.length - 1; i++) {
    const part = Math.floor((grossPaise * policy[BPS_FIELDS[i]]) / 10000);
    result[PAISE_FIELDS[i]] = part;
    sumOthers += part;
  }
  result[PAISE_FIELDS[PAISE_FIELDS.length - 1]] = grossPaise - sumOthers;
  return result;
}

/**
 * Allocate shopkeeper share across stalls in proportion to each stall's gross.
 * Remainder paise land on the last stall.
 */
function allocateShopkeeperAcrossStalls(stallGrosses, shopkeeperPaise) {
  if (stallGrosses.length === 0) {
    return [];
  }
  const totalGross = stallGrosses.reduce((a, b) => a + b, 0);
  if (totalGross === 0) {
    const parts = stallGrosses.map(() => 0);
    parts[parts.length - 1] = shopkeeperPaise;
    return parts;
  }
  const parts = [];
  let sumOthers = 0;
  for (let i = 0; i < stallGrosses.length - 1; i++) {
    const part = Math.floor((shopkeeperPaise * stallGrosses[i]) / totalGross);
    parts.push(part);
    sumOthers += part;
  }
  parts.push(shopkeeperPaise - sumOthers);
  return parts;
}

/** Shop orders have no market owner; fold that bucket into platform. */
function forceNoMarketOwner(policy) {
  return {
    ...policy,
    platformBps: policy.platformBps + policy.marketOwnerBps,
    marketOwnerBps: 0,
  };
}

module.exports = {
  BUCKETS,
  assertBpsSum,
  mergePolicies,
  splitGrossPaise,
  allocateShopkeeperAcrossStalls,
  forceNoMarketOwner,
};
