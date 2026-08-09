'use strict';

const express = require('express');
const mongoose = require('mongoose');
const config = require('../config/env');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const MarketPriceHistory = require('../models/MarketPriceHistory');
const StallPhoto = require('../models/StallPhoto');
const Stall = require('../models/Stall');
const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const StallEarning = require('../models/StallEarning');
const notify = require('../services/notify');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');

const router = express.Router();

/** Only a market owner (or a developer) shapes a market and its price sheet. */
const MARKET_MANAGERS = ['market_owner', 'developer'];

/**
 * The oldest a produce photograph may be and still be shown as "today's".
 *
 * Photos are retained for a week but only DISPLAYED for a day. Presenting a
 * four-day-old picture as evidence of what is on the table would be worse than
 * showing the stock image, which at least does not claim to be current.
 */
function freshPhotoCutoff() {
  return new Date(Date.now() - config.freshPhoto.freshForHours * 60 * 60 * 1000);
}

/**
 * Holding `market_owner` says you run *a* market, not that you run *this* one.
 *
 * Every management route below was gated on the role alone, which was adequate
 * only while the role meant "administrator" and markets had no owner. It no
 * longer is: without this check any market owner could rewrite a competitor's
 * price sheet, read their stall list, or approve traders into their market.
 *
 * `developer` passes through, as it does everywhere else. An unowned market —
 * one created before Market.owner existed — is administrable by developers
 * only, deliberately: nobody has claimed it, so nobody but staff may speak for
 * it, and silently letting the first market owner to find it take over would be
 * worse than requiring someone to assign it.
 */
function assertManagesMarket(market, user) {
  if (user.role === 'developer') return;

  if (!market.owner || String(market.owner) !== String(user._id)) {
    throw new ApiError(403, 'This market is not yours to manage.', 'NOT_YOUR_MARKET');
  }
}

/** Load a market by id or 404 — every management route starts this way. */
async function loadManagedMarket(id, user) {
  const market = await Market.findById(id);
  if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');
  assertManagesMarket(market, user);
  return market;
}

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
 * Every market a shopkeeper could apply to.
 *
 * Distinct from /nearby, which needs coordinates: a shopkeeper is choosing the
 * market they physically trade at and already knows which one that is, so
 * making them share a location to find it by name is a worse question. Only
 * active markets, and only the fields needed to recognise one — a price sheet
 * is a trading secret and is not on offer to someone who has not joined.
 */
router.get('/', requireAuth, requireRole('shopkeeper', ...MARKET_MANAGERS), async (_req, res) => {
  const markets = await Market.find({ isActive: true }).sort({ name: 1 }).lean();
  return res.json({ data: markets.map(publicMarket) });
});

/**
 * The markets the caller runs.
 *
 * The market owner's dashboard opens on this: without it the client has no way
 * to learn which market is theirs, and every other owner route needs the id.
 */
router.get('/mine', requireAuth, requireRole(MARKET_MANAGERS), async (req, res) => {
  const filter = req.user.role === 'developer' ? {} : { owner: req.user._id };
  const markets = await Market.find(filter).sort({ name: 1 }).lean();

  // The pending count is what the dashboard badges, so it is returned with the
  // market rather than making the client fan out a request per market to find
  // out whether there is anything to do.
  const counts = await Stall.aggregate([
    { $match: { market: { $in: markets.map((m) => m._id) }, status: 'pending' } },
    { $group: { _id: '$market', pending: { $sum: 1 } } },
  ]);
  const pendingByMarket = new Map(counts.map((c) => [String(c._id), c.pending]));

  return res.json({
    data: markets.map((m) => ({
      ...publicMarket(m),
      slug: m.slug,
      isActive: m.isActive,
      /**
       * The owner's own settings, which `publicMarket` deliberately withholds
       * from the shopkeeper-facing list.
       *
       * Returned here rather than leaving the dashboard to fetch GET /:id per
       * market: that route filters on `isActive: true`, so an owner who closed
       * their market down could no longer read it back — and therefore could
       * never turn it on again from a settings screen. Their own market is not
       * something to hide from them.
       *
       * `.lean()` skips the lat/lng virtuals, so they are read straight off the
       * GeoJSON pair — which is [lng, lat], in that order.
       */
      serviceRadiusMeters: m.serviceRadiusMeters,
      contactPhone: m.contactPhone || '',
      lat: m.location?.coordinates?.[1] ?? null,
      lng: m.location?.coordinates?.[0] ?? null,
      pendingRequests: pendingByMarket.get(String(m._id)) || 0,
    })),
  });
});

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

    const [sheet, products, freshPhotos] = await Promise.all([
      MarketPrice.find({ market: id, isAvailable: true }).select('product pricePaise').lean(),
      Product.find(productFilter).select('name weight image isOrganic rating reviews categoryId').lean(),
      /**
       * When each product was last photographed by a stall in this market.
       *
       * Newest wins: several stalls may hold the same product, and the most
       * recent photograph is the best evidence of what is on the tables today.
       *
       * Only the TIMESTAMP is read here — `image` is excluded, and that is the
       * whole reason this is viable. A catalog is up to 200 products; inlining
       * even small photos would be a multi-megabyte response on a mobile
       * connection. The bytes are fetched one at a time from the route below,
       * where the browser caches them like any other image.
       */
      StallPhoto.aggregate([
        {
          $match: {
            market: new mongoose.Types.ObjectId(String(id)),
            takenAt: { $gte: freshPhotoCutoff() },
          },
        },
        { $sort: { takenAt: -1 } },
        { $group: { _id: '$product', takenAt: { $first: '$takenAt' } } },
      ]),
    ]);

    const priceByProduct = new Map(sheet.map((row) => [String(row.product), row.pricePaise]));
    const photoByProduct = new Map(freshPhotos.map((row) => [String(row._id), row.takenAt]));

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
        /**
         * When a stall here last photographed the real thing, or null. The
         * client points an <img> at /products/:id/fresh-photo when it is set.
         */
        freshPhotoAt: photoByProduct.get(String(p._id)) || null,
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

/**
 * What this market has charged lately.
 *
 * Public, like the catalog it belongs to: a shopper deciding whether to buy
 * today or wait is exactly who this is for, and they may not have an account.
 *
 * WHAT A SERIES DOES AND DOES NOT CONTAIN
 *
 * A point exists only where the price actually changed, so a line that has held
 * steady for a month returns a single point. The client draws the step between
 * points rather than interpolating — the price was that number for the whole
 * interval, not drifting towards the next one.
 *
 * A product with no points has genuinely never been repriced since history
 * started being kept. That is reported as an empty series rather than filled
 * in, because a plausible-looking invented line is what this replaced.
 */
router.get(
  '/:id/price-history',
  optionalAuth,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    query: z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        // Narrow to specific lines; omitted means the whole sheet.
        productIds: z.string().trim().max(2000).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { days, productIds } = req.valid.query;

    const market = await Market.findOne({ _id: id, isActive: true }).select('_id').lean();
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const filter = { market: market._id, at: { $gte: since } };

    if (productIds) {
      const ids = productIds
        .split(',')
        .map((value) => value.trim())
        .filter((value) => /^[0-9a-fA-F]{24}$/.test(value));
      if (ids.length === 0) return res.json({ data: { windowDays: days, since, series: {} } });
      filter.product = { $in: ids.map((value) => new mongoose.Types.ObjectId(value)) };
    }

    const rows = await MarketPriceHistory.find(filter)
      .select('product pricePaise isAvailable at')
      .sort({ at: 1 })
      .limit(5000)
      .lean();

    /**
     * The price in force when the window opened.
     *
     * Without it a chart starts at the first change inside the window, so a
     * product repriced once on day 28 would appear to have had no price for
     * four weeks. One extra point per product, carried at the window's start.
     */
    const opening = await MarketPriceHistory.aggregate([
      { $match: { ...filter, at: { $lt: since } } },
      { $sort: { at: 1 } },
      {
        $group: {
          _id: '$product',
          pricePaise: { $last: '$pricePaise' },
          isAvailable: { $last: '$isAvailable' },
        },
      },
    ]);

    const series = {};
    for (const row of opening) {
      series[String(row._id)] = [
        { at: since, pricePaise: row.pricePaise, isAvailable: row.isAvailable, carried: true },
      ];
    }
    for (const row of rows) {
      const key = String(row.product);
      if (!series[key]) series[key] = [];
      series[key].push({
        at: row.at,
        pricePaise: row.pricePaise,
        isAvailable: row.isAvailable,
      });
    }

    // Same caching as the catalog: identical for every visitor, short-lived
    // because a market can reprice at any moment.
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json({ data: { windowDays: days, since, series } });
  }
);

/**
 * The photograph itself — actual image bytes, not JSON.
 *
 * Served as its own resource rather than inlined in the catalog above so the
 * browser caches and lazy-loads it like any other image, and so a catalog of
 * 200 products stays a small JSON response instead of a multi-megabyte one.
 *
 * Public, matching the catalog: a visitor can browse a market before creating
 * an account, and a photo of a crate of tomatoes identifies nobody. The stall
 * that took it is deliberately not named in the response — which stall you are
 * buying from is decided later by the cascade, and naming one here would imply
 * a choice the customer has not made.
 */
router.get(
  '/:id/products/:productId/fresh-photo',
  validate({
    params: z.object({ id: fields.objectId, productId: fields.objectId }).strict(),
  }),
  async (req, res) => {
    const { id, productId } = req.valid.params;

    const photo = await StallPhoto.findOne({
      market: id,
      product: productId,
      takenAt: { $gte: freshPhotoCutoff() },
    })
      .sort({ takenAt: -1 })
      .lean();

    // 404 rather than a placeholder: an <img> that fails simply falls back to
    // whatever the page already had, and a stale photo must not be served.
    if (!photo) throw new ApiError(404, 'No recent photo for that product.', 'NOT_FOUND');

    const buffer = Buffer.from(photo.image, 'base64');

    /**
     * `/api` is Cache-Control: no-store by default because nearly every
     * response is identity-scoped, and this opts out explicitly — the same way
     * the catalog above does. Long-lived because the content at this URL only
     * changes when a shopkeeper takes a new photograph, and `must-revalidate`
     * keeps a client from showing yesterday's after the freshness window.
     */
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.set('Content-Type', photo.mimeType);
    res.set('Content-Length', String(buffer.length));
    // The bytes came from a shopkeeper's phone; refuse to let a browser guess
    // any other type for them.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Last-Modified', new Date(photo.takenAt).toUTCString());

    return res.send(buffer);
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
        /**
         * Staff creating a market on someone's behalf. Ignored for a market
         * owner, who always gets themselves — otherwise the field would be a
         * way to plant a market under another operator's account.
         */
        ownerId: fields.objectId.optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { lat, lng, ownerId, ...rest } = req.valid.body;

    // Whoever creates a market runs it. Without this the creator could not
    // manage what they had just made: assertManagesMarket compares against
    // `owner`, and a market created with none is developer-only forever.
    const owner = req.user.role === 'market_owner' ? req.user._id : ownerId ?? null;

    const market = await Market.create({
      ...rest,
      owner,
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

    // Ownership is checked before the write, not after: findByIdAndUpdate would
    // otherwise have already applied a competitor's edit by the time we noticed.
    await loadManagedMarket(req.valid.params.id, req.user);

    const market = await Market.findByIdAndUpdate(
      req.valid.params.id,
      { $set: update },
      { returnDocument: 'after', runValidators: true }
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
    await loadManagedMarket(req.valid.params.id, req.user);

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

    const market = await loadManagedMarket(id, req.user);

    const productIds = prices.map((p) => p.productId);
    const known = await Product.countDocuments({ _id: { $in: productIds }, isActive: true });
    if (known !== new Set(productIds.map(String)).size) {
      throw new ApiError(400, 'One or more products do not exist.', 'PRODUCT_UNAVAILABLE');
    }

    /**
     * Read the sheet before writing it, so the history can record changes only.
     *
     * The alternative — a history row per save — would draw a flat line densely
     * dotted with re-affirmations of the same number every time the owner
     * touched an unrelated line, because this endpoint takes the batch. That
     * reads as volatility that never happened, which is the exact failure the
     * history exists to stop.
     */
    const existing = await MarketPrice.find({
      market: market._id,
      product: { $in: productIds },
    })
      .select('product pricePaise isAvailable')
      .lean();

    const before = new Map(existing.map((row) => [String(row.product), row]));

    const changed = prices.filter((row) => {
      const previous = before.get(String(row.productId));
      // A line that was not on the sheet at all is a change: it is its first price.
      if (!previous) return true;
      return (
        previous.pricePaise !== row.price ||
        previous.isAvailable !== (row.isAvailable ?? true)
      );
    });

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

    /**
     * Recorded after the sheet is written and deliberately not awaited for
     * success: the price is already live, and losing a chart point must never
     * fail a price change the market has committed to. Same reasoning as the
     * notices elsewhere in this file.
     */
    if (changed.length > 0) {
      const at = new Date();
      MarketPriceHistory.insertMany(
        changed.map((row) => ({
          market: market._id,
          product: row.productId,
          pricePaise: row.price,
          isAvailable: row.isAvailable ?? true,
          changedBy: req.user._id,
          at,
        })),
        { ordered: false }
      ).catch((err) => {
        console.warn(`[markets] price history for ${market.name} not recorded: ${err.message}`);
      });
    }

    return res.json({ data: { updated: prices.length, changed: changed.length } });
  }
);

/** One trader in the market owner's roster. */
function asStallRow(stall) {
  return {
    id: String(stall._id),
    stallNumber: stall.stallNumber,
    name: stall.name,
    owner: stall.owner
      ? { id: String(stall.owner._id), name: stall.owner.name, phone: stall.owner.phone || null }
      : null,
    autoAccept: stall.autoAccept,
    isOpen: stall.isOpen,
    isActive: stall.isActive,
    activeLoad: stall.activeLoad,
  };
}

/** The stalls in a market — who is trading, and how busy each of them is. */
router.get(
  '/:id/stalls',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    await loadManagedMarket(req.valid.params.id, req.user);

    // Approved only. The pending ones are a different question — "who wants in"
    // rather than "who is trading" — and are served by /stall-requests, so a
    // trader list cannot be misread as including people nobody has accepted.
    const stalls = await Stall.find({ market: req.valid.params.id, status: 'approved' })
      .populate('owner', 'name phone pendingPhone')
      .sort({ stallNumber: 1 })
      .lean();

    return res.json({ data: stalls.map(asStallRow) });
  }
);

/**
 * Suspend a trader, or move them to a different pitch.
 *
 * Accepting an application was a one-way door until this existed: a market owner
 * could let somebody in and then had no way to put them out again, which makes
 * approval a decision nobody can afford to get wrong. Suspension is the
 * counterpart to approval and belongs to the same person.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * `isOpen` and `autoAccept` are the trader's own controls, changed through
 * PATCH /api/stalls/me. A shutter is a statement about whether that shopkeeper
 * is behind the counter right now, and a market owner reaching over to answer
 * that question for them would make the field mean two different things
 * depending on who last wrote it. Suspension says something the market owner
 * genuinely knows — "you are not trading here" — and stops sourcing outright,
 * which is the actual remedy.
 *
 * `isActive: false` is what makes it bite: every sourcing query filters on it,
 * so a suspended stall is offered nothing. Lines it already holds are left
 * alone on purpose — the customer is owed those goods, and cancelling them from
 * here would strand a paid order rather than resolve it.
 */
router.patch(
  '/:id/stalls/:stallId',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId, stallId: fields.objectId }).strict(),
    body: z
      .object({
        isActive: z.boolean().optional(),
        stallNumber: fields.nonEmptyString(24).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    await loadManagedMarket(req.valid.params.id, req.user);

    const { isActive, stallNumber } = req.valid.body;
    if (isActive === undefined && stallNumber === undefined) {
      throw new ApiError(400, 'No fields to update.', 'VALIDATION_ERROR');
    }

    // Matched on market as well as id, for the reason the approve route gives:
    // quoting somebody else's stall id must not reach into their market.
    const stall = await Stall.findOne({
      _id: req.valid.params.stallId,
      market: req.valid.params.id,
      status: 'approved',
    }).populate('owner', 'name phone email');
    if (!stall) throw new ApiError(404, 'No trading stall with that id.', 'NOT_FOUND');

    const wasActive = stall.isActive;
    if (isActive !== undefined) stall.isActive = isActive;
    if (stallNumber !== undefined) stall.stallNumber = stallNumber;

    try {
      await stall.save();
    } catch (err) {
      // Same clash as approval: the number is unique among approved stalls.
      if (err?.code === 11000) {
        throw new ApiError(
          409,
          `Stall ${stallNumber} is already taken in this market.`,
          'STALL_NUMBER_TAKEN'
        );
      }
      throw err;
    }

    /**
     * Tell them, and only when the answer actually changed.
     *
     * Being cut off from orders with no explanation is the kind of thing a
     * trader discovers hours later by noticing an empty screen. Not awaited for
     * success — the suspension is already in force, and a mail server having a
     * bad minute must not undo it.
     */
    if (isActive !== undefined && isActive !== wasActive && stall.owner?.email) {
      const firstName = String(stall.owner.name || '').split(/\s+/)[0] || 'there';
      await notify.sendNotice({
        to: stall.owner.email,
        subject: isActive ? 'Your stall is trading again' : 'Your stall has been suspended',
        text: isActive
          ? `Hi ${firstName},\n\nYour stall is active again and will start receiving orders.\n\n— VegDrop`
          : `Hi ${firstName},\n\nYour stall has been suspended by the market and will not be offered new orders.\n` +
            'Anything you have already accepted still needs to be packed.\n\n' +
            'Speak to the market office if this is unexpected.\n\n— VegDrop',
      });
    }

    return res.json({ data: asStallRow(stall.toObject()) });
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
    const market = await loadManagedMarket(req.valid.params.id, req.user);

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
      // A stall the market owner opens themselves needs no approval: the
      // decision and the act are the same one. The request flow exists for the
      // other direction, where a shopkeeper asks to come in.
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: req.user._id,
    });

    return res.status(201).json({ data: stall.toJSON() });
  }
);

// ---------------------------------------------------------------------------
// Joining a market
//
// A shopkeeper asks; the market owner decides. The alternative already here —
// POST /:id/stalls — needs the market owner to know the applicant's user id,
// which is not something one trader can discover about another, so in practice
// it only works for people already known off-platform. This is the direction
// that scales: the shopkeeper introduces themselves.
// ---------------------------------------------------------------------------

/** What a shopkeeper is allowed to know about a market before joining it. */
function publicMarket(market) {
  return {
    id: String(market._id),
    name: market.name,
    address: market.address,
    isOpen: market.isOpen,
  };
}

/** One row in the market owner's approval queue. */
function asRequest(stall) {
  return {
    id: String(stall._id),
    status: stall.status,
    /**
     * Approved is not the same as trading.
     *
     * A market owner can suspend an accepted stall, which leaves `status` at
     * `approved` while the stall is switched off. Reported explicitly rather
     * than left to be inferred from "approved but /stalls/me refused me",
     * which is the kind of deduction that goes wrong the first time anything
     * else can produce the same symptom.
     */
    isActive: stall.isActive,
    proposedStallNumber: stall.stallNumber,
    name: stall.name,
    requestedAt: stall.requestedAt,
    reviewedAt: stall.reviewedAt,
    rejectionReason: stall.rejectionReason || null,
    /**
     * `unverifiedPhone` is reported separately, never merged into `phone`.
     *
     * Registration parks a number it could not deliver a code to in
     * `pendingPhone` rather than `phone` (see completeRegistration), so an
     * applicant who signed up while the phone channel was unavailable has no
     * verified number at all. A market owner still needs a way to reach them —
     * vetting a stranger is the entire point of this step — but presenting an
     * unproven number as a confirmed one would misrepresent what the platform
     * actually knows.
     */
    applicant: stall.owner
      ? {
          id: String(stall.owner._id),
          name: stall.owner.name,
          phone: stall.owner.phone || null,
          unverifiedPhone: stall.owner.phone ? null : stall.owner.pendingPhone || null,
        }
      : null,
  };
}

/**
 * Ask to trade in a market.
 *
 * Creates the stall already, in `pending`. Holding the request in a separate
 * collection and copying it into a Stall on approval would mean two places that
 * both describe a stall and can disagree; one row that changes state cannot.
 * `pending` stalls are held inactive and filtered out of sourcing, so an
 * unapproved row is inert rather than merely unadvertised.
 */
router.post(
  '/:id/join',
  requireAuth,
  requireRole('shopkeeper'),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        /** What the shopkeeper trades as. Defaults to their own name. */
        name: fields.nonEmptyString(160).optional(),
        /**
         * The number on their pitch, if they have one. A proposal only — the
         * market owner sets the real one when accepting, because they are the
         * one who knows what is free.
         */
        stallNumber: fields.nonEmptyString(24).optional(),
        contactPhone: z.string().trim().max(20).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const market = await Market.findOne({ _id: req.valid.params.id, isActive: true });
    if (!market) throw new ApiError(404, 'Market not found.', 'NOT_FOUND');

    /**
     * One live application at a time, checked before writing.
     *
     * The partial unique index on `owner` is the real guarantee — two requests
     * racing will collide there whatever this reads. This exists to turn that
     * collision into a sentence that says which market they are already waiting
     * on, rather than a duplicate-key error.
     */
    const existing = await Stall.findOne({
      owner: req.user._id,
      status: { $in: ['pending', 'approved'] },
    }).lean();

    if (existing) {
      const sameMarket = String(existing.market) === String(market._id);
      throw new ApiError(
        409,
        existing.status === 'pending'
          ? sameMarket
            ? 'You have already asked to join this market. The owner has not decided yet.'
            : 'You are already waiting on another market. Withdraw that request before applying here.'
          : 'You already run a stall. Leave it before joining another market.',
        'ALREADY_APPLIED',
        { marketId: String(existing.market), status: existing.status }
      );
    }

    let stall;
    try {
      stall = await Stall.create({
        market: market._id,
        // A placeholder number rather than a blank: stallNumber is required, and
        // uniqueness is only enforced among approved stalls, so an unreviewed
        // guess cannot collide with a real pitch.
        stallNumber: req.valid.body.stallNumber || 'TBD',
        name: req.valid.body.name || req.user.name,
        owner: req.user._id,
        contactPhone: req.valid.body.contactPhone || req.user.phone || '',
        status: 'pending',
        // Held inactive until someone accepts. Every sourcing query filters on
        // isActive, so this is what makes a pending stall inert rather than
        // merely unlisted.
        isActive: false,
        requestedAt: new Date(),
      });
    } catch (err) {
      // The index caught a request that arrived between the read above and here.
      if (err?.code === 11000) {
        throw new ApiError(409, 'You already have a request in progress.', 'ALREADY_APPLIED');
      }
      throw err;
    }

    /**
     * Tell the market owner somebody is waiting.
     *
     * Deliberately after the write and deliberately not awaited for success:
     * the request is already recorded and visible in their queue, so a mail
     * provider having a bad minute must not fail the shopkeeper's application.
     * sendNotice swallows its own failures for this reason.
     */
    if (market.owner) {
      const owner = await User.findById(market.owner).select('name email').lean();
      if (owner?.email) {
        await notify.sendNotice({
          to: owner.email,
          subject: `New stall request for ${market.name}`,
          text:
            `Hi ${String(owner.name || '').split(/\s+/)[0] || 'there'},\n\n` +
            `${req.user.name} has asked to trade at ${market.name}.\n\n` +
            `Open the market owner panel to see the request and accept or decline it.\n\n` +
            '— VegDrop',
        });
      }
    }

    return res.status(201).json({ data: asRequest({ ...stall.toObject(), owner: req.user }) });
  }
);

/** Withdraw an application that has not been decided yet. */
router.delete('/me/join', requireAuth, requireRole('shopkeeper'), async (req, res) => {
  const stall = await Stall.findOne({ owner: req.user._id, status: 'pending' });
  if (!stall) throw new ApiError(404, 'You have no request waiting.', 'NOT_FOUND');

  // Deleted rather than marked rejected: a withdrawal is the applicant's own
  // decision and leaving it in the owner's history as a refusal misreports who
  // decided what.
  await stall.deleteOne();
  return res.status(204).end();
});

/** Where the caller's own application stands. */
router.get('/me/join', requireAuth, requireRole('shopkeeper'), async (req, res) => {
  const stall = await Stall.findOne({ owner: req.user._id })
    .sort({ requestedAt: -1 })
    .populate('market', 'name address')
    .lean();

  if (!stall) return res.json({ data: null });

  return res.json({
    data: {
      ...asRequest({ ...stall, owner: req.user }),
      market: stall.market
        ? { id: String(stall.market._id), name: stall.market.name, address: stall.market.address }
        : null,
    },
  });
});

/** The approval queue for one market. */
router.get(
  '/:id/stall-requests',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    query: z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).strict(),
  }),
  async (req, res) => {
    await loadManagedMarket(req.valid.params.id, req.user);

    const requests = await Stall.find({
      market: req.valid.params.id,
      status: req.valid.query.status || 'pending',
    })
      .populate('owner', 'name phone pendingPhone')
      .sort({ requestedAt: -1 })
      .lean();

    return res.json({ data: requests.map(asRequest) });
  }
);

/**
 * Accept an application.
 *
 * The stall number is settled here rather than at request time: the market
 * owner knows which pitches are free, and uniqueness is only enforced among
 * approved stalls, so this is the first moment the number has to be real.
 */
router.post(
  '/:id/stall-requests/:stallId/approve',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId, stallId: fields.objectId }).strict(),
    body: z
      .object({
        stallNumber: fields.nonEmptyString(24),
        autoAccept: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    await loadManagedMarket(req.valid.params.id, req.user);

    // Matched on market as well as id so a market owner cannot approve a
    // request belonging to somebody else's market by quoting its id.
    const stall = await Stall.findOne({
      _id: req.valid.params.stallId,
      market: req.valid.params.id,
      status: 'pending',
    });
    if (!stall) throw new ApiError(404, 'No pending request with that id.', 'NOT_FOUND');

    // Re-read the role now rather than trusting it from application time: a
    // shopkeeper demoted while waiting must not be activated as a trader.
    const applicant = await User.findOne({ _id: stall.owner, status: 'active' })
      .select('role name email')
      .lean();
    if (!applicant || applicant.role !== 'shopkeeper') {
      throw new ApiError(
        409,
        'That account is no longer an active shopkeeper.',
        'ROLE_REQUIRED'
      );
    }

    stall.stallNumber = req.valid.body.stallNumber;
    stall.autoAccept = req.valid.body.autoAccept ?? false;
    stall.status = 'approved';
    stall.isActive = true;
    stall.reviewedAt = new Date();
    stall.reviewedBy = req.user._id;
    stall.rejectionReason = '';

    try {
      await stall.save();
    } catch (err) {
      // The stall number is unique among approved stalls, so this is the first
      // point it can clash — with a pitch that is already trading.
      if (err?.code === 11000) {
        throw new ApiError(
          409,
          `Stall ${req.valid.body.stallNumber} is already taken in this market.`,
          'STALL_NUMBER_TAKEN'
        );
      }
      throw err;
    }

    if (applicant.email) {
      await notify.sendNotice({
        to: applicant.email,
        subject: 'Your stall has been approved',
        text:
          `Hi ${String(applicant.name || '').split(/\s+/)[0] || 'there'},\n\n` +
          `You have been accepted as stall ${stall.stallNumber}.\n\n` +
          'You can now sign in to the shopkeeper panel and start taking orders.\n\n' +
          '— VegDrop',
      });
    }

    return res.json({ data: asRequest({ ...stall.toObject(), owner: applicant }) });
  }
);

/** Turn an application down, with a reason the applicant can act on. */
router.post(
  '/:id/stall-requests/:stallId/reject',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId, stallId: fields.objectId }).strict(),
    body: z.object({ reason: z.string().trim().max(300).optional() }).strict(),
  }),
  async (req, res) => {
    await loadManagedMarket(req.valid.params.id, req.user);

    const stall = await Stall.findOne({
      _id: req.valid.params.stallId,
      market: req.valid.params.id,
      status: 'pending',
    });
    if (!stall) throw new ApiError(404, 'No pending request with that id.', 'NOT_FOUND');

    stall.status = 'rejected';
    stall.isActive = false;
    stall.reviewedAt = new Date();
    stall.reviewedBy = req.user._id;
    stall.rejectionReason = req.valid.body.reason || '';
    // Rejected rows leave the partial unique index on `owner`, which is what
    // frees the applicant to try a different market.
    await stall.save();

    const applicant = await User.findById(stall.owner).select('name email').lean();
    if (applicant?.email) {
      await notify.sendNotice({
        to: applicant.email,
        subject: 'About your stall request',
        text:
          `Hi ${String(applicant.name || '').split(/\s+/)[0] || 'there'},\n\n` +
          'Your request to trade at this market was not accepted.\n' +
          (stall.rejectionReason ? `\nReason: ${stall.rejectionReason}\n` : '') +
          '\nYou can apply to a different market from the shopkeeper panel.\n\n' +
          '— VegDrop',
      });
    }

    return res.json({ data: asRequest({ ...stall.toObject(), owner: applicant }) });
  }
);

/**
 * What is happening in a market: who sold what, who delivered it, who is here.
 *
 * WHY THE MONEY COMES FROM StallEarning AND NOT Order
 *
 * An order's total is what the customer agreed to pay. A stall earning is what
 * a specific stall is owed for the lines it actually supplied, written only once
 * the customer has taken delivery. Those differ whenever an order is split
 * across stalls, cancelled after packing, or hops to another market — and it is
 * the second number that answers "how much did this stall sell", which is the
 * question being asked here.
 *
 * Amounts stay in paise, as everywhere else on the server. Rupees are a
 * presentation concern and rounding them here would make the per-stall figures
 * fail to add up to the total.
 */
router.get(
  '/:id/analytics',
  requireAuth,
  requireRole(MARKET_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).strict(),
  }),
  async (req, res) => {
    const market = await loadManagedMarket(req.valid.params.id, req.user);

    const days = req.valid.query.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const marketId = market._id;

    const [sales, deliveries, stallCounts, orderTotals] = await Promise.all([
      /** Sales per stall. Every stall that earned anything in the window. */
      StallEarning.aggregate([
        { $match: { market: marketId, earnedAt: { $gte: since } } },
        {
          $group: {
            _id: '$stall',
            stallNumber: { $first: '$stallNumber' },
            grossPaise: { $sum: '$grossPaise' },
            commissionPaise: { $sum: '$commissionPaise' },
            netPaise: { $sum: '$netPaise' },
            orders: { $sum: 1 },
          },
        },
        { $sort: { grossPaise: -1 } },
        {
          $lookup: {
            from: Stall.collection.collectionName,
            localField: '_id',
            foreignField: '_id',
            as: 'stall',
          },
        },
        { $unwind: { path: '$stall', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: User.collection.collectionName,
            localField: 'stall.owner',
            foreignField: '_id',
            as: 'owner',
          },
        },
        { $unwind: { path: '$owner', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            stallId: '$_id',
            // Falls back to the denormalised copy on the earning: a stall that
            // has since been deleted still sold what it sold.
            stallNumber: { $ifNull: ['$stall.stallNumber', '$stallNumber'] },
            stallName: '$stall.name',
            ownerName: '$owner.name',
            grossPaise: 1,
            commissionPaise: 1,
            netPaise: 1,
            orders: 1,
          },
        },
      ]),

      /**
       * Deliveries per rider.
       *
       * Counted from orders that reached `Delivered`, because an order assigned
       * to a rider who never completed it is not a delivery they made.
       */
      Order.aggregate([
        {
          $match: {
            market: marketId,
            status: 'Delivered',
            assignedTo: { $ne: null },
            createdAt: { $gte: since },
          },
        },
        { $group: { _id: '$assignedTo', deliveries: { $sum: 1 } } },
        { $sort: { deliveries: -1 } },
        {
          $lookup: {
            from: User.collection.collectionName,
            localField: '_id',
            foreignField: '_id',
            as: 'rider',
          },
        },
        { $unwind: { path: '$rider', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            riderId: '$_id',
            name: '$rider.name',
            phone: '$rider.phone',
            deliveries: 1,
          },
        },
      ]),

      /** How many stalls are trading, waiting, or were turned away. */
      Stall.aggregate([
        { $match: { market: marketId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      /**
       * Order counts by status, over the same window.
       *
       * Not derivable from the sales figures above: an order that was cancelled
       * or never sourced produces no stall earning at all, so it would be
       * invisible in a view built only from what was paid out — and "how many
       * did we fail to fill" is exactly what a market owner needs to see.
       */
      Order.aggregate([
        { $match: { market: marketId, createdAt: { $gte: since } } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            valuePaise: { $sum: '$totalAmountPaise' },
          },
        },
      ]),
    ]);

    const byStatus = (rows) =>
      rows.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {});

    return res.json({
      data: {
        market: { id: String(market._id), name: market.name },
        windowDays: days,
        since,

        stalls: {
          approved: byStatus(stallCounts).approved || 0,
          pending: byStatus(stallCounts).pending || 0,
          rejected: byStatus(stallCounts).rejected || 0,
        },

        sales: {
          byStall: sales.map((row) => ({ ...row, stallId: String(row.stallId) })),
          // Summed from the same rows the breakdown shows, so the parts always
          // add to the whole even if a stall is added between two queries.
          grossPaise: sales.reduce((sum, row) => sum + row.grossPaise, 0),
          netPaise: sales.reduce((sum, row) => sum + row.netPaise, 0),
          orders: sales.reduce((sum, row) => sum + row.orders, 0),
        },

        deliveries: {
          byRider: deliveries.map((row) => ({ ...row, riderId: String(row.riderId) })),
          total: deliveries.reduce((sum, row) => sum + row.deliveries, 0),
        },

        orders: orderTotals.reduce(
          (acc, row) => ({ ...acc, [row._id]: { count: row.count, valuePaise: row.valuePaise } }),
          {}
        ),
      },
    });
  }
);

module.exports = router;
