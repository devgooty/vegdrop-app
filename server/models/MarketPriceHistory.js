'use strict';

const mongoose = require('mongoose');

/**
 * What a market charged for a product, and when it changed.
 *
 * WHY THIS EXISTS
 *
 * The customer-facing Price Tracker used to draw a thirty-day chart per product
 * from a random walk generated in the browser — a different chart on every
 * render, showing rises and falls that had never happened. Nothing anywhere
 * recorded a past price: `MarketPrice` holds only today's, and `updatedAt`
 * tells you a change occurred without saying what it was from.
 *
 * A shopper reads a price trend to decide whether to buy now or wait, so the
 * chart had to be either real or gone. This is the record that makes it real.
 *
 * APPEND-ONLY, AND ONLY ON A REAL CHANGE
 *
 * A row is written when a market owner saves a price that DIFFERS from the one
 * already stored — not on every save. The price sheet is edited as a batch, and
 * writing a point per save would draw a flat line densely dotted with
 * re-affirmations of the same number, which reads as volatility that is not
 * there.
 *
 * Rows are never updated or deleted in normal operation. A price history that
 * can be rewritten is not a history.
 */
const marketPriceHistorySchema = new mongoose.Schema(
  {
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    // Integer paise, like every other amount on the server.
    pricePaise: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'pricePaise must be an integer.' },
    },

    /**
     * Whether the line was on sale at this price.
     *
     * Carried so a chart can distinguish "the price held steady" from "the
     * market stopped selling it", which look identical if only the number is
     * kept.
     */
    isAvailable: { type: Boolean, default: true },

    /** Who changed it. Kept for the same reason a rejection records its author. */
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    at: { type: Date, required: true, default: Date.now },
  },
  {
    // `at` is the timestamp that matters and is set explicitly; a second pair of
    // createdAt/updatedAt on an append-only row is noise.
    timestamps: false,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/**
 * The query this exists to serve: one market's series for a set of products
 * over a window, newest last.
 */
marketPriceHistorySchema.index({ market: 1, product: 1, at: 1 });

marketPriceHistorySchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
marketPriceHistorySchema.virtual('price').get(function price() {
  return this.pricePaise / 100;
});

module.exports = mongoose.model('MarketPriceHistory', marketPriceHistorySchema);
