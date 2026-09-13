'use strict';

const mongoose = require('mongoose');

/**
 * One handover of goods, and the six digits that release it.
 *
 * Two stages, and the rider is the one who types both:
 *
 *   pickup   - held by the SELLER. An independent shop holds one per order;
 *              a market order has one per stall, because each stall hands its
 *              own bags over and a single order-wide code would let a rider
 *              who heard it at the first stall tick every other stall off
 *              without walking to them.
 *   delivery - held by the CUSTOMER, one per order, released at the door.
 *
 * THE RULE THE WHOLE FEATURE HANGS ON: whoever SUBMITS a code must never be
 * able to read it. The rider submits both, so no endpoint may ever put a code
 * in front of a `delivery` session. `holder` is the only account a read route
 * will return `code` to, and every read route filters on it.
 *
 * WHY THIS IS ITS OWN COLLECTION AND NOT A FIELD ON `Order`
 *
 * This used to be `Order.pickupCode`, and a code on the order document is one
 * careless projection away from the wrong person. Measured against this
 * codebase, `select: false` on an embedded code is NOT an allowlist:
 * `.select('handover')` returns every code under it, `.select('handover.x')`
 * returns that one, and `aggregate()` ignores `select: false` entirely. Several
 * routes also return a raw `order.toJSON()` straight to the rider
 * (routes/rider.js accept and deliver, routes/orders.js claim). Kept out here,
 * no read of an order - of any shape, by any route, now or later - can carry a
 * code, because there is no code on it to carry.
 *
 * It is also the reason `Order` is left alone: that document is polled every
 * five seconds by three apps, which is the same reason avatars and stall photo
 * bytes live elsewhere.
 *
 * WHY THE CODE IS PLAINTEXT
 *
 * Unlike `OtpChallenge.codeHash`, the holder has to be shown this again - after
 * a reload, on a second device, an hour into packing - and web storage is off
 * limits for it (see CLAUDE.md on the removed `vegdrop_orders` mirror). A hash
 * cannot be displayed. What the hash would have bought against the rider is
 * bought instead by the read routes' `holder` filter, a counted attempt cap and
 * a constant-time compare. What it would have bought against a database dump
 * is not bought: a dump yields every live code for every in-flight order. That
 * is the honest cost of a code a person has to be able to read back, and it is
 * written here so the next reader does not rediscover it as a bug.
 */
const STAGES = Object.freeze(['pickup', 'delivery']);

const orderHandoverSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },

    stage: { type: String, required: true, enum: STAGES },

    /**
     * The market stall releasing its share of the order. Null for an
     * independent shop's pickup and for every delivery.
     *
     * Null is a real value in the unique index below, not an absence: MongoDB
     * indexes it, so "one shop pickup per order" and "one delivery per order"
     * collide on the index exactly as "one pickup per stall" does. That is what
     * makes issuing a code idempotent under two concurrent first reads.
     */
    stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', default: null },

    /** The only account a read route will ever hand `code` to. */
    holder: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * Null once redeemed. A spent code left on a delivered order is one more
     * thing somebody could later mistake for a live one.
     *
     * `select: false` is defence in depth, not the boundary - see above for why
     * it cannot be the boundary. Nothing reads this collection unprojected.
     */
    code: { type: String, default: null, match: /^\d{6}$/, select: false },

    /** Wrong guesses against THIS code. Reset when the holder issues a new one. */
    attempts: { type: Number, default: 0 },

    /**
     * Stamped when `attempts` reaches the cap. A locked code cannot be redeemed
     * by anyone, including with the right digits; only its holder can replace
     * it. Distinct from `code: null`, which means redeemed.
     */
    lockedAt: { type: Date, default: null },

    /** How many codes this handover has had. Starts at 1. */
    issues: { type: Number, default: 1 },

    verifiedAt: { type: Date, default: null },
    /** The rider who typed it. Evidence, not a guard: see services/handover.js. */
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

orderHandoverSchema.index({ order: 1, stage: 1, stall: 1 }, { unique: true });
orderHandoverSchema.index({ holder: 1, order: 1 });

/**
 * Serialised output never carries the code, whatever was selected.
 *
 * Read routes build their response by hand from named fields, so this is the
 * second line rather than the first: it stops a future `res.json(handover)`
 * from quietly becoming the leak this collection exists to prevent.
 */
function stripCode(_doc, ret) {
  delete ret.code;
  delete ret.__v;
  return ret;
}
orderHandoverSchema.set('toJSON', { transform: stripCode });
orderHandoverSchema.set('toObject', { transform: stripCode });

orderHandoverSchema.statics.STAGES = STAGES;

module.exports = mongoose.model('OrderHandover', orderHandoverSchema);
