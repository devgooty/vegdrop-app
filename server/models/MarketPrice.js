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

    /**
     * When the owner last STOOD BEHIND this price — not when it last moved.
     *
     * The distinction is the whole of the daily workflow, and it cannot be
     * derived from anything already here. `updatedAt` answers "when did this
     * number last change", which on a normal trading day is "three weeks ago"
     * for most of the sheet, because most prices hold. An owner who opens the
     * app, reads down the list and confirms that today's onion price is
     * yesterday's onion price has done the day's work; a screen keyed on
     * `updatedAt` would still show every one of those lines as stale and give
     * them no way to clear it but to type the same number back in.
     *
     * Nor can the client simply resubmit the whole sheet to bump `updatedAt`:
     * it deliberately sends only dirty rows (see PricesTab), and making it send
     * all of them would rewrite `updatedBy` on lines nobody touched — the exact
     * thing the comment there warns against — while telling MarketPriceHistory
     * nothing, since the history only records real changes.
     *
     * So: `updatedAt` is the price's history, `confirmedAt` is the owner's
     * attention. A save stamps both; a confirm stamps only this one.
     */
    confirmedAt: { type: Date, default: null },

    /** Who last confirmed it, which is often not who last changed it. */
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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

/**
 * "How much of this sheet has been looked at today?" — the count behind the
 * owner's daily banner, answered without scanning the market's whole sheet.
 *
 * A new key shape rather than an alteration of either index above, so
 * `createIndexes` simply adds it and no migration is involved. Scoping the
 * existing unique {market, product} index by day instead — the tempting way to
 * model "one price per day" — WOULD be an options change on a live index, which
 * MongoDB answers with IndexKeySpecsConflict and then ignores, leaving the old
 * constraint silently in force. That failure mode is why the daily fact is a
 * timestamp on the row rather than a day in its key.
 */
marketPriceSchema.index({ market: 1, confirmedAt: -1 });

marketPriceSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
marketPriceSchema.virtual('price').get(function price() {
  return this.pricePaise / 100;
});

module.exports = mongoose.model('MarketPrice', marketPriceSchema);
