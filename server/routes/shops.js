'use strict';

const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const VendorKyc = require('../models/VendorKyc');
const { pointFromLatLng } = require('../models/geoPoint');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { stallActionLimiter } = require('../middleware/rateLimit');
const settlement = require('../services/settlement');
const config = require('../config/env');

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
 * Which nearby shops can fill this basket, best first.
 *
 * The question `/nearby` cannot answer. It ranks on distance alone, so a
 * customer picked a shop blind and found out at checkout — where every line must
 * belong to the chosen shop — that it does not stock half the basket.
 *
 * The basket arrives as SHARED-CATALOG item ids, because that is the only way a
 * basket can be shop-independent: each shop keeps its own product rows, so the
 * same tomato is a different document at every shop (see `Product.catalogItem`).
 * `lines` maps each catalog item to this shop's own product id, which is what
 * the client posts at checkout — so `services/checkout.js` needs no change and
 * its `MIXED_SELLERS` guard still holds. No new trust either: checkout already
 * re-checks ownership and recomputes every price from the shop's own rows.
 *
 * A POST, not a query string on `/nearby`: the basket is a list of pairs, which
 * is length-capped and awkward as a URL, and a basket is the customer's data
 * rather than something belonging in a URL that gets logged and cached.
 *
 * Public, exactly as `/nearby` is, so a visitor can see who could serve them
 * before making an account.
 */
router.post(
  '/nearby/coverage',
  optionalAuth,
  validate({
    body: z
      .object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        radius: z.coerce.number().int().min(500).max(50000).default(15000),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        items: z
          .array(
            z
              .object({
                /** A shared-catalog product id, never a shop's own listing. */
                productId: fields.objectId,
                quantity: z.number().int().min(1).max(99),
              })
              .strict()
          )
          .min(1)
          .max(100),
      })
      .strict(),
  }),
  async (req, res) => {
    const { lat, lng, radius, limit, items } = req.valid.body;

    /**
     * Collapse repeats, summing quantities — the same thing checkout does with
     * the same reasoning. Left as sent, one item listed twice would count twice
     * in `total` and no shop could ever reach full coverage.
     */
    const wanted = new Map();
    for (const { productId, quantity } of items) {
      const key = String(productId);
      wanted.set(key, (wanted.get(key) || 0) + quantity);
    }

    const { joined, verified } = await listingExclusions();

    const shops = await User.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radius,
          spherical: true,
          // Mandatory — see the comment on the /nearby $geoNear above.
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
        // Same allowlist as /nearby, for the same reason: the shopkeeper's own
        // name, phone and email share this document and must never be public.
        $project: {
          'shop.name': 1,
          'shop.address': 1,
          'shop.serviceRadiusMeters': 1,
          distanceMeters: { $round: ['$distanceMeters', 0] },
          deliverable: { $lte: ['$distanceMeters', '$shop.serviceRadiusMeters'] },
        },
      },
    ]);

    if (shops.length === 0) return res.json({ data: [] });

    /**
     * One query for every shop's holdings, not one per shop. Served by the
     * compound `{ catalogItem: 1, owner: 1 }` index on Product.
     */
    const holdings = await Product.find({
      owner: { $in: shops.map((s) => s._id) },
      catalogItem: { $in: [...wanted.keys()] },
      isActive: true,
    })
      // `pricePaise` because a shop sells at its own price, not the catalog's.
      // Without it the basket would go on showing catalog prices after a shop
      // was chosen, and checkout would charge the shop's — the customer seeing
      // one number and paying another.
      .select('owner catalogItem stock pricePaise')
      .lean();

    const byShop = new Map();
    for (const row of holdings) {
      const key = String(row.owner);
      if (!byShop.has(key)) byShop.set(key, new Map());
      const item = String(row.catalogItem);
      const existing = byShop.get(key).get(item);
      /**
       * A shop listing the same catalog item twice is not supposed to happen,
       * but if it does the better-stocked row wins rather than whichever the
       * cursor returned last — otherwise coverage would vary between calls.
       */
      if (!existing || row.stock > existing.stock) {
        byShop.get(key).set(item, {
          productId: String(row._id),
          stock: row.stock,
          pricePaise: row.pricePaise,
        });
      }
    }

    const total = wanted.size;

    const data = shops.map((s) => {
      const held = byShop.get(String(s._id)) || new Map();
      const lines = [];

      for (const [productId, quantity] of wanted) {
        const row = held.get(productId);
        /**
         * Stock has to cover the QUANTITY, not merely exist. A shop with one
         * tomato does not cover a line of three, and counting it would send the
         * order somewhere that cannot fill it — the exact failure this endpoint
         * exists to prevent. Same rule as `coverageOf` in services/sourcing.js.
         */
        if (!row || row.stock < quantity) continue;
        lines.push({
          catalogItemId: productId,
          productId: row.productId,
          quantity,
          pricePaise: row.pricePaise,
          // Rupees alongside paise, the same way the catalog exposes both —
          // persistence stays integer, presentation gets a number it can render.
          price: row.pricePaise / 100,
        });
      }

      return {
        // The shopkeeper's user id: what an order is addressed to.
        id: String(s._id),
        name: s.shop.name,
        address: s.shop.address,
        isOpen: true,
        distanceMeters: s.distanceMeters,
        deliverable: s.deliverable,
        covered: lines.length,
        total,
        canFillBasket: lines.length === total,
        lines,
      };
    });

    /**
     * Whole-basket shops first, then the ones that can actually deliver here,
     * then by how much of the basket they hold, and only then by distance.
     *
     * Distance is the LAST word rather than the first: a shop two streets
     * further away that has everything beats a closer one that does not, because
     * the near one cannot be ordered from at all — checkout takes an order only
     * from a shop that can fill every line of it.
     *
     * `covered` sorts the shops that cannot fill it either, even though none of
     * them is selectable, so the list reads down as steadily fewer items. Ranked
     * on distance alone it showed "has 3 of your 5" above "has 4 of your 5",
     * which reads as a mistake in the ranking rather than a fact about distance.
     *
     * `deliverable` outranks coverage because a shop that cannot reach this
     * address is no use however well stocked it is.
     *
     * `$geoNear` already returned these nearest-first, and Array#sort is stable
     * in every engine this runs on, so shops equal on all four keep that order.
     */
    data.sort(
      (a, b) =>
        Number(b.canFillBasket) - Number(a.canFillBasket) ||
        Number(b.deliverable) - Number(a.deliverable) ||
        b.covered - a.covered ||
        a.distanceMeters - b.distanceMeters
    );

    return res.json({ data });
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

/**
 * Is a delivery partner nearby right now — an ambient signal for the
 * dashboard, answered from wherever this shopkeeper actually trades.
 *
 * A stall shopkeeper has no `shop.location` of their own — they trade through
 * the market's pin, same as every other place that treats a stall as "reached
 * through its market" rather than a location in its own right. An independent
 * shopkeeper falls back to their own shop pin.
 *
 * This is a courtesy heads-up, not a dispatch decision, so it deliberately
 * does not reuse `riderSearchRadiusMeters` — that number is tuned for "will
 * dispatch eventually find someone", this one for "is someone close enough
 * that it's worth mentioning".
 */
router.get('/me/nearby-rider', ...shopGate, async (req, res) => {
  const stall = await Stall.findOne({ owner: req.user._id, isActive: true, status: 'approved' })
    .select('market')
    .populate('market', 'location')
    .lean();

  const location = stall?.market?.location || req.user.shop?.location;
  if (!location?.coordinates) {
    return res.json({ data: null });
  }

  const staleSince = new Date(Date.now() - config.marketplace.riderStaleLocationSeconds * 1000);

  const [nearest] = await User.aggregate([
    {
      $geoNear: {
        near: location,
        distanceField: 'distanceMeters',
        maxDistance: config.marketplace.nearbyRiderRadiusMeters,
        spherical: true,
        // Mandatory — see the comment on the /nearby $geoNear above.
        key: 'rider.lastLocation',
        query: {
          role: 'delivery',
          status: 'active',
          'rider.dutyStatus': 'online',
          'rider.lastLocationAt': { $gte: staleSince },
        },
      },
    },
    { $limit: 1 },
    { $project: { distanceMeters: { $round: ['$distanceMeters', 0] } } },
  ]);

  return res.json({ data: nearest ? { distanceMeters: nearest.distanceMeters } : null });
});

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

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/**
 * What this shop is owed, what has already been paid, and when the rest lands.
 *
 * The same two routes exist under /api/stalls, behind that router's stall gate.
 * They are duplicated rather than shared because the GATE is the difference: a
 * shopkeeper trading from their own premises has no stall, so `stallGate`
 * answers 404 NO_STALL and they could not reach their money at all. The
 * handlers themselves are three lines each and delegate to the same functions,
 * which are keyed on `owner` and do not care which kind of seller is asking.
 */
router.get('/me/earnings', ...shopGate, async (req, res) => {
  const [summary, recent] = await Promise.all([
    settlement.summaryForOwner(req.user._id),
    settlement.recentForOwner(req.user._id),
  ]);

  return res.json({ data: { ...summary, recent } });
});

/**
 * Take the held money now rather than waiting out the hold.
 *
 * Rate-limited for the same reason as the stall equivalent: it is the one route
 * here that moves money, and a retry loop against it is worth bounding hard.
 */
router.post('/me/earnings/withdraw', ...shopGate, stallActionLimiter, async (req, res) => {
  // Throws 409 BELOW_MINIMUM with the shortfall when there is not enough yet.
  const result = await settlement.releaseEarly(req.user._id);
  const summary = await settlement.summaryForOwner(req.user._id);

  return res.json({ data: { ...result, ...summary } });
});

module.exports = router;
