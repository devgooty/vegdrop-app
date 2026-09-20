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
    promosEnabled: z.boolean().optional(),
  })
  .strict();

const marketParams = z.object({ id: fields.objectId }).strict();

const BPS_FIELDS_EXCEPT_SHOPKEEPER = [
  'platformBps',
  'deliveryBps',
  'marketOwnerBps',
  'customerIncentiveBps',
];

function rejectImpossibleRebalance(body) {
  if (Object.prototype.hasOwnProperty.call(body, 'shopkeeperBps')) return;

  const explicitOtherSum = BPS_FIELDS_EXCEPT_SHOPKEEPER.reduce((sum, key) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return sum;
    return sum + (body[key] ?? 0);
  }, 0);

  if (explicitOtherSum > 10000) {
    throw new ApiError(400, 'Share basis points must sum to exactly 10000.', 'SHARE_BPS_INVALID');
  }
}

async function requireMarket(id) {
  const market = await Market.findById(id).select('_id');
  if (!market) {
    throw new ApiError(404, 'Market not found.', 'NOT_FOUND');
  }
  return market;
}

router.use(...adminGate);

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
    {},
    { $set: { ...body, updatedBy: req.user._id } },
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

    rejectImpossibleRebalance(body);
    /**
     * A market override may omit shopkeeperBps. mergePolicies then rebalances
     * shopkeeperBps so the effective policy still totals 10000; validate the
     * merged effective policy, not just the partial override payload.
     */
    const effective = sharePolicy.mergePolicies(global.toObject(), body);
    sharePolicy.assertBpsSum(effective);

    const policy = await MarketSharePolicy.findOneAndUpdate(
      { market: req.valid.params.id },
      { $set: { ...body, market: req.valid.params.id, updatedBy: req.user._id } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
    );

    return res.json({ policy, effective });
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
