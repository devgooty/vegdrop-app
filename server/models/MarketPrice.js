'use strict';

const mongoose = require('mongoose');

/**
 * One price per product per market — the market owner sets it, and every stall
 * in the market sells at it.
 *
 * This is the customer-facing catalog for a market and the single source of
 * price truth. `Product.pricePaise` remains the platform-wide default used when
 * an order is placed without a market.
 *
 * Deliberately its own collection rather than an array on Market: a market
 * carries hundreds of lines, each edited independently by the owner, and an
 * embedded array would make every price tweak rewrite the whole document.
 */
const marketPriceSchema = new mongoose.Schema(
  {
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    // Integer paise, like every other amount on the server.
    pricePaise: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'pricePaise must be an integer.' },
    },

    /**
     * Whether this market is selling the product at all today.
     *
     * Distinct from stall stock: this is the market saying "no okra this week",
     * which takes it off the customer's list and disqualifies the market as a
     * hop target for any order containing it.
     */
    isAvailable: { type: Boolean, default: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

// One row per product per market. The unique index is what makes a price sheet
// upsert (see routes/markets.js) safe against two owners editing at once.
marketPriceSchema.index({ market: 1, product: 1 }, { unique: true });
// Covers "does this market price and stock every line of this order?", the
// question asked on every hop.
marketPriceSchema.index({ market: 1, isAvailable: 1, product: 1 });

marketPriceSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
marketPriceSchema.virtual('price').get(function price() {
  return this.pricePaise / 100;
});

module.exports = mongoose.model('MarketPrice', marketPriceSchema);
