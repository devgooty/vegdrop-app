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
     * Where this stall is in the market owner's approval queue.
     *
     * A shopkeeper asks to join a market (`pending`); the owner of that market
     * accepts (`approved`) or turns them down (`rejected`). Only an approved
     * stall trades.
     *
     * `isActive` is held false while pending or rejected, which is belt and
     * braces rather than redundancy: every fulfilment query already filters on
     * `isActive`, so a pending stall is invisible to sourcing even from a code
     * path written before this field existed. The explicit `status: 'approved'`
     * filter added to those queries states the intent, and stops a market owner
     * flipping `isActive` back on from quietly promoting an unapproved stall.
     */
    status: {
      type: String,
      required: true,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },

    requestedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    /** Which market owner decided, kept so a disputed rejection has an author. */
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Shown to the shopkeeper, so a rejection is actionable rather than silent. */
    rejectionReason: { type: String, default: '', maxlength: 300 },

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

/**
 * Two stalls in one market cannot share a number — the rider would not know
 * which door to knock on.
 *
 * Restricted to approved stalls. A shopkeeper proposes a number when they
 * apply, and two applicants guessing the same wrong number must not collide
 * before a human has looked at either; the market owner is the one who knows
 * which pitches are actually free, and fixes the number at approval. A
 * rejected request must not reserve a number forever either.
 */
stallSchema.index(
  { market: 1, stallNumber: 1 },
  { unique: true, partialFilterExpression: { status: 'approved' } }
);

/**
 * One shopkeeper, one stall — but only counting live applications.
 *
 * This was `{ unique: true, sparse: true }`, which predates rejection: it would
 * have let a single refusal bar a shopkeeper from ever applying to another
 * market, since the rejected row would keep occupying their one slot. Limiting
 * uniqueness to pending and approved stalls means a rejection frees them to
 * apply elsewhere while still preventing applications to two markets at once.
 */
stallSchema.index(
  { owner: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } }
);

// The broadcast query: every open stall in this market, cheapest-loaded first.
stallSchema.index({ market: 1, isActive: 1, isOpen: 1, activeLoad: 1 });
// The market owner's approval queue.
stallSchema.index({ market: 1, status: 1, requestedAt: -1 });

stallSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

module.exports = mongoose.model('Stall', stallSchema);
