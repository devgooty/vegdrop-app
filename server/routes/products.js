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

/** Roles that administer the whole catalog rather than their own listings. */
const CATALOG_ADMINS = ['market_owner', 'developer'];

/**
 * Load a product the caller is allowed to write to.
 *
 * Holding `shopkeeper` says you may list produce, not that you may edit
 * everyone else's. Every write below routed through `findByIdAndUpdate` on a
 * bare id, so any vendor who cleared KYC could reprice a competitor's line to
 * zero, drop its stock, or deactivate it outright — and self-registration means
 * clearing KYC is something a stranger can do unaided.
 *
 * Ownership is checked before the write rather than after, for the reason
 * routes/markets.js gives about market edits: `findByIdAndUpdate` would have
 * already applied the change by the time we noticed it was not theirs.
 *
 * 403 rather than the 404 used for order lookups. The catalog is public — GET
 * /api/products already lists every one of these — so hiding existence buys
 * nothing, and "this is not yours" is the actionable message.
 */
async function loadWritableProduct(id, user) {
  const product = await Product.findById(id);
  if (!product) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');

  if (CATALOG_ADMINS.includes(user.role)) return product;

  if (!product.createdBy || String(product.createdBy) !== String(user._id)) {
    throw new ApiError(
      403,
      'This listing belongs to another vendor. You can only change products you added.',
      'NOT_YOUR_PRODUCT'
    );
  }

  return product;
}

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

        /**
         * The listings the caller may actually manage. Mirrors
         * loadWritableProduct below — scoped to `createdBy`, not `owner` — so
         * the shopkeeper panel never shows a row that then 403s on edit.
         *
         * Deliberately excludes the null-`createdBy` shared/seeded catalog: per
         * loadWritableProduct, that stays admin-only, so a shopkeeper's own
         * "mine" list would be lying if it included rows they cannot save.
         *
         * Distinct from `shopId`, which is a public view of one shop's catalog
         * (by `owner`, for browsing) rather than the caller's write scope.
         */
        mine: z.coerce.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { categoryId, search, limit, shopId, mine } = req.valid.query;

    const filter = { isActive: true };
    if (categoryId !== undefined) filter.categoryId = categoryId;
    if (shopId !== undefined) filter.owner = shopId;
    if (search) {
      // Escape regex metacharacters: an unescaped user string is a ReDoS vector.
      filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    /**
     * `mine` needs a session; without one it would silently widen to the whole
     * catalog, which is the opposite of what the caller asked for.
     */
    const scopedToCaller = Boolean(mine) && Boolean(req.user);
    if (scopedToCaller && req.user.role === 'shopkeeper') {
      filter.createdBy = req.user._id;
    }

    const products = await Product.find(filter).sort({ categoryId: 1, name: 1 }).limit(limit);

    if (scopedToCaller) {
      // Identity-scoped: two shopkeepers get different lists from the same URL,
      // so this must never reach a shared cache. Falls back to the API-wide
      // no-store default.
      res.set('Cache-Control', 'no-store');
    } else {
      // The catalog is identical for every visitor, so it is safe to cache in
      // shared caches and CDNs. Kept short because stock moves; stale-while-
      // revalidate lets a returning client paint instantly from cache while a
      // fresh copy is fetched in the background.
      // Express's ETag then turns most of these into a 304 with no body at all.
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    }

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
    const product = await loadWritableProduct(req.valid.params.id, req.user);

    const updated = await Product.findByIdAndUpdate(
      product._id,
      { $set: { stock: req.valid.body.stock } },
      { returnDocument: 'after', runValidators: true }
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
        // Optional translations. Empty is allowed and meaningful — it is what
        // makes the client fall back to the English name for this one product
        // rather than showing a blank label.
        nameTe: z.string().trim().max(200).optional(),
        nameHi: z.string().trim().max(200).optional(),
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
      // Stamped from the session, never the body — .strict() rejects an attempt
      // to supply it, and this is what every later write is checked against.
      createdBy: req.user._id,
    });
    return res.status(201).json({ data: product.toJSON() });
  }
);

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
        // Settable to '' on purpose, which is how a wrong translation gets
        // withdrawn — the row falls back to English instead of being stuck with
        // it until someone edits the database by hand.
        nameTe: z.string().trim().max(200).optional(),
        nameHi: z.string().trim().max(200).optional(),
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

    const product = await loadWritableProduct(req.valid.params.id, req.user);

    const updated = await Product.findByIdAndUpdate(
      product._id,
      { $set: update },
      { returnDocument: 'after', runValidators: true }
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
      { returnDocument: 'after' }
    );
    if (!updated) throw new ApiError(404, 'Product not found.', 'NOT_FOUND');
    return res.status(204).end();
  }
);

module.exports = router;
