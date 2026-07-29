'use strict';

const mongoose = require('mongoose');

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
