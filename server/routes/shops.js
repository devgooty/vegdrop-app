'use strict';

const express = require('express');
const User = require('../models/User');
const Stall = require('../models/Stall');
const VendorKyc = require('../models/VendorKyc');
const { pointFromLatLng } = require('../models/geoPoint');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Independent shops — shopkeepers who sell from their own premises rather than
 * from a stall inside a market.
 *
 * The rule this file exists to enforce: a shopkeeper who has joined a market is
 * reached THROUGH that market and is never listed here. Customers pick a market
 * for those (see MarketPicker on the client, and routes/markets.js /nearby); a
 * stall is deliberately never surfaced on its own. This router covers only the
 * other case — nobody's stall, their own address.
 *
 * There is deliberately no `/:id` route, so the `/nearby`-shadowed-by-`/:id`
 * ordering trap cannot appear here later.
 */

/** Setting your own shop up is a shopkeeper action; developer for support. */
const shopGate = [requireAuth, requireRole('shopkeeper', 'developer')];

/**
 * Who may appear to customers.
 *
 * Two exclusions, resolved up front into id lists rather than `$lookup`ed after
 * the geo stage. Filtering afterwards would silently under-fill `$limit` — the
 * aggregation would take the 20 nearest and *then* discard some — and Stall's
 * unique index on `owner` is partial on `status`, so a bare `{ owner: X }`
 * lookup could not use it and would scan per candidate.
 */
async function listingExclusions() {
  const [joined, verified] = await Promise.all([
    // Trades at a market → represented by that market, not by itself.
    Stall.distinct('owner', { status: 'approved' }),
    /**
     * Anyone can self-register a shopkeeper account, so without this the
     * customer's home screen is an unmoderated surface: register, drop a pin
     * anywhere, appear. A market stall has a human approving it; an independent
     * shop has nobody, so the penny drop is the gate that stands in for one.
     * Same principle as middleware/vendorVerified.js — the role gets you the
     * panel, proving you control a settlement account gets you customers.
     */
    VendorKyc.distinct('user', { status: 'verified' }),
  ]);
  return { joined, verified };
}

/**
 * Shops near a point, nearest first. Public, so a visitor can see what is
 * available before creating an account — same reasoning as /markets/nearby,
 * whose shape and query contract this deliberately mirrors.
 */
router.get(
  '/nearby',
  optionalAuth,
  validate({
    query: z
      .object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        radius: z.coerce.number().int().min(500).max(50000).default(15000),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
  }),
  async (req, res) => {
    const { lat, lng, radius, limit } = req.valid.query;
    const { joined, verified } = await listingExclusions();

    const shops = await User.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radius,
          spherical: true,
          /**
           * Mandatory. User carries two 2dsphere indexes — rider.lastLocation
           * and shop.location — and $geoNear refuses to guess between them,
           * failing the request outright rather than picking one. Omitting this
           * breaks rider dispatch as well as this route.
           */
          key: 'shop.location',
          query: {
            role: 'shopkeeper',
            status: 'active',
            'shop.isOpen': true,
            _id: { $nin: joined, $in: verified },
          },
        },
      },
      { $limit: limit },
      {
        /**
         * shop.* only. The shopkeeper's own name, phone and email live on this
         * same document and must never reach a public list — projecting the
         * allowlist rather than deleting known-bad fields means a later schema
         * addition cannot leak by default.
         */
        $project: {
          'shop.name': 1,
          'shop.address': 1,
          'shop.serviceRadiusMeters': 1,
          distanceMeters: { $round: ['$distanceMeters', 0] },
          // Shown but flagged rather than hidden, exactly as markets are: "too
          // far to deliver" answers the question, a silent omission raises it.
          deliverable: { $lte: ['$distanceMeters', '$shop.serviceRadiusMeters'] },
        },
      },
    ]);

    return res.json({
      data: shops.map((s) => ({
        // The shopkeeper's user id: this is what an order is addressed to.
        id: String(s._id),
        name: s.shop.name,
        address: s.shop.address,
        // The query already filtered on it; stated so the card renders the same
        // way a market card does.
        isOpen: true,
        distanceMeters: s.distanceMeters,
        deliverable: s.deliverable,
      })),
    });
  }
);

/**
 * The caller's own shop.
 *
 * Reports why it is or is not listed rather than just the raw fields — the
 * dashboard needs to tell a shopkeeper "finish KYC" or "you trade at a market"
 * instead of leaving them wondering where their shop went.
 */
router.get('/me', ...shopGate, async (req, res) => {
  const [stall, kyc] = await Promise.all([
    Stall.exists({ owner: req.user._id, status: 'approved' }),
    VendorKyc.findOne({ user: req.user._id }).select('status').lean(),
  ]);

  const shop = req.user.shop || {};
  const coordinates = shop.location?.coordinates;

  return res.json({
    data: {
      name: shop.name || '',
      address: shop.address || '',
      isOpen: shop.isOpen !== false,
      serviceRadiusMeters: shop.serviceRadiusMeters ?? 6000,
      lat: coordinates ? coordinates[1] : null,
      lng: coordinates ? coordinates[0] : null,
      hasLocation: Boolean(coordinates),
      locationUpdatedAt: shop.locationUpdatedAt || null,
      // Both false is the only state that gets you listed.
      hasStall: Boolean(stall),
      kycVerified: kyc?.status === 'verified',
    },
  });
});

/**
 * Set or move the shop pin.
 *
 * PUT rather than POST because this is idempotent replacement — the shop is
 * where it is. Distinct in kind from the rider's POST /api/rider/location,
 * which is an append-style heartbeat and rate-limited as one.
 */
router.put(
  '/me/location',
  ...shopGate,
  validate({
    body: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        name: fields.nonEmptyString(160).optional(),
        address: fields.nonEmptyString(500).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { lat, lng, name, address } = req.valid.body;

    const update = {
      // pointFromLatLng flips to [lng, lat]; do not hand it a pre-built point.
      'shop.location': pointFromLatLng(lat, lng),
      'shop.locationUpdatedAt': new Date(),
    };
    if (name !== undefined) update['shop.name'] = name;
    if (address !== undefined) update['shop.address'] = address;

    /**
     * A shop with no display name would be listed as a blank row, so fall back
     * to the shopkeeper's own name — the same default POST /markets/:id/join
     * uses for a stall. Stored once here rather than resolved at read time, so
     * the public projection never has to reach for `user.name`.
     */
    if (!name && !req.user.shop?.name) update['shop.name'] = req.user.name;

    await User.updateOne({ _id: req.user._id }, { $set: update });

    return res.json({
      data: { lat, lng, name: update['shop.name'] ?? req.user.shop?.name ?? '', hasLocation: true },
    });
  }
);

/** Shutter switch, display details, and delivery range. */
router.patch(
  '/me',
  ...shopGate,
  validate({
    body: z
      .object({
        isOpen: z.boolean().optional(),
        name: fields.nonEmptyString(160).optional(),
        address: fields.nonEmptyString(500).optional(),
        serviceRadiusMeters: z.number().int().min(100).max(50000).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const body = req.valid.body;
    const update = {};
    for (const key of ['isOpen', 'name', 'address', 'serviceRadiusMeters']) {
      if (body[key] !== undefined) update[`shop.${key}`] = body[key];
    }

    if (Object.keys(update).length === 0) {
      return res.json({ data: { updated: false } });
    }

    await User.updateOne({ _id: req.user._id }, { $set: update });
    return res.json({ data: { updated: true } });
  }
);

module.exports = router;
