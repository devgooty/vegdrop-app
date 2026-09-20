'use strict';

/** Unique scope discriminator so concurrent boot upserts target one row. */
const GLOBAL_PLATFORM_POLICY_SCOPE = 'global';

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

function shareBpsInvalidError() {
  const error = new Error('Share basis points must sum to exactly 10000.');
  error.name = 'ApiError';
  error.statusCode = 400;
  error.code = 'SHARE_BPS_INVALID';
  error.expose = true;
  return error;
}

function assertBpsSum(policy) {
  const sum = BPS_FIELDS.reduce((acc, key) => acc + (policy[key] ?? 0), 0);
  if (sum !== 10000) {
    throw shareBpsInvalidError();
  }
}

function lazyPolicyModels() {
  /**
   * Loaded lazily because PlatformSharePolicy imports this module for
   * assertBpsSum during schema validation. Requiring it at module load would
   * create a circular dependency before assertBpsSum is exported.
   */
  return {
    PlatformSharePolicy: require('../models/PlatformSharePolicy'),
    MarketSharePolicy: require('../models/MarketSharePolicy'),
  };
}

async function ensureGlobalPolicy() {
  const { PlatformSharePolicy } = lazyPolicyModels();
  // Loaded only by the persistence helper so pure math consumers do not
  // initialise environment configuration as a side effect of importing this file.
  const config = require('../config/env');
  const platformBps = config.settlement.commissionBps;
  const seed = {
    scope: GLOBAL_PLATFORM_POLICY_SCOPE,
    platformBps,
    shopkeeperBps: 10000 - platformBps,
    deliveryBps: 0,
    marketOwnerBps: 0,
    customerIncentiveBps: 0,
    promosEnabled: true,
  };

  return PlatformSharePolicy.findOneAndUpdate(
    { scope: GLOBAL_PLATFORM_POLICY_SCOPE },
    { $setOnInsert: seed },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
  );
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
    marketOverride != null && marketOverride.promosEnabled != null
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

async function effectivePolicyForOrder(order) {
  const { MarketSharePolicy } = lazyPolicyModels();
  const global = await ensureGlobalPolicy();
  const marketId = order?.market || order?.marketId || null;

  if (!marketId) {
    return global.toObject();
  }

  const marketOverride = await MarketSharePolicy.findOne({ market: marketId }).lean();
  return mergePolicies(global.toObject(), marketOverride);
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
  GLOBAL_PLATFORM_POLICY_SCOPE,
  assertBpsSum,
  ensureGlobalPolicy,
  effectivePolicyForOrder,
  mergePolicies,
  splitGrossPaise,
  allocateShopkeeperAcrossStalls,
  forceNoMarketOwner,
};
