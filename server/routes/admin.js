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

const MARKET_OVERRIDE_FIELDS = [
  'platformBps',
  'shopkeeperBps',
  'deliveryBps',
  'marketOwnerBps',
  'customerIncentiveBps',
  'promosEnabled',
];

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
  sharePolicy.assertValidPolicy(body);

  /**
   * A market override is validated against the global policy IT WAS SAVED
   * UNDER, and the merge is recomputed from the live global on every
   * settlement — so editing the global can silently turn a stored override
   * invalid (a partial override's rebalanced shopkeeper share goes negative,
   * or an explicit override's merged sum drifts off 10000). Settlement then
   * refuses those orders and they pile up unsettled. Refuse the edit here
   * instead, naming the markets, so the admin fixes the overrides first —
   * a fully explicit override sums to 10000 under any global, so there is
   * always an order of operations that gets both changes through.
   */
  const overrides = await MarketSharePolicy.find({}).lean();
  const broken = overrides.filter(
    (override) => !sharePolicy.policyIsValid(sharePolicy.mergePolicies(body, override))
  );
  if (broken.length > 0) {
    const markets = await Market.find({ _id: { $in: broken.map((b) => b.market) } })
      .select('name')
      .lean();
    const names = markets.map((m) => m.name).join(', ');
    throw new ApiError(
      409,
      `This change would make the share split invalid for ${broken.length} market(s): ${names}. ` +
        'Update or remove those market overrides first.',
      'SHARE_POLICY_CONFLICT'
    );
  }

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

    /**
     * Validate the post-patch override, because omitted fields keep their
     * existing stored values while null fields explicitly return to inheritance.
     *
     * `assertValidPolicy`, not `assertBpsSum`: the rebalance in `mergePolicies`
     * constructs a sum of exactly 10000 by definition, so the sum check alone
     * waved through a merged policy whose shopkeeper share was NEGATIVE
     * (inherited fields plus an explicit override exceeding 10000 together).
     * Range-checking every merged bucket is the check that actually binds here.
     */
    const effective = sharePolicy.mergePolicies(global.toObject(), nextOverride);
    sharePolicy.assertValidPolicy(effective);

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
