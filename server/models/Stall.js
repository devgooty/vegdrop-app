'use strict';

const mongoose = require('mongoose');

/**
 * A numbered shop inside a market, run by one shopkeeper.
 *
 * Stalls do not price anything — the market's price sheet does that. A stall's
 * only decisions are whether it is open, whether it answers automatically, and
 * which lines of an offered order it takes.
 */
const stallSchema = new mongoose.Schema(
  {
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true, index: true },

    /**
     * The number painted on the stall. A string, not a number: real markets use
     * "A-12", "7B", "Shed 3/4". The rider reads this off their screen and walks
     * to it, so it must be exactly what is on the sign.
     */
    stallNumber: { type: String, required: true, trim: true, maxlength: 24 },

    name: { type: String, required: true, trim: true, maxlength: 160 },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * Answer offers without a human tapping accept.
     *
     * Only fires where the stall has declared stock for the line (see
     * StallInventory) — that declared stock is exactly the "everything is on my
     * table right now" signal. A stall with auto-accept on and no inventory rows
     * simply never auto-accepts; it can still accept by hand.
     */
    autoAccept: { type: Boolean, default: false },

    isOpen: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },

    /**
     * Lines claimed but not yet collected by a rider — how busy this stall is
     * right now. Used to rank auto-accept candidates so an order lands on the
     * stall with the shortest queue rather than always the same one.
     *
     * Maintained with $inc, never by reading and writing back, so concurrent
     * claims cannot lose a count.
     */
    activeLoad: { type: Number, default: 0, min: 0 },

    contactPhone: { type: String, default: '', maxlength: 20 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

// Two stalls in one market cannot share a number — the rider would not know
// which door to knock on.
stallSchema.index({ market: 1, stallNumber: 1 }, { unique: true });
// One shopkeeper, one stall. Sparse-unique so the constraint does not fire on
// legacy shopkeepers who have no stall yet.
stallSchema.index({ owner: 1 }, { unique: true, sparse: true });
// The broadcast query: every open stall in this market, cheapest-loaded first.
stallSchema.index({ market: 1, isActive: 1, isOpen: 1, activeLoad: 1 });

stallSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

module.exports = mongoose.model('Stall', stallSchema);
