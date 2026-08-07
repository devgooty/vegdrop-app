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
    const settlementResult = await sweepSettlements();
    return {
      stallRounds: roundResult,
      sourcing: sourcingResult,
      partial: partialResult,
      rider: riderResult,
      settlement: settlementResult,
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
  sweepSettlements,
};
