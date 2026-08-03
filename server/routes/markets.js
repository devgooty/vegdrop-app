'use strict';

const express = require('express');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const Product = require('../models/Product');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');

const router = express.Router();

/** Only a market owner (or a developer) shapes a market and its price sheet. */
const MARKET_MANAGERS = ['market_owner', 'developer'];

const rupeesToPaise = z
  .number()
  .nonnegative()
  .max(1_000_000)
  .transform((rupees) => Math.round(rupees * 100));

/**
 * Markets near a point, nearest first.
 *
 * This is the first screen after sign-in: which vegetable markets can reach me.
 * Public, because a visitor should be able to see what is available before
 * creating an account.
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

    const markets = await Market.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radius,
          spherical: true,
          query: { isActive: true },
        },
      },
      { $limit: limit },
      {
        $project: {
          name: 1,
          slug: 1,
          address: 1,
          isOpen: 1,
          serviceRadiusMeters: 1,
          distanceMeters: { $round: ['$distanceMeters', 0] },
          // A market further away than it is willing to deliver is shown, but
          // flagged, rather than hidden — "too far to deliver" is more useful to
          // a customer than a market silently missing from the list.
          deliverable: { $lte: ['$distanceMeters', '$serviceRadiusMeters'] },
        },
      },
    ]);

    // Stall counts, so the customer can see a market is actually staffed.
    const counts = await Stall.aggregate([
      { $match: { market: { $in: markets.map((m) => m._id) }, isActive: true, isOpen: true } },
      { $group: { _id: '$market', openStalls: { $sum: 1 } } },
    ]);
    const byMarket = new Map(counts.map((c) => [String(c._id), c.openStalls]));

    return res.json({
      data: markets.map((m) => ({
        id: String(m._id),
        name: m.name,
        slug: m.slug,
        address: m.address,
        isOpen: m.isOpen,
        distanceMeters: m.distanceMeters,
        deliverable: m.deliverable,
        openStalls: byMarket.get(String(m._id)) || 0,
      })),
    });
  }
);

/**
 * What a market is selling today, and for how much.
 *
 * The prices here are the market's own sheet, not the platform catalog — that
 * is the whole point of one price per market. Joined onto the product record so
 * the customer still gets the name, image and weight they are used to.
 */
router.get(
  '/:id/catalog',
  optionalAuth,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    query: z
      .object({
        categoryId: z.coerce.number().int().optional(),
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(120),
      })
      .strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { categoryId, search, limit } = req.valid.query;

    const market = await Market.findOne({ _id: id, isActive: true }).lean();
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    const productFilter = { isActive: true };
    if (categoryId !== undefined) productFilter.categoryId = categoryId;
    if (search) {
      // Escape regex metacharacters: an unescaped user string is a ReDoS vector.
      productFilter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const [sheet, products] = await Promise.all([
      MarketPrice.find({ market: id, isAvailable: true }).select('product pricePaise').lean(),
      Product.find(productFilter).select('name weight image isOrganic rating reviews categoryId').lean(),
    ]);

    const priceByProduct = new Map(sheet.map((row) => [String(row.product), row.pricePaise]));

    const data = products
      .filter((p) => priceByProduct.has(String(p._id)))
      .slice(0, limit)
      .map((p) => ({
        id: String(p._id),
        categoryId: p.categoryId,
        name: p.name,
        weight: p.weight,
        image: p.image,
        isOrganic: p.isOrganic,
        rating: p.rating,
        reviews: p.reviews,
        pricePaise: priceByProduct.get(String(p._id)),
        price: priceByProduct.get(String(p._id)) / 100,
        // Shown on the card next to the product name, as asked.
        marketId: String(market._id),
        marketName: market.name,
      }));

    // Same reasoning as the platform catalog: identical for every visitor, and
    // short-lived because a market can pull a line at any moment.
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return res.json({ data });
  }
);

router.get(
  '/:id',
  optionalAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const market = await Market.findOne({ _id: req.valid.params.id, isActive: true });
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');
    return res.json({ data: market.toJSON() });
  }
);

// ---------------------------------------------------------------------------
// Market owner administration
// ---------------------------------------------------------------------------

router.post(
  '/',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    body: z
      .object({
        name: fields.nonEmptyString(160),
        slug: fields.nonEmptyString(80),
        address: fields.nonEmptyString(500),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        serviceRadiusMeters: z.number().int().min(100).max(50000).optional(),
        contactPhone: z.string().trim().max(20).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { lat, lng, ...rest } = req.valid.body;
    const market = await Market.create({
      ...rest,
      location: { type: 'Point', coordinates: [lng, lat] },
    });
    return res.status(201).json({ data: market.toJSON() });
  }
);

router.patch(
  '/:id',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        name: fields.nonEmptyString(160).optional(),
        address: fields.nonEmptyString(500).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        serviceRadiusMeters: z.number().int().min(100).max(50000).optional(),
        contactPhone: z.string().trim().max(20).optional(),
        isOpen: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { lat, lng, ...rest } = req.valid.body;
    const update = { ...rest };

    if (lat !== undefined || lng !== undefined) {
      if (lat === undefined || lng === undefined) {
        throw new ApiError(400, 'Moving a market needs both lat and lng.', 'VALIDATION_ERROR');
      }
      update.location = { type: 'Point', coordinates: [lng, lat] };
    }

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

/** The owner's own view of the sheet, including lines they have switched off. */
router.get(
  '/:id/prices',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const prices = await MarketPrice.find({ market: req.valid.params.id })
      .populate('product', 'name weight image categoryId')
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      data: prices.map((row) => ({
        id: String(row._id),
        product: row.product ? { id: String(row.product._id), ...row.product, _id: undefined } : null,
        pricePaise: row.pricePaise,
        price: row.pricePaise / 100,
        isAvailable: row.isAvailable,
        updatedAt: row.updatedAt,
      })),
    });
  }
);

/**
 * Set prices, one call for the whole sheet.
 *
 * Upsert rather than insert-or-fail: the unique (market, product) index means
 * two owners editing at once collide on the index instead of writing two rows
 * for the same vegetable, and whichever lands second simply wins.
 */
router.put(
  '/:id/prices',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        prices: z
          .array(
            z
              .object({
                productId: fields.objectId,
                price: rupeesToPaise,
                isAvailable: z.boolean().optional(),
              })
              .strict()
          )
          .min(1)
          .max(500),
      })
      .strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { prices } = req.valid.body;

    const market = await Market.findById(id);
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    const productIds = prices.map((p) => p.productId);
    const known = await Product.countDocuments({ _id: { $in: productIds }, isActive: true });
    if (known !== new Set(productIds.map(String)).size) {
      throw new ApiError(400, 'One or more products do not exist.', 'PRODUCT_UNAVAILABLE');
    }

    await MarketPrice.bulkWrite(
      prices.map((row) => ({
        updateOne: {
          filter: { market: market._id, product: row.productId },
          update: {
            $set: {
              pricePaise: row.price,
              isAvailable: row.isAvailable ?? true,
              updatedBy: req.user._id,
            },
          },
          upsert: true,
        },
      }))
    );

    return res.json({ data: { updated: prices.length } });
  }
);

/** The stalls in a market — who is trading, and how busy each of them is. */
router.get(
  '/:id/stalls',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const stalls = await Stall.find({ market: req.valid.params.id })
      .populate('owner', 'name phone')
      .sort({ stallNumber: 1 })
      .lean();

    return res.json({
      data: stalls.map((s) => ({
        id: String(s._id),
        stallNumber: s.stallNumber,
        name: s.name,
        owner: s.owner ? { id: String(s.owner._id), name: s.owner.name, phone: s.owner.phone } : null,
        autoAccept: s.autoAccept,
        isOpen: s.isOpen,
        isActive: s.isActive,
        activeLoad: s.activeLoad,
      })),
    });
  }
);

/**
 * Open a stall and hand it to a shopkeeper.
 *
 * The owner must already hold the `shopkeeper` role — this route deliberately
 * cannot promote anyone, because role assignment lives behind
 * PATCH /api/users/:id/role and should stay in one place.
 */
router.post(
  '/:id/stalls',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        stallNumber: fields.nonEmptyString(24),
        name: fields.nonEmptyString(160),
        ownerId: fields.objectId,
        autoAccept: z.boolean().optional(),
        contactPhone: z.string().trim().max(20).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const market = await Market.findById(req.valid.params.id);
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    const User = require('../models/User');
    const owner = await User.findOne({ _id: req.valid.body.ownerId, status: 'active' });
    if (!owner) throw new ApiError(404, 'That account does not exist.', 'NOT_FOUND');
    if (owner.role !== 'shopkeeper') {
      throw new ApiError(
        409,
        'A stall can only be given to a shopkeeper account. Change the role first.',
        'ROLE_REQUIRED'
      );
    }

    const stall = await Stall.create({
      market: market._id,
      stallNumber: req.valid.body.stallNumber,
      name: req.valid.body.name,
      owner: owner._id,
      autoAccept: req.valid.body.autoAccept ?? false,
      contactPhone: req.valid.body.contactPhone || '',
    });

    return res.status(201).json({ data: stall.toJSON() });
  }
);

module.exports = router;
