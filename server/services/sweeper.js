'use strict';

const config = require('../config/env');
const { isConnected } = require('../db/connect');
const Order = require('../models/Order');
const sourcing = require('./sourcing');
const dispatch = require('./dispatch');
const settlement = require('./settlement');
const scheduler = require('./scheduler');

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

/**
 * Stall offer rounds that have run out, plus orders whose first round never
 * opened.
 *
 * The second query is the one that matters most, and mirrors the rider retry
 * below. Checkout opens the first round inline, but it does so outside the
 * transaction and swallows any failure rather than failing a paid order — so
 * without this, an order whose first round failed to open would sit in
 * `sourcing` with a null deadline and nothing would ever ask a stall about it.
 */
async function sweepStallRounds() {
  const now = new Date();

  const expired = await Order.find({
    'fulfillment.status': 'sourcing',
    'fulfillment.stallOffer.expiresAt': { $lte: now },
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  const results = { expired: 0, opened: 0 };

  for (const order of expired) {
    try {
      await sourcing.expireStallRound(order._id);
      results.expired += 1;
    } catch (err) {
      console.warn(`[sweeper] stall round ${order.orderNumber}: ${err.message}`);
    }
  }

  const unopened = await Order.find({
    'fulfillment.status': 'sourcing',
    'fulfillment.stallOffer.expiresAt': null,
    'fulfillment.stallOffer.openPool': false,
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  for (const order of unopened) {
    try {
      await sourcing.offerRound(order._id);
      results.opened += 1;
    } catch (err) {
      console.warn(`[sweeper] stall round open ${order.orderNumber}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Customers who never answered "some of your items are available".
 *
 * Silence is taken as yes — see `sourcing.acceptPartial`. They have already
 * waited through a full sourcing attempt, and cancelling on them would turn a
 * mostly-successful order into nothing at all.
 */
async function sweepPartialDecisions() {
  const due = await Order.find({
    'fulfillment.status': 'partial_review',
    'fulfillment.partialDeadline': { $lte: new Date() },
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  let settled = 0;

  for (const order of due) {
    try {
      const outcome = await sourcing.expirePartialReview(order._id);
      if (outcome.action === 'partial_auto_accepted') settled += 1;
    } catch (err) {
      console.warn(`[sweeper] partial review ${order.orderNumber}: ${err.message}`);
    }
  }

  return { settled, due: due.length };
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
 * Independent-shop rider assignments: ones that timed out with nobody having
 * shown up, plus confirmed orders the first attempt never managed to offer.
 *
 * Mirrors `sweepRiderOffers` above — the expire-then-retry pair is the same
 * shape, just reading `status`/`assignedTo` instead of `fulfillment.status`,
 * because a shop order has no sourcing engine to drive the fine-grained state.
 */
async function sweepShopOrderAssignments() {
  const now = new Date();

  const expired = await Order.find({
    shop: { $ne: null },
    status: 'Preparing',
    assignedTo: { $ne: null },
    'fulfillment.riderOffer.expiresAt': { $lte: now },
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  for (const order of expired) {
    try {
      await dispatch.expireShopOrderAssignment(order._id);
    } catch (err) {
      console.warn(`[sweeper] shop rider ${order.orderNumber}: ${err.message}`);
    }
  }

  /**
   * Confirmed but never offered — the first attempt found no rider in range,
   * or the request-time call itself failed. Riders come online continuously,
   * so asking again every tick is the whole recovery mechanism, same as the
   * market side.
   */
  const unoffered = await Order.find({
    shop: { $ne: null },
    status: 'Preparing',
    assignedTo: null,
    'fulfillment.riderOffer.rider': null,
    'fulfillment.riderOffer.openPool': false,
  })
    .select('_id orderNumber')
    .limit(BATCH_SIZE)
    .lean();

  for (const order of unoffered) {
    try {
      await dispatch.offerShopOrderToNearestRider(order._id);
    } catch (err) {
      console.warn(`[sweeper] shop rider search ${order.orderNumber}: ${err.message}`);
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
    //
    // Rounds run before the backstop deliberately. `sweepSourcing` treats a
    // market as spent, so letting it act on an order whose next round was about
    // to open would hop an order that still had candidates left to ask.
    const roundResult = await sweepStallRounds();
    const sourcingResult = await sweepSourcing();
    const partialResult = await sweepPartialDecisions();
    const riderResult = await sweepRiderOffers();
    const shopRiderResult = await sweepShopOrderAssignments();
    const settlementResult = await sweepSettlements();
    const refundResult = await sweepPendingRefunds();
    /**
     * Standing orders that have come due.
     *
     * Last, because it PLACES orders and everything above reacts to orders that
     * already exist. Running it first would hand the same tick a brand-new
     * order to source and dispatch before it had finished settling the previous
     * round, for no benefit — the next tick is seconds away.
     */
    const scheduleResult = await scheduler.runDueSchedules({ limit: BATCH_SIZE });
    return {
      stallRounds: roundResult,
      sourcing: sourcingResult,
      partial: partialResult,
      rider: riderResult,
      shopRider: shopRiderResult,
      settlement: settlementResult,
      refunds: refundResult,
      schedules: scheduleResult,
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
  sweepStallRounds,
  sweepSourcing,
  sweepPartialDecisions,
  sweepRiderOffers,
  sweepShopOrderAssignments,
  sweepSettlements,
  sweepPendingRefunds,
};
