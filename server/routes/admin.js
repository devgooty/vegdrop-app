'use strict';

const express = require('express');
const Market = require('../models/Market');
const PlatformSharePolicy = require('../models/PlatformSharePolicy');
const MarketSharePolicy = require('../models/MarketSharePolicy');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const sharePolicy = require('../services/sharePolicy');

const router = express.Router();

const adminGate = [requireAuth, requireRole('admin', 'developer')];

const bps = z.number().int().min(0).max(10000);
const globalPolicyBody = z
  .object({
    platformBps: bps,
    shopkeeperBps: bps,
    deliveryBps: bps,
    marketOwnerBps: bps,
    customerIncentiveBps: bps,
    promosEnabled: z.boolean().optional(),
  })
  .strict();

const marketPolicyBody = z
  .object({
    platformBps: bps.nullable().optional(),
    shopkeeperBps: bps.nullable().optional(),
    deliveryBps: bps.nullable().optional(),
    marketOwnerBps: bps.nullable().optional(),
    customerIncentiveBps: bps.nullable().optional(),
    promosEnabled: z.boolean().nullable().optional(),
  })
  .strict();

const marketParams = z.object({ id: fields.objectId }).strict();

const BPS_FIELDS_EXCEPT_SHOPKEEPER = [
  'platformBps',
  'deliveryBps',
  'marketOwnerBps',
  'customerIncentiveBps',
];

const MARKET_OVERRIDE_FIELDS = [
  'platformBps',
  'shopkeeperBps',
  'deliveryBps',
  'marketOwnerBps',
  'customerIncentiveBps',
  'promosEnabled',
];

function rejectImpossibleRebalance(body) {
  if (body.shopkeeperBps != null) return;

  const explicitOtherSum = BPS_FIELDS_EXCEPT_SHOPKEEPER.reduce((sum, key) => {
    return sum + (body[key] ?? 0);
  }, 0);

  if (explicitOtherSum > 10000) {
    throw new ApiError(400, 'Share basis points must sum to exactly 10000.', 'SHARE_BPS_INVALID');
  }
}

function nextMarketOverride(existing, patch) {
  const next = {};
  for (const key of MARKET_OVERRIDE_FIELDS) {
    next[key] = Object.prototype.hasOwnProperty.call(patch, key)
      ? patch[key]
      : existing?.[key] ?? null;
  }
  return next;
}

async function requireMarket(id) {
  const market = await Market.findById(id).select('_id');
  if (!market) {
    throw new ApiError(404, 'Market not found.', 'NOT_FOUND');
  }
  return market;
}

router.use(...adminGate);

router.get('/markets', async (_req, res) => {
  const markets = await Market.find({}).select('name').sort({ name: 1 }).lean();
  return res.json({
    data: markets.map((market) => ({
      id: String(market._id),
      name: market.name,
    })),
  });
});

router.get('/share-policy', async (_req, res) => {
  const policy = await sharePolicy.ensureGlobalPolicy();
  return res.json({ policy });
});

router.put('/share-policy', validate({ body: globalPolicyBody }), async (req, res) => {
  const body = {
    promosEnabled: true,
    ...req.valid.body,
  };
  sharePolicy.assertBpsSum(body);

  const policy = await PlatformSharePolicy.findOneAndUpdate(
    { scope: sharePolicy.GLOBAL_PLATFORM_POLICY_SCOPE },
    {
      $set: { ...body, updatedBy: req.user._id },
      $setOnInsert: { scope: sharePolicy.GLOBAL_PLATFORM_POLICY_SCOPE },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
  );

  return res.json({ policy });
});

router.get(
  '/markets/:id/share-policy',
  validate({ params: marketParams }),
  async (req, res) => {
    await requireMarket(req.valid.params.id);
    const policy = await MarketSharePolicy.findOne({ market: req.valid.params.id });
    const effective = await sharePolicy.effectivePolicyForOrder({ market: req.valid.params.id });
    return res.json({ policy, effective });
  }
);

router.put(
  '/markets/:id/share-policy',
  validate({ params: marketParams, body: marketPolicyBody }),
  async (req, res) => {
    await requireMarket(req.valid.params.id);
    const global = await sharePolicy.ensureGlobalPolicy();
    const body = req.valid.body;
    const existing = await MarketSharePolicy.findOne({ market: req.valid.params.id }).lean();
    const nextOverride = nextMarketOverride(existing, body);

    rejectImpossibleRebalance(nextOverride);
    /**
     * Validate the post-patch override, because omitted fields keep their
     * existing stored values while null fields explicitly return to inheritance.
     */
    const effective = sharePolicy.mergePolicies(global.toObject(), nextOverride);
    sharePolicy.assertBpsSum(effective);

    const policy = await MarketSharePolicy.findOneAndUpdate(
      { market: req.valid.params.id },
      { $set: { ...nextOverride, market: req.valid.params.id, updatedBy: req.user._id } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
    );
    const savedEffective = sharePolicy.mergePolicies(global.toObject(), policy.toObject());

    return res.json({ policy, effective: savedEffective });
  }
);

router.delete(
  '/markets/:id/share-policy',
  validate({ params: marketParams }),
  async (req, res) => {
    await requireMarket(req.valid.params.id);
    await MarketSharePolicy.deleteOne({ market: req.valid.params.id });
    const effective = await sharePolicy.effectivePolicyForOrder({ market: req.valid.params.id });
    return res.json({ policy: null, effective });
  }
);

module.exports = router;
