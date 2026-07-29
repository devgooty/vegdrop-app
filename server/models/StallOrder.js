'use strict';

const mongoose = require('mongoose');

/**
 * One stall's share of a customer order.
 *
 * A basket assembled across a market splits into one StallOrder per stall. Each
 * vendor sees and acts on only their own slice; none of them can see the others'
 * prices or move the parent order.
 *
 * The parent Order is confirmed only when every StallOrder here is `accepted`.
 * A single `rejected` — or a single `respondByAt` elapsing — fails the whole
 * order. That is the customer's stated rule, and it is enforced in
 * services/fulfilment.js rather than anywhere a client can reach.
 */

const STALL_ORDER_STATUSES = Object.freeze([
  'awaiting',   // sent to the vendor, clock running
  'accepted',   // vendor has the stock and will pack it
  'rejected',   // vendor declined, or the deadline passed
  'packed',     // ready on the counter for the rider
  'picked_up',  // rider has collected it
  'cancelled',  // parent order died for a reason other than this stall
]);

const STALL_ORDER_TRANSITIONS = Object.freeze({
  awaiting: ['accepted', 'rejected', 'cancelled'],
  accepted: ['packed', 'cancelled'],
  packed: ['picked_up', 'cancelled'],
  picked_up: [],
  rejected: [],
  cancelled: [],
});

const stallOrderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Snapshot at purchase time so later catalog edits cannot rewrite history.
    name: { type: String, required: true },
    unitPricePaise: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 999 },
    lineTotalPaise: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const stallOrderSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    orderNumber: { type: String, required: true, index: true },

    stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', required: true, index: true },
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true, index: true },

    // Denormalized so the rider's pickup list and the vendor's queue render
    // without a join, and so the record survives a stall being renamed.
    stallNumber: { type: String, required: true },
    stallName: { type: String, required: true },

    items: {
      type: [stallOrderItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0 && items.length <= 100,
        message: 'A stall order must contain between 1 and 100 items.',
      },
    },

    subtotalPaise: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      required: true,
      enum: STALL_ORDER_STATUSES,
      default: 'awaiting',
      index: true,
    },

    /**
     * The acceptance deadline. Indexed because the sweeper queries
     * {status: 'awaiting', respondByAt: {$lte: now}} on a timer.
     */
    respondByAt: { type: Date, required: true, index: true },

    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 300 },
    /** True when the deadline expired rather than the vendor actively declining. */
    autoRejected: { type: Boolean, default: false },

    packedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },

    /**
     * Proves the rider physically collected from this stall. Stored hashed for
     * the same reason a password is: a leaked database should not let anyone
     * mark a pickup they did not make.
     */
    pickupCodeHash: { type: String, default: null, select: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

// The vendor's queue: "my stall, awaiting, oldest first".
stallOrderSchema.index({ stall: 1, status: 1, createdAt: -1 });
// One row per stall per order.
stallOrderSchema.index({ order: 1, stall: 1 }, { unique: true });

stallOrderSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
stallOrderSchema.virtual('subtotal').get(function subtotal() {
  return this.subtotalPaise / 100;
});

stallOrderSchema.statics.canTransition = function canTransition(from, to) {
  return Boolean(STALL_ORDER_TRANSITIONS[from]?.includes(to));
};

const StallOrder = mongoose.model('StallOrder', stallOrderSchema);

module.exports = StallOrder;
module.exports.STALL_ORDER_STATUSES = STALL_ORDER_STATUSES;
module.exports.STALL_ORDER_TRANSITIONS = STALL_ORDER_TRANSITIONS;
