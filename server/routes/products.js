'use strict';

const express = require('express');
const Product = require('../models/Product');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { requireVerifiedVendor } = require('../middleware/vendorVerified');

const router = express.Router();

/** Roles permitted to change the catalog. */
const CATALOG_MANAGERS = ['shopkeeper', 'market_owner', 'developer'];

/**
 * Prices are stored and validated in integer paise. The API accepts rupees at
 * the boundary and converts once, so no float ever reaches persistence.
 */
const rupeesToPaise = z
  .number()
  .nonnegative()
  .max(1_000_000)
  .transform((rupees) => Math.round(rupees * 100));

// Reading the catalog is public; authentication only enriches the response.
router.get(
  '/',
  optionalAuth,
  validate({
    query: z
      .object({
        categoryId: z.coerce.number().int().optional(),
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        /**
         * One independent shop's own catalog. Omit it and the response is the
         * whole catalog exactly as before, which is what the market and legacy
         * paths still read.
         */
        shopId: fields.objectId.optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { categoryId, search, limit, shopId } = req.valid.query;

    const filter = { isActive: true };
    if (categoryId !== undefined) filter.categoryId = categoryId;
    if (shopId !== undefined) filter.owner = shopId;
    if (search) {
      // Escape regex metacharacters: an unescaped user string is a ReDoS vector.
      filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const products = await Product.find(filter).sort({ categoryId: 1, name: 1 }).limit(limit);

    // The catalog is identical for every visitor, so it is safe to cache in
    // shared caches and CDNs. Kept short because stock moves; stale-while-
    // revalidate lets a returning client paint instantly from cache while a
    // fresh copy is fetched in the background.
    // Express's ETag then turns most of these into a 304 with no body at all.
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');

    return res.json({ data: products.map((p) => p.toJSON()) });
  }
);

router.get(
  '/:id',
  optionalAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const product = await Product.findOne({ _id: req.valid.params.id, isActive: true });
    if (!product) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');
    return res.json({ data: product.toJSON() });
  }
);

router.patch(
  '/:id/stock',
  requireAuth,
  requireRole(CATALOG_MANAGERS),
  // A shopkeeper must have a verified settlement account before listing or
  // repricing anything. No-op for market_owner/developer, who do not sell.
  requireVerifiedVendor,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ stock: z.number().int().min(0).max(1_000_000) }).strict(),
  }),
  async (req, res) => {
    const updated = await Product.findOneAndUpdate(
      writableProductFilter(req.valid.params.id, req.user),
      { $set: { stock: req.valid.body.stock } },
      { new: true, runValidators: true }
    );
    if (!updated) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');
    return res.json({ data: updated.toJSON() });
  }
);

router.post(
  '/',
  requireAuth,
  requireRole(CATALOG_MANAGERS),
  // A shopkeeper must have a verified settlement account before listing or
  // repricing anything. No-op for market_owner/developer, who do not sell.
  requireVerifiedVendor,
  validate({
    body: z
      .object({
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
    const { price, oldPrice, ...rest } = req.valid.body;
    const product = await Product.create({
      ...rest,
      /**
       * A shopkeeper's listing belongs to their own shop; a market_owner or
       * developer is curating the shared platform catalog, which markets sell
       * from, so theirs stays unowned. Read from the authenticated session, never
       * from the body.
       */
      owner: req.user.role === 'shopkeeper' ? req.user._id : null,
      pricePaise: price,
      oldPricePaise: oldPrice ?? null,
    });
    return res.status(201).json({ data: product.toJSON() });
  }
);

/**
 * Restrict a write to the listings this caller may touch.
 *
 * Until per-shop catalogs existed, every verified vendor could edit and restock
 * every product in the system, because nothing recorded who added one. Once one
 * shopkeeper's listings are distinguishable from another's, that is a live hole:
 * a competitor could reprice or zero the stock on someone else's shop.
 *
 * A shopkeeper may write two kinds of row:
 *   - their own (`owner` is them), and
 *   - the shared platform catalog (`owner` null, which also matches the rows
 *     that predate this field).
 *
 * The second is not an oversight. The legacy single-shop flow — one flat
 * catalog, one implicit shop — is what the currently deployed app runs on, and
 * managing that catalog's stock is the shopkeeper panel's whole job today.
 * Excluding it would log every existing vendor out of their own inventory.
 *
 * market_owner and developer keep curating everything.
 *
 * Expressed as a query filter rather than a load-then-compare so the ownership
 * test and the write stay one atomic operation. A non-match then 404s through
 * the existing not-found path, which is also right on the merits: a vendor has
 * no business learning that another shop's product id exists.
 */
function writableProductFilter(id, user) {
  if (user.role !== 'shopkeeper') return { _id: id };
  return { _id: id, $or: [{ owner: null }, { owner: user._id }] };
}

router.patch(
  '/:id',
  requireAuth,
  requireRole(CATALOG_MANAGERS),
  // A shopkeeper must have a verified settlement account before listing or
  // repricing anything. No-op for market_owner/developer, who do not sell.
  requireVerifiedVendor,
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

    const updated = await Product.findOneAndUpdate(
      writableProductFilter(req.valid.params.id, req.user),
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!updated) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');
    return res.json({ data: updated.toJSON() });
  }
);

// Soft delete: hard-deleting a product orphans the order history that references it.
router.delete(
  '/:id',
  requireAuth,
  requireRole('market_owner', 'developer'),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const updated = await Product.findByIdAndUpdate(
      req.valid.params.id,
      { $set: { isActive: false } },
      { new: true }
    );
    if (!updated) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');
    return res.status(204).end();
  }
);

module.exports = router;
