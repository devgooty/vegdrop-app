'use strict';

const mongoose = require('mongoose');
const config = require('../config/env');

/**
 * A photograph of what one stall is actually holding, right now.
 *
 * The catalog image is a stock photo of the idea of a tomato. This is the
 * tomatoes. A shopkeeper takes it on their phone while declaring stock, and it
 * is optional — a stall that never takes one simply shows the catalog image, as
 * before.
 *
 * WHY THIS IS NOT A FIELD ON StallInventory
 *
 * It is keyed identically — one row per stall per product — so a field there
 * would be the obvious home for it. But `planRound` in services/sourcing.js
 * aggregates over StallInventory on EVERY sourcing round: `$match` on
 * market/product/stock, `$lookup` to Stall, and only then `$project`. The
 * projection is the last stage, so Mongo reads whole documents through the ones
 * before it. Fifty kilobytes of image per row would be dragged through the hot
 * path of every order placed in the market and then thrown away.
 *
 * Kept in its own collection, the sourcing engine cannot touch it by accident —
 * which is a structural guarantee rather than a comment asking future callers
 * to remember.
 */
const stallPhotoSchema = new mongoose.Schema(
  {
    stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', required: true, index: true },
    /** Denormalised from the stall, so the customer-facing lookup needs no join. */
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    /**
     * Base64 payload only — the `data:image/jpeg;base64,` prefix is stripped on
     * the way in and rebuilt on the way out.
     *
     * Storing the bytes in Mongo rather than object storage is a deliberate
     * starting point: it needs no third-party account and no credentials, and
     * the images are capped small enough that a document stays far inside the
     * 16 MB limit. Moving to S3 later changes the upload and serve routes only,
     * because everything else already refers to the photo by URL.
     */
    image: { type: String, required: true },

    /**
     * Restricted at the route to jpeg and webp. Never SVG — an SVG is a script
     * container, and this one is served back to customers.
     */
    mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/webp'] },

    /** Decoded size, so the cap can be reported without re-decoding. */
    bytes: { type: Number, required: true, min: 1 },

    takenAt: { type: Date, required: true, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/** One current photo per stall per product; a new one replaces it. */
stallPhotoSchema.index({ stall: 1, product: 1 }, { unique: true });

/** "The newest photo of this product anywhere in this market." */
stallPhotoSchema.index({ market: 1, product: 1, takenAt: -1 });

/**
 * Photos delete themselves.
 *
 * A photograph nobody has refreshed for a week is not evidence of anything, and
 * this is the one collection here that grows in megabytes rather than bytes.
 * Note that the display window (`freshForHours`, a day) is much shorter than
 * this: a stale photo stops being SHOWN long before it is removed, so a
 * shopkeeper who re-photographs on day three overwrites rather than re-creates.
 */
stallPhotoSchema.index(
  { takenAt: 1 },
  { expireAfterSeconds: config.freshPhoto.retentionDays * 24 * 60 * 60 }
);

stallPhotoSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/** `data:image/jpeg;base64,…`, the form an <img src> wants. */
stallPhotoSchema.virtual('dataUri').get(function dataUri() {
  return `data:${this.mimeType};base64,${this.image}`;
});

module.exports = mongoose.model('StallPhoto', stallPhotoSchema);
