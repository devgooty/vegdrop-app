'use strict';

const mongoose = require('mongoose');
const geoPointSchema = require('./geoPoint');
const { FULFILLMENT_STATUSES } = require('../utils/orderStatus');

const ORDER_STATUSES = Object.freeze([
  'Pending',
  'Preparing',
  'Out for Delivery',
  'Delivered',
  'Cancelled',
]);

/**
 * Legal status transitions. Enforced server-side so a client cannot jump an
 * order straight to Delivered, or resurrect a cancelled one.
 *
 * This governs the COARSE status only, and applies to legacy (marketless)
 * orders. A market order's coarse status is derived from `fulfillment.status`
 * (see utils/orderStatus.js) and is never pushed directly — routes/orders.js
 * refuses a manual status change on an order that has a market.
 */
const STATUS_TRANSITIONS = Object.freeze({
  Pending: ['Preparing', 'Cancelled'],
  Preparing: ['Out for Delivery', 'Cancelled'],
  'Out for Delivery': ['Delivered', 'Cancelled'],
  Delivered: [],
  Cancelled: [],
});

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Snapshot of catalog state at purchase time, so later price edits do not
    // rewrite historical orders.
    name: { type: String, required: true },
    unitPricePaise: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 999 },
    lineTotalPaise: { type: Number, required: true, min: 0 },

    /**
     * Stable handle for this line, so a stall can say "I'll take these two"
     * without relying on array position. Array indices shift; ids do not.
     *
     * Only set on market orders. Legacy orders leave it null and nothing looks
     * at it.
     */
    lineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /**
     * What the CURRENT sourcing market charges for this line.
     *
     * Distinct from `unitPricePaise`, which is what the customer agreed to pay
     * and is frozen at checkout. When an order hops to a second market this is
     * rewritten from that market's price sheet and `unitPricePaise` is not —
     * otherwise the stalls in market B would be shown market A's prices and
     * could not reconcile them against their own sheet.
     *
     * The gap between the two is platform margin, bounded by
     * `marketplace.hopPriceToleranceBps`.
     */
    sourcePricePaise: { type: Number, default: null, min: 0 },

    /**
     * Which stall committed to this line.
     *
     * EVERY PATH HERE MUST BE DECLARED. Mongoose strict mode silently discards
     * a `$set` key it cannot resolve against the schema — no error, no write,
     * and `findOneAndUpdate` still returns a document. An undeclared `claim`
     * would make the entire claim race a successful no-op, which is exactly the
     * kind of bug that only shows up under load in production.
     */
    claim: {
      stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', default: null },
      // Denormalised so the rider's pickup list needs no join, and so the number
      // stays correct in history even if the stall is later renumbered.
      stallNumber: { type: String, default: null },
      claimedAt: { type: Date, default: null },
      // True when auto-accept took it rather than a person tapping accept.
      auto: { type: Boolean, default: false },
      packedAt: { type: Date, default: null },
      collectedAt: { type: Date, default: null },
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    customerName: { type: String, required: true, maxlength: 120 },
    phone: { type: String, required: true, maxlength: 20 },
    address: { type: String, required: true, maxlength: 500 },

    /**
     * Where the order is going, as a point.
     *
     * `address` is a human string a courier can read; this is what "the next
     * nearest market" is measured from when the first market cannot fill the
     * order. Optional — the customer app has had these coordinates in local
     * storage all along and simply never sent them. Without it the hop falls
     * back to searching outward from the current market, which is a reasonable
     * second best.
     */
    deliveryLocation: { type: geoPointSchema, default: undefined },

    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0 && items.length <= 100,
        message: 'An order must contain between 1 and 100 items.',
      },
    },

    // Recomputed server-side from the catalog; never read from the request.
    subtotalPaise: { type: Number, required: true, min: 0 },
    deliveryFeePaise: { type: Number, required: true, min: 0, default: 0 },
    totalAmountPaise: { type: Number, required: true, min: 0 },

    paymentMethod: { type: String, required: true, enum: ['wallet', 'razorpay', 'cod'] },
    paymentStatus: {
      type: String,
      required: true,
      enum: ['pending', 'paid', 'refunded', 'failed'],
      default: 'pending',
      index: true,
    },

    status: { type: String, required: true, enum: ORDER_STATUSES, default: 'Pending', index: true },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /**
     * The market currently sourcing this order.
     *
     * Null means a legacy order: no stalls, no sourcing window, no sweeper. The
     * whole engine below is gated on this being set, which is what lets the
     * existing apps keep working untouched while markets roll out.
     */
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', default: null, index: true },
    marketName: { type: String, default: null, maxlength: 160 },

    /**
     * The independent shop this order was placed with.
     *
     * A User id, because in this model the shop IS the shopkeeper: Stall.market
     * is required, so a shop outside any market cannot be a stall.
     *
     * Mutually exclusive with `market` — an order has one seller. Both null is
     * the legacy marketless order, which every shopkeeper still sees, exactly as
     * before. Note that `{ shop: null }` also matches documents written before
     * this field existed, which is what makes that filter need no backfill.
     */
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    shopName: { type: String, default: null, maxlength: 160 },

    /**
     * Fine-grained fulfillment state. Authoritative for market orders; `status`
     * above is its derived mirror, written in the same atomic update.
     */
    fulfillment: {
      status: { type: String, enum: FULFILLMENT_STATUSES, default: null },

      /** When the current market's stalls run out of time to accept. */
      sourcingDeadline: { type: Date, default: null },

      /** How many markets this order has been offered to, including the current. */
      attempt: { type: Number, default: 0, min: 0 },

      /** Markets already asked, so a hop never loops back to one that said no. */
      triedMarkets: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Market' }],

      /**
       * The moment every line found a taker. This is the cancellation cutoff —
       * past it the stalls have committed produce and the customer cannot walk
       * away.
       */
      lockedAt: { type: Date, default: null },

      /** What we owe the CURRENT market, summed from items[].sourcePricePaise. */
      sourceSubtotalPaise: { type: Number, default: null, min: 0 },

      /**
       * When the stalls' payouts were recorded — NOT when they were paid.
       *
       * Set the moment the customer takes delivery. The money itself is held
       * and released later (see services/settlement.js); this only marks that
       * the obligation exists, so the backfill sweep knows to stop looking at
       * this order.
       */
      settledAt: { type: Date, default: null },

      /** The live rider offer. Cascades to the next nearest on decline or expiry. */
      riderOffer: {
        rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        expiresAt: { type: Date, default: null },
        /** Offers made so far, to stop the cascade running for ever. */
        count: { type: Number, default: 0, min: 0 },
        /** Riders who said no or timed out; never offered to again. */
        declinedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        /** Set once the cascade gives up — any rider may then claim it. */
        openPool: { type: Boolean, default: false },
      },

      /**
       * Fine-grained audit trail. `statusHistory` below stays coarse so nothing
       * that reads it has to change; this carries the detail (which stall took
       * which line, which market was tried, which rider refused).
       *
       * Bounded in practice: a handful of stalls, at most a few hops, and a
       * capped rider cascade.
       */
      events: [
        {
          at: { type: Date, default: Date.now },
          type: { type: String, required: true, maxlength: 40 },
          market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', default: null },
          stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', default: null },
          rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          note: { type: String, default: null, maxlength: 200 },
          _id: false,
        },
      ],
    },

    statusHistory: [
      {
        status: { type: String, enum: ORDER_STATUSES, required: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
/** An independent shop's own order list. */
orderSchema.index({ shop: 1, createdAt: -1 });

/**
 * The sweeper's query, run every few seconds: which sourcing windows have
 * expired? Without this it is a collection scan on every tick.
 */
orderSchema.index({ 'fulfillment.status': 1, 'fulfillment.sourcingDeadline': 1 });
/** The stall broadcast feed: live orders in my market. */
orderSchema.index({ market: 1, 'fulfillment.status': 1 });
/** The rider's pending offer, and the sweeper's offer-expiry query. */
orderSchema.index({ 'fulfillment.riderOffer.rider': 1, 'fulfillment.riderOffer.expiresAt': 1 });
/** Stall-scoped views: my claimed lines, my packing queue. */
orderSchema.index({ 'items.claim.stall': 1, 'fulfillment.status': 1 });
/** The settlement backfill: delivered, but the stalls' payouts never recorded. */
orderSchema.index({ 'fulfillment.status': 1, 'fulfillment.settledAt': 1 });

orderSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
orderSchema.virtual('totalAmount').get(function totalAmount() {
  return this.totalAmountPaise / 100;
});

/** True when this order runs through the market sourcing engine. */
orderSchema.virtual('isMarketOrder').get(function isMarketOrder() {
  return this.market != null;
});

orderSchema.statics.canTransition = function canTransition(from, to) {
  return Boolean(STATUS_TRANSITIONS[from]?.includes(to));
};

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.STATUS_TRANSITIONS = STATUS_TRANSITIONS;
