'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const Order = require('../models/Order');
const StallOrder = require('../models/StallOrder');
const Product = require('../models/Product');
const wallet = require('./wallet');
const { ApiError } = require('../middleware/errors');

/**
 * Order fulfilment across multiple stalls.
 *
 * The rule this implements: **every** stall must accept its slice, or the whole
 * order fails and the customer is offered another market. One vendor declining
 * one item kills the basket.
 *
 * Two consequences drive the design:
 *
 *  1. Money must not be captured at checkout. A wallet payment is taken as a
 *     hold and released in full the moment any stall declines, rather than
 *     captured and then refunded — a refund per rejected order would otherwise be
 *     the common case, not the exception.
 *  2. Stock is claimed at checkout (atomically, so two baskets cannot oversell
 *     the last kilo) and returned on failure. Holding it is the only way to
 *     promise a vendor that the quantity they are accepting is still there.
 *
 * Every state change here is a guarded conditional update. Two vendors accepting
 * the last outstanding slice at the same instant must produce exactly one
 * confirmation, and a reject racing an accept must produce exactly one refund.
 */

/** How long a stall has to answer before the order is auto-rejected. */
const ACCEPTANCE_WINDOW_SECONDS = Number(process.env.STALL_ACCEPT_WINDOW_SECONDS || 180);

/** How often the sweeper looks for elapsed deadlines. */
const SWEEP_INTERVAL_MS = 15_000;

function acceptanceDeadline(from = new Date()) {
  return new Date(from.getTime() + ACCEPTANCE_WINDOW_SECONDS * 1000);
}

// --- Pickup codes ----------------------------------------------------------

function generatePickupCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Hashed with the same pepper as OTPs, and bound to the stall order id so a code
 * seen for one pickup cannot be replayed against another.
 */
function hashPickupCode(stallOrderId, code) {
  return crypto
    .createHmac('sha256', config.otp.pepper)
    .update(`pickup:${stallOrderId}:${code}`)
    .digest('hex');
}

function pickupCodeMatches(stallOrderId, code, storedHash) {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashPickupCode(stallOrderId, String(code)), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// --- Compensation ----------------------------------------------------------

/**
 * Return every claimed unit to the catalog.
 *
 * Best-effort per line: one product having been hard-deleted must not strand the
 * remaining restocks. The order is failed either way — stranded stock is a
 * reconciliation problem, a stuck order is a customer-facing one.
 */
async function restoreStock(order) {
  await Promise.all(
    order.items.map((item) =>
      Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }).catch(() => {})
    )
  );
}

/**
 * Release a wallet hold. Idempotent through the ledger's unique key, so a
 * rejection racing a timeout sweep credits exactly once.
 */
async function releaseHold(order) {
  if (order.paymentMethod !== 'wallet' || order.paymentStatus !== 'held') return;

  await wallet.credit({
    userId: order.customer,
    amountPaise: order.totalAmountPaise,
    reason: 'order_hold_release',
    idempotencyKey: `hold-release:${order._id.toHexString()}`,
    note: `Hold released for ${order.orderNumber}`,
  });
}

// --- Terminal outcomes -----------------------------------------------------

/**
 * Fail the whole order. Safe to call more than once; only the first caller wins
 * the status transition and performs the compensation.
 *
 * @returns {Promise<Order|null>} the failed order, or null if it was already settled
 */
async function failOrder(orderId, { reason, stallId = null }) {
  // Claim the transition. Anything already past acceptance is not ours to fail.
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: 'Awaiting Acceptance' },
    {
      $set: {
        status: 'Rejected',
        rejectionReason: reason,
        rejectedByStall: stallId,
      },
      $push: { statusHistory: { status: 'Rejected', at: new Date(), by: null } },
    },
    { new: true }
  );

  if (!order) return null;

  await restoreStock(order);
  await releaseHold(order);

  if (order.paymentStatus === 'held') {
    order.paymentStatus = 'refunded';
    await order.save();
  }

  // Stalls that had already accepted are told to stand down.
  await StallOrder.updateMany(
    { order: order._id, status: { $in: ['awaiting', 'accepted'] } },
    { $set: { status: 'cancelled' } }
  );

  return order;
}

/**
 * Confirm the order once every stall has accepted. Capturing the hold here is
 * what turns it into a real payment.
 */
async function confirmOrder(orderId) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: 'Awaiting Acceptance' },
    {
      $set: { status: 'Confirmed' },
      $push: { statusHistory: { status: 'Confirmed', at: new Date(), by: null } },
    },
    { new: true }
  );

  if (!order) return null;

  /**
   * Capture. The debit was already written at checkout as the hold, so there is
   * no second movement of money — only the status changes from held to paid.
   * COD stays pending until the rider collects.
   */
  if (order.paymentMethod === 'wallet' && order.paymentStatus === 'held') {
    order.paymentStatus = 'paid';
    await order.save();
  }

  // Issue one pickup code per stall, returned to the vendor, verified by the rider.
  const stallOrders = await StallOrder.find({ order: order._id, status: 'accepted' });
  await Promise.all(
    stallOrders.map((stallOrder) => {
      const code = generatePickupCode();
      stallOrder.pickupCodeHash = hashPickupCode(stallOrder._id.toHexString(), code);
      // Surfaced once, to the vendor's panel response only.
      stallOrder.$locals.plainPickupCode = code;
      return stallOrder.save();
    })
  );

  return order;
}

/**
 * Decide whether an order in the acceptance phase has resolved.
 *
 * Called after every accept, reject and sweep. Reads the StallOrder rows rather
 * than trusting a counter, so a lost increment cannot confirm an order a vendor
 * never accepted.
 */
async function settleOrder(orderId) {
  const order = await Order.findById(orderId);
  if (!order || order.status !== 'Awaiting Acceptance') return order;

  const stallOrders = await StallOrder.find({ order: orderId }).select('status stall rejectionReason').lean();

  const rejected = stallOrders.find((s) => s.status === 'rejected');
  if (rejected) {
    return failOrder(orderId, {
      reason: rejected.rejectionReason || 'A stall could not fulfil part of this order.',
      stallId: rejected.stall,
    });
  }

  const allAccepted = stallOrders.length > 0 && stallOrders.every((s) => s.status === 'accepted');
  if (allAccepted) return confirmOrder(orderId);

  return order;
}

// --- Vendor actions --------------------------------------------------------

/**
 * A vendor accepts their slice.
 *
 * The filter carries the whole precondition — right stall, still awaiting,
 * deadline not passed — so the update either wins cleanly or does nothing.
 */
async function acceptStallOrder({ stallOrder, userId }) {
  const claimed = await StallOrder.findOneAndUpdate(
    { _id: stallOrder._id, status: 'awaiting', respondByAt: { $gt: new Date() } },
    { $set: { status: 'accepted', acceptedAt: new Date() } },
    { new: true }
  );

  if (!claimed) {
    throw new ApiError(
      409,
      'This order can no longer be accepted — it was already answered, or the time to respond ran out.',
      'STALL_ORDER_CLOSED'
    );
  }

  await Order.updateOne({ _id: claimed.order }, { $inc: { acceptedCount: 1 } });

  const order = await settleOrder(claimed.order);
  return { stallOrder: claimed, order };
}

/** A vendor declines. One decline fails the entire order. */
async function rejectStallOrder({ stallOrder, reason = null, autoRejected = false }) {
  const claimed = await StallOrder.findOneAndUpdate(
    { _id: stallOrder._id, status: { $in: ['awaiting', 'accepted'] } },
    {
      $set: {
        status: 'rejected',
        rejectedAt: new Date(),
        rejectionReason: reason,
        autoRejected,
      },
    },
    { new: true }
  );

  if (!claimed) {
    throw new ApiError(409, 'This order has already been answered.', 'STALL_ORDER_CLOSED');
  }

  const order = await failOrder(claimed.order, {
    reason: reason || 'A stall could not fulfil part of this order.',
    stallId: claimed.stall,
  });

  return { stallOrder: claimed, order };
}

// --- Timeout sweeper -------------------------------------------------------

/**
 * Auto-reject slices whose deadline passed.
 *
 * Without this an unattended stall would strand the customer's money and stock
 * indefinitely. Silence is treated as refusal — the safe reading, because the
 * alternative is promising a delivery nobody agreed to make.
 */
async function sweepExpiredStallOrders(now = new Date()) {
  const expired = await StallOrder.find({ status: 'awaiting', respondByAt: { $lte: now } })
    .select('_id order stall')
    .limit(200)
    .lean();

  let failed = 0;

  for (const row of expired) {
    try {
      await rejectStallOrder({
        stallOrder: row,
        reason: 'The stall did not respond in time.',
        autoRejected: true,
      });
      failed += 1;
    } catch (err) {
      // A concurrent vendor action won the race; nothing to do.
      if (err instanceof ApiError && err.code === 'STALL_ORDER_CLOSED') continue;
      console.error('[fulfilment] sweep failed for stall order', row._id?.toString(), err.message);
    }
  }

  return failed;
}

let sweepTimer = null;

function startSweeper() {
  if (sweepTimer || config.isTest) return null;
  sweepTimer = setInterval(() => {
    sweepExpiredStallOrders().catch((err) => console.error('[fulfilment] sweep error:', err.message));
  }, SWEEP_INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  return sweepTimer;
}

function stopSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

module.exports = {
  ACCEPTANCE_WINDOW_SECONDS,
  acceptanceDeadline,
  generatePickupCode,
  hashPickupCode,
  pickupCodeMatches,
  acceptStallOrder,
  rejectStallOrder,
  settleOrder,
  failOrder,
  confirmOrder,
  restoreStock,
  releaseHold,
  sweepExpiredStallOrders,
  startSweeper,
  stopSweeper,
};
