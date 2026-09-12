'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');

const CatalogSuggestion = require('../models/CatalogSuggestion');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const Market = require('../models/Market');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireVerifiedVendor } = require('../middleware/vendorVerified');
const { validate, fields } = require('../middleware/validate');
const { ApiError } = require('../middleware/errors');
const { withTransaction } = require('../db/connect');

const router = express.Router();

function publicSuggestion(doc) {
  const json = typeof doc.toJSON === 'function' ? doc.toJSON() : { ...doc };
  if (json.shopkeeper && typeof json.shopkeeper === 'object' && json.shopkeeper._id) {
    json.shopkeeper = {
      id: json.shopkeeper._id.toHexString?.() || String(json.shopkeeper._id),
      name: json.shopkeeper.name,
      phone: json.shopkeeper.phone,
    };
  }
  if (json.listing && typeof json.listing === 'object' && json.listing._id) {
    json.listing = json.listing._id.toHexString?.() || String(json.listing._id);
  }
  return json;
}

async function assertCanReview(suggestion, user) {
  if (user.role === 'developer') return;
  if (user.role !== 'market_owner') {
    throw new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN');
  }
  const markets = await Market.find({ owner: user._id }).select('_id').lean();
  const owned = new Set(markets.map((m) => String(m._id)));
  const hit = (suggestion.marketIds || []).some((id) => owned.has(String(id)));
  if (!hit) {
    throw new ApiError(403, 'That suggestion is outside your markets.', 'FORBIDDEN');
  }
}

function sharedSku(name) {
  const slug =
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ITEM';
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CAT-${slug}-${suffix}`;
}

/**
 * POST /api/catalog-suggestions
 * Shopkeeper suggests one of their unlinked listings for the shared catalog.
 */
router.post(
  '/',
  requireAuth,
  requireRole('shopkeeper'),
  requireVerifiedVendor,
  validate({
    body: z.object({ listingId: fields.objectId }).strict(),
  }),
  async (req, res) => {
    const listing = await Product.findById(req.valid.body.listingId);
    if (!listing || !listing.owner || String(listing.owner) !== String(req.user._id)) {
      throw new ApiError(404, 'Listing not found.', 'NOT_FOUND');
    }
    if (listing.catalogItem) {
      throw new ApiError(
        400,
        'That listing is already linked to the shared catalog.',
        'ALREADY_LINKED'
      );
    }

    const stalls = await Stall.find({
      owner: req.user._id,
      status: 'approved',
    })
      .select('market')
      .lean();
    const marketIds = [
      ...new Set(stalls.map((s) => String(s.market))),
    ].map((id) => new mongoose.Types.ObjectId(id));

    try {
      const suggestion = await CatalogSuggestion.create({
        listing: listing._id,
        shopkeeper: req.user._id,
        name: listing.name,
        image: listing.image || '',
        weight: listing.weight || '',
        status: 'pending',
        marketIds,
      });
      return res.status(201).json({ data: publicSuggestion(suggestion) });
    } catch (err) {
      if (err && err.code === 11000) {
        throw new ApiError(
          409,
          'A suggestion is already pending for this listing.',
          'SUGGESTION_PENDING'
        );
      }
      throw err;
    }
  }
);

/**
 * GET /api/catalog-suggestions
 * Shopkeeper: own. Market owner: traders in their markets. Developer: all.
 */
router.get(
  '/',
  requireAuth,
  requireRole('shopkeeper', 'market_owner', 'developer'),
  validate({
    query: z
      .object({
        status: z.enum(['pending', 'accepted', 'rejected']).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const filter = {};
    if (req.valid.query.status) filter.status = req.valid.query.status;

    if (req.user.role === 'shopkeeper') {
      filter.shopkeeper = req.user._id;
    } else if (req.user.role === 'market_owner') {
      const markets = await Market.find({ owner: req.user._id }).select('_id').lean();
      filter.marketIds = { $in: markets.map((m) => m._id) };
    }

    const rows = await CatalogSuggestion.find(filter)
      .populate('shopkeeper', 'name phone')
      .sort({ createdAt: -1 })
      .limit(200);

    return res.json({ data: rows.map(publicSuggestion) });
  }
);

router.post(
  '/:id/accept',
  requireAuth,
  requireRole('market_owner', 'developer'),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ categoryId: z.number().int() }).strict(),
  }),
  async (req, res) => {
    const suggestion = await CatalogSuggestion.findById(req.valid.params.id);
    if (!suggestion) {
      throw new ApiError(404, 'Suggestion not found.', 'NOT_FOUND');
    }
    if (suggestion.status !== 'pending') {
      throw new ApiError(409, 'That suggestion has already been reviewed.', 'ALREADY_REVIEWED');
    }
    await assertCanReview(suggestion, req.user);

    const { categoryId } = req.valid.body;

    const result = await withTransaction(async (session) => {
      const listing = session
        ? await Product.findById(suggestion.listing).session(session)
        : await Product.findById(suggestion.listing);
      if (
        !listing ||
        !listing.owner ||
        String(listing.owner) !== String(suggestion.shopkeeper) ||
        listing.catalogItem
      ) {
        throw new ApiError(
          409,
          'That listing can no longer be linked to a new catalog item.',
          'LISTING_NOT_ELIGIBLE'
        );
      }

      let shared;
      if (session) {
        [shared] = await Product.create(
          [
            {
              sku: sharedSku(suggestion.name),
              owner: null,
              createdBy: req.user._id,
              categoryId,
              name: suggestion.name,
              image: suggestion.image || '',
              weight: suggestion.weight || '',
              pricePaise: 0,
              stock: 0,
              isActive: true,
            },
          ],
          { session }
        );
      } else {
        shared = await Product.create({
          sku: sharedSku(suggestion.name),
          owner: null,
          createdBy: req.user._id,
          categoryId,
          name: suggestion.name,
          image: suggestion.image || '',
          weight: suggestion.weight || '',
          pricePaise: 0,
          stock: 0,
          isActive: true,
        });
      }

      const link = session
        ? await Product.updateOne(
            { _id: listing._id, catalogItem: null },
            { $set: { catalogItem: shared._id } },
            { session }
          )
        : await Product.updateOne(
            { _id: listing._id, catalogItem: null },
            { $set: { catalogItem: shared._id } }
          );
      if (link.modifiedCount !== 1) {
        throw new ApiError(
          409,
          'That listing can no longer be linked to a new catalog item.',
          'LISTING_NOT_ELIGIBLE'
        );
      }

      suggestion.status = 'accepted';
      suggestion.sharedProduct = shared._id;
      suggestion.reviewedBy = req.user._id;
      suggestion.reviewedAt = new Date();
      suggestion.rejectReason = null;
      if (session) await suggestion.save({ session });
      else await suggestion.save();

      return suggestion;
    });

    const populated = await CatalogSuggestion.findById(result._id).populate(
      'shopkeeper',
      'name phone'
    );
    return res.json({ data: publicSuggestion(populated) });
  }
);

router.post(
  '/:id/reject',
  requireAuth,
  requireRole('market_owner', 'developer'),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        reason: z.string().trim().max(300).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const suggestion = await CatalogSuggestion.findById(req.valid.params.id);
    if (!suggestion) {
      throw new ApiError(404, 'Suggestion not found.', 'NOT_FOUND');
    }
    if (suggestion.status !== 'pending') {
      throw new ApiError(409, 'That suggestion has already been reviewed.', 'ALREADY_REVIEWED');
    }
    await assertCanReview(suggestion, req.user);

    suggestion.status = 'rejected';
    suggestion.rejectReason = req.valid.body.reason || null;
    suggestion.reviewedBy = req.user._id;
    suggestion.reviewedAt = new Date();
    await suggestion.save();

    const populated = await CatalogSuggestion.findById(suggestion._id).populate(
      'shopkeeper',
      'name phone'
    );
    return res.json({ data: publicSuggestion(populated) });
  }
);

module.exports = router;
