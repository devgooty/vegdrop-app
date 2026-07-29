'use strict';

const express = require('express');
const Product = require('../models/Product');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');

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
      })
      .strict(),
  }),
  async (req, res) => {
    const { categoryId, search, limit } = req.valid.query;

    const filter = { isActive: true };
    if (categoryId !== undefined) filter.categoryId = categoryId;
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
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ stock: z.number().int().min(0).max(1_000_000) }).strict(),
  }),
  async (req, res) => {
    const updated = await Product.findByIdAndUpdate(
      req.valid.params.id,
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
      pricePaise: price,
      oldPricePaise: oldPrice ?? null,
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

    const updated = await Product.findByIdAndUpdate(
      req.valid.params.id,
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
