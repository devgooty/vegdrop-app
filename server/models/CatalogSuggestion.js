'use strict';

const mongoose = require('mongoose');

/**
 * A shopkeeper's ask to promote one of their unlinked listings into the shared
 * platform catalog.
 *
 * The listing stays shop-owned forever. Accept creates a *new* owner:null Product
 * from a snapshot taken at submit time, then points the listing's catalogItem
 * at it — clearing owner on the listing would steal a live for-sale row into
 * the platform catalog (see docs/superpowers/specs/2026-09-12-catalog-search-add-design.md).
 */
const STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);

const catalogSuggestionSchema = new mongoose.Schema(
  {
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    shopkeeper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /** Snapshot at submit — later listing edits must not rewrite a pending review. */
    name: { type: String, required: true, trim: true, maxlength: 200 },
    image: { type: String, default: '', maxlength: 2000 },
    weight: { type: String, default: '', maxlength: 60 },
    status: {
      type: String,
      enum: STATUSES,
      default: 'pending',
      required: true,
      index: true,
    },
    rejectReason: { type: String, default: null, maxlength: 300 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    sharedProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    /**
     * Markets where this shopkeeper holds an approved stall, denormalised at
     * submit so a market owner's queue is a simple marketIds $in filter.
     */
    marketIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Market' }],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

catalogSuggestionSchema.index(
  { listing: 1 },
  {
    unique: true,
    name: 'listing_pending_unique',
    partialFilterExpression: { status: 'pending' },
  }
);
catalogSuggestionSchema.index({ status: 1, createdAt: -1 });
catalogSuggestionSchema.index({ shopkeeper: 1, createdAt: -1 });
catalogSuggestionSchema.index({ marketIds: 1, status: 1 });

catalogSuggestionSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

module.exports = mongoose.model('CatalogSuggestion', catalogSuggestionSchema);
module.exports.STATUSES = STATUSES;
