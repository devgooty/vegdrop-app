'use strict';

const mongoose = require('mongoose');

/**
 * A server-recorded intent to collect a specific amount from a specific user.
 *
 * This exists so payment verification has an authoritative amount to compare
 * against. Without it, a client could create a ₹1 Razorpay order and then submit
 * the verification with `amount: 100000`, since the signature only proves that
 * an order id and payment id belong together — not how much was actually paid.
 */
const paymentIntentSchema = new mongoose.Schema(
  {
    razorpayOrderId: { type: String, required: true, unique: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'amountPaise must be an integer.' },
    },
    currency: { type: String, required: true, default: 'INR' },

    purpose: { type: String, required: true, enum: ['wallet_topup'], default: 'wallet_topup' },

    status: {
      type: String,
      required: true,
      enum: ['created', 'paid', 'failed', 'expired'],
      default: 'created',
      index: true,
    },

    razorpayPaymentId: { type: String, default: null, index: true },
    settledAt: { type: Date, default: null },

    // Development-only marker: mock intents can never be settled in production.
    isMock: { type: Boolean, default: false },

    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

paymentIntentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('PaymentIntent', paymentIntentSchema);
