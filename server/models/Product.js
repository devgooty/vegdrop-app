'use strict';

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    /**
     * A SKU is unique within a stall, not globally: two vendors in the same
     * market both sell VEG-TOMATO-1000, at their own prices and stock levels.
     * See the compound index below.
     */
    sku: { type: String, required: true, index: true, trim: true },

    /** The owning stall. Every catalog write is authorized through this. */
    stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', required: true, index: true },
    /**
     * Denormalized from the stall so browsing a market's catalog is a single
     * indexed read rather than a join across every stall in it. Kept in step by
     * routes/products.js, which always derives it from the stall.
     */
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true, index: true },

    categoryId: { type: Number, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    weight: { type: String, default: '', maxlength: 60 },

    // Integer paise. This is the authoritative price; clients never supply it.
    pricePaise: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'pricePaise must be an integer.' },
    },
    oldPricePaise: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (v) => v === null || Number.isInteger(v),
        message: 'oldPricePaise must be an integer or null.',
      },
    },

    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviews: { type: Number, default: 0, min: 0 },
    image: { type: String, default: '', maxlength: 2000 },
    isOrganic: { type: Boolean, default: false },

    stock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'stock must be an integer.' },
    },

    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

// One listing per SKU per stall; the same SKU may exist in every other stall.
productSchema.index({ stall: 1, sku: 1 }, { unique: true });
// Drives the customer-facing "everything on sale in this market" query.
productSchema.index({ market: 1, isActive: 1, categoryId: 1 });

productSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/** Rupee views for presentation. Persistence stays in paise. */
productSchema.virtual('price').get(function price() {
  return this.pricePaise / 100;
});
productSchema.virtual('oldPrice').get(function oldPrice() {
  return this.oldPricePaise === null ? null : this.oldPricePaise / 100;
});

module.exports = mongoose.model('Product', productSchema);
