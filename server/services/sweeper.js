'use strict';

const config = require('../config/env');
const { isConnected } = require('../db/connect');
const Order = require('../models/Order');
const sourcing = require('./sourcing');
const dispatch = require('./dispatch');
const settlement = require('./settlement');

/**
 * The clock.
 *
 * Three things in this system happen because time passed rather than because
 * somebody tapped a button: a sourcing window closing, a rider offer going
 * unanswered, and a stall's held earnings coming due. This is what notices.
 *
 * MULTI-INSTANCE SAFETY
 *
 * Every instance runs its own timer, and they will all find the same expired
 * orders. That is fine and deliberate: the work each one then does is a
 * conditional update that only matches if nothing has changed since it looked,
 * so exactly one instance acts on each order and the rest write nothing. There
 * is no leader election here because there does not need to be.
 *
 * The cost of that simplicity is N identical index scans per tick. At the scale
 * this runs at that is nothing; if it ever stops being nothing, the fix is a
 * change stream on the deadline field, not a lock.
 */

let timer = null;
let running = false;

/** Bounded per tick so one slow batch cannot pile up behind the next. */
const BATCH_SIZE = 50;

/**
 * Sourcing windows that have run out.
 *
 * `expireSourcing` re-checks the deadline it read before acting, so an order
 * picked up here and handled by another instance in between is simply skipped.
 */
async function sweepSourcing() {
  const due = await Order.find({
    'fulfillment.status': 'sourcing',
    'fulfillment.sourcingDeadline': { $lte: new Date() },
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  const results = { hopped: 0, failed: 0, promoted: 0, skipped: 0 };

  for (const order of due) {
    try {
      const outcome = await sourcing.expireSourcing(order._id);
      results[outcome.action] = (results[outcome.action] || 0) + 1;
    } catch (err) {
      // One bad order must never stop the tick. A WALLET_CONFLICT here is
      // ordinary contention — the next tick picks the order up again.
      console.warn(`[sweeper] sourcing ${order.orderNumber}: ${err.message}`);
    }
  }

  return results;
}

/** Rider offers nobody answered, plus packed orders still waiting for anyone. */
async function sweepRiderOffers() {
  const now = new Date();

  const expired = await Order.find({
    assignedTo: null,
    'fulfillment.status': { $in: dispatch.OFFERABLE },
    'fulfillment.riderOffer.rider': { $ne: null },
    'fulfillment.riderOffer.expiresAt': { $lte: now },
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  for (const order of expired) {
    try {
      await dispatch.expireOffer(order._id);
    } catch (err) {
      console.warn(`[sweeper] rider offer ${order.orderNumber}: ${err.message}`);
    }
  }

  /**
   * Orders with nobody to carry them and no live offer.
   *
   * This is the retry that matters most: the first attempt often finds no rider
   * within range at all, and without this the order would sit until a human
   * noticed. Riders come online continuously, so asking again every few seconds
   * is the whole recovery mechanism.
   */
  const unoffered = await Order.find({
    assignedTo: null,
    'fulfillment.status': { $in: dispatch.OFFERABLE },
    'fulfillment.riderOffer.rider': null,
    'fulfillment.riderOffer.openPool': false,
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  for (const order of unoffered) {
    try {
      await dispatch.offerToNearestRider(order._id);
    } catch (err) {
      console.warn(`[sweeper] rider search ${order.orderNumber}: ${err.message}`);
    }
  }

  return { expired: expired.length, retried: unoffered.length };
}

/**
 * Stall earnings whose hold has expired, plus any delivery whose payout record
 * never got written.
 *
 * This is the only path by which a shopkeeper is paid without asking, so it
 * runs on every tick — a day-long hold means nothing if the thing that ends it
 * only runs when someone remembers.
 */
async function sweepSettlements() {
  const released = await settlement.releaseDue({ limit: BATCH_SIZE });
  const backfilled = await settlement.backfillUnsettled({ limit: BATCH_SIZE });
  return { ...released, backfilled: backfilled.recorded };
}

/**
 * Orders that ended without their money going back.
 *
 * Both refund paths — a customer cancelling and a sweep failing an order — now
 * move the order into its terminal state first and credit the wallet after, so
 * that a guard which legitimately refuses to match cannot pay out. The cost of
 * that ordering is a window: crash between the two and the order reads
 * `cancelled` while still marked `paid`, with the customer out of pocket.
 *
 * This is what closes it. The refund is keyed on the order, so re-running it
 * against an order that was in fact already credited writes nothing.
 */
async function sweepPendingRefunds() {
  const owed = await Order.find({
    'fulfillment.status': { $in: ['cancelled', 'failed'] },
    paymentMethod: 'wallet',
    paymentStatus: 'paid',
  })
    .select('_id orderNumber customer totalAmountPaise paymentMethod paymentStatus')
    .limit(BATCH_SIZE)
    .lean();

  let refunded = 0;
  for (const order of owed) {
    try {
      const result = await sourcing.refundToWallet(order);
      if (result.refunded) {
        refunded += 1;
        console.warn(`[sweeper] completed an interrupted refund for ${order.orderNumber}`);
      }
    } catch (err) {
      // Ordinary ledger contention resolves itself on the next tick.
      console.warn(`[sweeper] refund ${order.orderNumber}: ${err.message}`);
    }
  }

  return { refunded };
}

/** One pass. Exported so tests can drive it directly instead of waiting. */
async function tick() {
  if (!isConnected()) return null;

  // Overlap guard: a tick that outruns the interval must not start a second
  // copy of itself and double the load exactly when the system is struggling.
  if (running) return null;
  running = true;

  try {
    // Sequential rather than parallel: these touch the same orders, and the
    // point of the tick is correctness, not shaving milliseconds.
    const sourcingResult = await sweepSourcing();
    const riderResult = await sweepRiderOffers();
    const settlementResult = await sweepSettlements();
    const refundResult = await sweepPendingRefunds();
    return {
      sourcing: sourcingResult,
      rider: riderResult,
      settlement: settlementResult,
      refunds: refundResult,
    };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return timer;

  const intervalMs = config.marketplace.sweeperIntervalSeconds * 1000;
  timer = setInterval(() => {
    tick().catch((err) => console.error(`[sweeper] tick failed: ${err.message}`));
  }, intervalMs);

  // Never hold the process open on the sweeper's account — shutdown should be
  // decided by the HTTP server draining, not by a timer that has not fired yet.
  if (typeof timer.unref === 'function') timer.unref();

  console.info(`[sweeper] started, every ${config.marketplace.sweeperIntervalSeconds}s`);
  return timer;
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  tick,
  sweepSourcing,
  sweepRiderOffers,
  sweepSettlements,
  sweepPendingRefunds,
};
