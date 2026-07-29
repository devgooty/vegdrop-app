'use strict';

const express = require('express');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const OPERATOR_ROLES = ['market_owner', 'developer'];

/**
 * Coordinate handling.
 *
 * Clients speak {latitude, longitude} because that is what every map widget
 * emits. MongoDB speaks [longitude, latitude]. The swap is confined to these two
 * helpers so it cannot be got wrong in a route by accident.
 */
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

const toGeoPoint = (lat, lng) => ({ type: 'Point', coordinates: [lng, lat] });

/**
 * Browsing the market list does not require an account — a customer needs to see
 * whether anyone serves their area before deciding to sign up.
 */
router.get(
  '/',
  optionalAuth,
  validate({
    query: z
      .object({
        latitude: z.coerce.number().min(-90).max(90).optional(),
        longitude: z.coerce.number().min(-180).max(180).optional(),
        // Cap the search so a client cannot ask for every market in the country.
        radiusM: z.coerce.number().int().min(100).max(50_000).default(15_000),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
  }),
  async (req, res) => {
    const { latitude: lat, longitude: lng, radiusM, limit } = req.valid.query;

    // Without a position there is no meaningful ordering; return actives by name.
    if (lat === undefined || lng === undefined) {
      const markets = await Market.find({ isActive: true }).sort({ name: 1 }).limit(limit);
      return res.json({ data: markets.map((m) => m.toJSON()), nearest: null });
    }

    /**
     * $geoNear must be the first stage of the pipeline and computes the great-circle
     * distance in metres, which is what `serviceRadiusM` is expressed in.
     */
    const results = await Market.aggregate([
      {
        $geoNear: {
          near: toGeoPoint(lat, lng),
          distanceField: 'distanceM',
          maxDistance: radiusM,
          query: { isActive: true },
          spherical: true,
        },
      },
      { $limit: limit },
    ]);

    const markets = results.map((doc) => ({
      ...doc,
      id: doc._id.toHexString(),
      latitude: doc.location?.coordinates?.[1] ?? null,
      longitude: doc.location?.coordinates?.[0] ?? null,
      distanceM: Math.round(doc.distanceM),
      // Inside the radius the market delivers; outside, it is listed but flagged.
      deliverable: doc.distanceM <= doc.serviceRadiusM,
      _id: undefined,
    }));

    return res.json({
      data: markets,
      nearest: markets.find((m) => m.deliverable) || null,
    });
  }
);

router.get(
  '/:id',
  optionalAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const market = await Market.findOne({ _id: req.valid.params.id, isActive: true });
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    const stalls = await Stall.find({ market: market._id, isActive: true })
      .select('stallNumber name isOpen phone location avgAcceptSeconds')
      .sort({ stallNumber: 1 });

    return res.json({
      data: { ...market.toJSON(), stalls: stalls.map((s) => s.toJSON()) },
    });
  }
);

router.post(
  '/',
  requireAuth,
  requireRole(OPERATOR_ROLES),
  validate({
    body: z
      .object({
        name: fields.nonEmptyString(160),
        slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,80}$/, 'Slug must be lowercase letters, digits and hyphens.'),
        address: fields.nonEmptyString(500),
        city: fields.nonEmptyString(120),
        pincode: z.string().trim().max(12).optional(),
        latitude,
        longitude,
        serviceRadiusM: z.number().int().min(100).max(50_000).optional(),
        opensAtMinute: z.number().int().min(0).max(1439).optional(),
        closesAtMinute: z.number().int().min(0).max(1439).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { latitude: lat, longitude: lng, ...rest } = req.valid.body;

    const exists = await Market.findOne({ slug: rest.slug }).select('_id').lean();
    if (exists) throw new ApiError(409, 'A market with that slug already exists.', 'DUPLICATE_SLUG');

    const market = await Market.create({ ...rest, location: toGeoPoint(lat, lng) });
    return res.status(201).json({ data: market.toJSON() });
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
        name: fields.nonEmptyString(160).optional(),
        address: fields.nonEmptyString(500).optional(),
        city: fields.nonEmptyString(120).optional(),
        pincode: z.string().trim().max(12).optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        serviceRadiusM: z.number().int().min(100).max(50_000).optional(),
        opensAtMinute: z.number().int().min(0).max(1439).optional(),
        closesAtMinute: z.number().int().min(0).max(1439).optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { latitude: lat, longitude: lng, ...rest } = req.valid.body;

    // A half-supplied coordinate would silently move the market to the equator.
    if ((lat === undefined) !== (lng === undefined)) {
      throw new ApiError(400, 'Latitude and longitude must be supplied together.', 'VALIDATION_ERROR');
    }

    const update = { ...rest };
    if (lat !== undefined) update.location = toGeoPoint(lat, lng);

    if (Object.keys(update).length === 0) {
      throw new ApiError(400, 'No fields to update.', 'VALIDATION_ERROR');
    }

    const market = await Market.findByIdAndUpdate(
      req.valid.params.id,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    return res.json({ data: market.toJSON() });
  }
);

module.exports = router;
module.exports.toGeoPoint = toGeoPoint;
