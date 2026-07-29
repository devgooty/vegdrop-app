'use strict';

const express = require('express');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const { resolveOwnedStall } = require('../services/stallAccess');

const router = express.Router();

const OPERATOR_ROLES = ['market_owner', 'developer'];

router.get(
  '/',
  optionalAuth,
  validate({
    query: z
      .object({
        marketId: fields.objectId.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  async (req, res) => {
    const { marketId, limit } = req.valid.query;

    const filter = { isActive: true };
    if (marketId) filter.market = marketId;

    const stalls = await Stall.find(filter).sort({ stallNumber: 1 }).limit(limit);
    return res.json({ data: stalls.map((s) => s.toJSON()) });
  }
);

/**
 * The stall the signed-in shopkeeper operates. The panel calls this on mount to
 * learn which stall it is acting as — the client never chooses.
 */
router.get('/mine', requireAuth, requireRole('shopkeeper', 'developer'), async (req, res) => {
  const stall = await Stall.findOne({ owner: req.user._id, isActive: true }).populate('market', 'name slug address city');
  if (!stall) {
    throw new ApiError(404, 'No stall is assigned to this account. Ask the market owner to create one.', 'NO_STALL');
  }
  return res.json({ data: stall.toJSON() });
});

/** Vendor-controlled open/closed. Scoped to the caller's own stall. */
router.patch(
  '/mine/availability',
  requireAuth,
  requireRole('shopkeeper', 'developer'),
  validate({ body: z.object({ isOpen: z.boolean() }).strict() }),
  async (req, res) => {
    const stall = await resolveOwnedStall(req.user);
    stall.isOpen = req.valid.body.isOpen;
    await stall.save();
    return res.json({ data: stall.toJSON() });
  }
);

router.post(
  '/',
  requireAuth,
  requireRole(OPERATOR_ROLES),
  validate({
    body: z
      .object({
        marketId: fields.objectId,
        ownerId: fields.objectId,
        stallNumber: fields.nonEmptyString(20),
        name: fields.nonEmptyString(160),
        phone: fields.phone,
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { marketId, ownerId, latitude, longitude, ...rest } = req.valid.body;

    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new ApiError(400, 'Latitude and longitude must be supplied together.', 'VALIDATION_ERROR');
    }

    const market = await Market.findById(marketId).select('_id isActive').lean();
    if (!market || !market.isActive) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    const owner = await User.findById(ownerId).select('_id role status');
    if (!owner || owner.status !== 'active') throw new ApiError(404, 'Owner account not found.', 'NOT_FOUND');
    if (owner.role !== 'shopkeeper') {
      throw new ApiError(
        409,
        'A stall owner must hold the shopkeeper role. Change the role first via PATCH /api/users/:id/role.',
        'INVALID_OWNER_ROLE'
      );
    }

    const stall = await Stall.create({
      ...rest,
      market: marketId,
      owner: ownerId,
      ...(latitude !== undefined ? { location: { type: 'Point', coordinates: [longitude, latitude] } } : {}),
    }).catch((err) => {
      // Unique on {market, owner} and {market, stallNumber}.
      if (err?.code === 11000) {
        throw new ApiError(409, 'That owner or stall number is already taken in this market.', 'DUPLICATE_STALL');
      }
      throw err;
    });

    return res.status(201).json({ data: stall.toJSON() });
  }
);

router.patch(
  '/:id',
  requireAuth,
  requireRole(OPERATOR_ROLES),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        stallNumber: fields.nonEmptyString(20).optional(),
        name: fields.nonEmptyString(160).optional(),
        phone: fields.phone.optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        isOpen: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { latitude, longitude, ...rest } = req.valid.body;

    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new ApiError(400, 'Latitude and longitude must be supplied together.', 'VALIDATION_ERROR');
    }

    const update = { ...rest };
    if (latitude !== undefined) {
      update.location = { type: 'Point', coordinates: [longitude, latitude] };
    }

    if (Object.keys(update).length === 0) {
      throw new ApiError(400, 'No fields to update.', 'VALIDATION_ERROR');
    }

    const stall = await Stall.findByIdAndUpdate(
      req.valid.params.id,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!stall) throw new ApiError(404, 'Stall not found.', 'NOT_FOUND');

    return res.json({ data: stall.toJSON() });
  }
);

module.exports = router;
