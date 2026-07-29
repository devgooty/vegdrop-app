'use strict';

const mongoose = require('mongoose');

const ORDER_STATUSES = Object.freeze([
  'Awaiting Acceptance', // fanned out to stalls, none have answered yet
  'Confirmed',           // every stall accepted; payment captured
  'Preparing',           // stalls are packing
  'Ready for Pickup',    // all stalls packed, waiting on a rider
  'Out for Delivery',
  'Delivered',
  'Rejected',            // at least one stall declined or timed out
  'Cancelled',
]);

/**
 * Legal status transitions. Enforced server-side so a client cannot jump an
 * order straight to Delivered, or resurrect a cancelled one.
 *
 * `Awaiting Acceptance` is only ever left by services/fulfilment.js, which
 * decides based on the StallOrder rows. No client-facing route moves an order
 * out of that state directly.
 */
const STATUS_TRANSITIONS = Object.freeze({
  'Awaiting Acceptance': ['Confirmed', 'Rejected', 'Cancelled'],
  Confirmed: ['Preparing', 'Cancelled'],
  Preparing: ['Ready for Pickup', 'Out for Delivery', 'Cancelled'],
  'Ready for Pickup': ['Out for Delivery', 'Cancelled'],
  'Out for Delivery': ['Delivered', 'Cancelled'],
  Delivered: [],
  Rejected: [],
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
     * Delivery pin, used to route the rider and to rank fallback markets.
     * `type` has no default deliberately — see the pre-validate hook below.
     */
    deliveryLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },

    /**
     * A basket is locked to one market. Mixing markets would mean a rider
     * criss-crossing the city for one order, so checkout rejects it outright.
     */
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true, index: true },

    /** Denormalized counters so "are we there yet?" is not an aggregation. */
    stallOrderCount: { type: Number, required: true, min: 1 },
    acceptedCount: { type: Number, default: 0, min: 0 },

    /** Populated when the order fails, to explain it and drive the retry UI. */
    rejectionReason: { type: String, default: null, maxlength: 300 },
    rejectedByStall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', default: null },

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
      // `held` is the acceptance-phase state: the customer's funds are committed
      // but not yet earned, and are released in full if any stall declines.
      enum: ['pending', 'held', 'paid', 'refunded', 'failed'],
      default: 'pending',
      index: true,
    },

    status: {
      type: String,
      required: true,
      enum: ORDER_STATUSES,
      default: 'Awaiting Acceptance',
      index: true,
    },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

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
orderSchema.index({ market: 1, status: 1, createdAt: -1 });

orderSchema.virtual('stallOrders', {
  ref: 'StallOrder',
  localField: '_id',
  foreignField: 'order',
});

/**
 * Store no `deliveryLocation` rather than a `{ type: 'Point' }` with no
 * coordinates: partial GeoJSON is not indexable, and a customer who never shared
 * a pin should simply have no point at all.
 */
orderSchema.pre('validate', function dropEmptyLocation() {
  const coordinates = this.deliveryLocation?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    this.deliveryLocation = undefined;
  } else if (!this.deliveryLocation.type) {
    this.deliveryLocation.type = 'Point';
  }
});

orderSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
orderSchema.virtual('totalAmount').get(function totalAmount() {
  return this.totalAmountPaise / 100;
});

orderSchema.statics.canTransition = function canTransition(from, to) {
  return Boolean(STATUS_TRANSITIONS[from]?.includes(to));
};

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.STATUS_TRANSITIONS = STATUS_TRANSITIONS;
