'use strict';

const mongoose = require('mongoose');

/**
 * What a stall has declared it is holding, per product.
 *
 * Only auto-accept needs this. A stall with no rows here can still be offered
 * orders and accept them by hand — the shopkeeper can see their own table, and
 * demanding they key in every crate before they can trade would kill onboarding.
 *
 * Declaring stock is therefore opt-in, and buys exactly one thing: the stall
 * answers instantly instead of waiting for someone to look at the phone.
 */
const stallInventorySchema = new mongoose.Schema(
  {
    stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', required: true, index: true },
    // Denormalised from the stall so the auto-accept candidate query can filter
    // by market without a join.
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    stock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'stock must be an integer.' },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

stallInventorySchema.index({ stall: 1, product: 1 }, { unique: true });
// The auto-accept candidate query: who in this market holds enough of this product?
stallInventorySchema.index({ market: 1, product: 1, stock: 1 });

stallInventorySchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

module.exports = mongoose.model('StallInventory', stallInventorySchema);
