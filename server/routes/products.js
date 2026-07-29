'use strict';

const express = require('express');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { resolveOwnedStall } = require('../services/stallAccess');

const router = express.Router();

/** Roles permitted to change the catalog at all. Ownership is checked separately. */
const CATALOG_MANAGERS = ['shopkeeper', 'market_owner', 'developer'];
/** Roles that may write to any stall's catalog. */
const OPERATOR_ROLES = ['market_owner', 'developer'];

/**
 * Prices are stored and validated in integer paise. The API accepts rupees at
 * the boundary and converts once, so no float ever reaches persistence.
 */
const rupeesToPaise = z
  .number()
  .nonnegative()
  .max(1_000_000)
  .transform((rupees) => Math.round(rupees * 100));

/**
 * Resolve the stall a write applies to.
 *
 * A shopkeeper always writes to their own stall — the id comes from their user
 * record, never from the request. Operators must name a stall explicitly, which
 * keeps a market-wide role from editing a random stall by omission.
 */
async function resolveWriteStall(user, stallId) {
  if (OPERATOR_ROLES.includes(user.role)) {
    if (!stallId) {
      throw new ApiError(400, 'stallId is required when acting as an operator.', 'STALL_REQUIRED');
    }
    const stall = await Stall.findById(stallId);
    if (!stall) throw new ApiError(404, 'Stall not found.', 'NOT_FOUND');
    return stall;
  }
  return resolveOwnedStall(user);
}

/**
 * Load a product for modification, enforcing that the caller owns its stall.
 * 404 rather than 403 so another vendor's product ids are not probeable.
 */
async function loadOwnedProduct(user, productId) {
  const product = await Product.findById(productId);
  if (!product) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');

  if (OPERATOR_ROLES.includes(user.role)) return product;

  const stall = await Stall.findOne({ _id: product.stall, owner: user._id }).select('_id').lean();
  if (!stall) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');

  return product;
}

// Reading the catalog is public; authentication only enriches the response.
router.get(
  '/',
  optionalAuth,
  validate({
    query: z
      .object({
        marketId: fields.objectId.optional(),
        stallId: fields.objectId.optional(),
        categoryId: z.coerce.number().int().optional(),
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .strict(),
  }),
  async (req, res) => {
    const { marketId, stallId, categoryId, search, limit } = req.valid.query;

    const filter = { isActive: true };
    if (marketId) filter.market = marketId;
    if (stallId) filter.stall = stallId;
    if (categoryId !== undefined) filter.categoryId = categoryId;
    if (search) {
      // Escape regex metacharacters: an unescaped user string is a ReDoS vector.
      filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const products = await Product.find(filter)
      .populate('stall', 'stallNumber name isOpen isActive')
      .sort({ categoryId: 1, name: 1 })
      .limit(limit);

    /**
     * A listing from a closed stall is shown but flagged, so the customer can see
     * that the item exists here without being able to build a basket that is
     * guaranteed to be rejected at acceptance time.
     */
    const data = products.map((p) => {
      const json = p.toJSON();
      json.available = Boolean(p.stall?.isActive && p.stall?.isOpen) && p.stock > 0;
      return json;
    });

    // The catalog is identical for every visitor, so it is safe to cache in
    // shared caches and CDNs. Kept short because stock moves; stale-while-
    // revalidate lets a returning client paint instantly from cache while a
    // fresh copy is fetched in the background.
    // Express's ETag then turns most of these into a 304 with no body at all.
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');

    return res.json({ data });
  }
);

/** The signed-in shopkeeper's own listings, including deactivated ones. */
router.get(
  '/mine',
  requireAuth,
  requireRole('shopkeeper', 'developer'),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).strict() }),
  async (req, res) => {
    const stall = await resolveOwnedStall(req.user);
    const products = await Product.find({ stall: stall._id })
      .sort({ categoryId: 1, name: 1 })
      .limit(req.valid.query.limit);
    return res.json({ data: products.map((p) => p.toJSON()), stall: stall.toJSON() });
  }
);

router.get(
  '/:id',
  optionalAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const product = await Product.findOne({ _id: req.valid.params.id, isActive: true })
      .populate('stall', 'stallNumber name isOpen isActive')
      .populate('market', 'name slug');
    if (!product) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');
    return res.json({ data: product.toJSON() });
  }
);

router.patch(
  '/:id/stock',
  requireAuth,
  requireRole(CATALOG_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ stock: z.number().int().min(0).max(1_000_000) }).strict(),
  }),
  async (req, res) => {
    const product = await loadOwnedProduct(req.user, req.valid.params.id);
    product.stock = req.valid.body.stock;
    await product.save();
    return res.json({ data: product.toJSON() });
  }
);

router.post(
  '/',
  requireAuth,
  requireRole(CATALOG_MANAGERS),
  validate({
    body: z
      .object({
        // Operators name the target stall; shopkeepers may not, since theirs is
        // derived from their account.
        stallId: fields.objectId.optional(),
        sku: fields.nonEmptyString(60),
        categoryId: z.number().int(),
        name: fields.nonEmptyString(200),
        weight: z.string().trim().max(60).optional(),
        price: rupeesToPaise,
        oldPrice: rupeesToPaise.optional(),
        image: z.string().trim().url().max(2000).optional(),
        isOrganic: z.boolean().optional(),
        stock: z.number().int().min(0).max(1_000_000),
      })
      .strict(),
  }),
  async (req, res) => {
    const { price, oldPrice, stallId, ...rest } = req.valid.body;

    const stall = await resolveWriteStall(req.user, stallId);

    const product = await Product.create({
      ...rest,
      stall: stall._id,
      market: stall.market,
      pricePaise: price,
      oldPricePaise: oldPrice ?? null,
    }).catch((err) => {
      if (err?.code === 11000) {
        throw new ApiError(409, 'This stall already lists that SKU.', 'DUPLICATE_SKU');
      }
      throw err;
    });

    return res.status(201).json({ data: product.toJSON() });
  }
);

router.patch(
  '/:id',
  requireAuth,
  requireRole(CATALOG_MANAGERS),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        name: fields.nonEmptyString(200).optional(),
        weight: z.string().trim().max(60).optional(),
        price: rupeesToPaise.optional(),
        oldPrice: rupeesToPaise.nullable().optional(),
        image: z.string().trim().url().max(2000).optional(),
        isOrganic: z.boolean().optional(),
        stock: z.number().int().min(0).max(1_000_000).optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { price, oldPrice, ...rest } = req.valid.body;

    const update = { ...rest };
    if (price !== undefined) update.pricePaise = price;
    if (oldPrice !== undefined) update.oldPricePaise = oldPrice;

    if (Object.keys(update).length === 0) {
      throw new ApiError(400, 'No fields to update.', 'VALIDATION_ERROR');
    }

    const product = await loadOwnedProduct(req.user, req.valid.params.id);
    product.set(update);
    await product.save();

    return res.json({ data: product.toJSON() });
  }
);

// Soft delete: hard-deleting a product orphans the order history that references it.
router.delete(
  '/:id',
  requireAuth,
  requireRole(CATALOG_MANAGERS),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const product = await loadOwnedProduct(req.user, req.valid.params.id);
    product.isActive = false;
    await product.save();
    return res.status(204).end();
  }
);

module.exports = router;
