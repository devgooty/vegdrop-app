'use strict';

const config = require('../config/env');
const ScheduledOrder = require('../models/ScheduledOrder');
const Order = require('../models/Order');
const User = require('../models/User');
const { computeNextRunFor } = require('../models/ScheduledOrder');
const checkout = require('./checkout');

/**
 * Turning standing orders into real ones.
 *
 * A schedule is an intent. This is the only thing that acts on it, and it does
 * so through services/checkout.js — the same path a customer's own checkout
 * takes — so prices come from the market's sheet as it stands that morning,
 * stock is claimed under the same conditional decrement, and a wallet payment
 * goes through the same ledger debit.
 *
 * IDEMPOTENCE, WHICH IS THE WHOLE PROBLEM
 *
 * The sweeper runs on every instance, every few seconds. Two ticks landing
 * together must not place two deliveries. `claimDueSchedule` advances
 * `nextRunAt` with a conditional update that matches the exact value it read,
 * so exactly one caller wins the claim and the loser matches nothing and does
 * nothing. That is the same guarantee sourcing and dispatch rely on, for the
 * same reason: the guard and the write are one atomic operation.
 *
 * The claim happens BEFORE the order is placed. If placing then fails, the run
 * is recorded as failed and the schedule moves on to its next occurrence rather
 * than retrying in a tight loop — a wallet that is short at 8am on Tuesday will
 * still be short at 8:00:05, and hammering it would place an order the instant
 * a top-up landed, hours after the customer expected the delivery.
 */

/** How far past due a schedule may be and still run. */
const GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Take ownership of one due schedule by advancing it to its next occurrence.
 *
 * @returns {Promise<object|null>} the schedule as it was when claimed, or null
 *   if another worker got there first.
 */
async function claimDueSchedule(schedule) {
  const advanceTo = computeNextRunFor(schedule, new Date());

  const claimed = await ScheduledOrder.findOneAndUpdate(
    {
      _id: schedule._id,
      status: 'active',
      // Match the exact due time we read. Another worker that already advanced
      // this schedule leaves our filter matching nothing.
      nextRunAt: schedule.nextRunAt,
    },
    {
      $set: {
        nextRunAt: advanceTo || new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRunAt: new Date(),
      },
    },
    // The pre-image, so the caller still knows which occurrence it claimed.
    { new: false }
  );

  return claimed;
}

/** Record why a run produced nothing, so the customer can act on it. */
async function recordFailure(scheduleId, code, message) {
  await ScheduledOrder.updateOne(
    { _id: scheduleId },
    {
      $set: {
        'lastFailure.at': new Date(),
        'lastFailure.code': String(code || 'ERROR').slice(0, 60),
        'lastFailure.message': String(message || 'Could not place this order.').slice(0, 300),
      },
    }
  ).catch(() => {});
}

/**
 * Run one schedule: claim it, then place the order.
 *
 * @returns {Promise<{placed: boolean, reason?: string, order?: object}>}
 */
async function runSchedule(schedule) {
  const claimed = await claimDueSchedule(schedule);
  if (!claimed) return { placed: false, reason: 'RACED' };

  const customer = await User.findOne({ _id: claimed.customer, status: 'active' });
  if (!customer) {
    await recordFailure(claimed._id, 'NO_CUSTOMER', 'This account is no longer active.');
    return { placed: false, reason: 'NO_CUSTOMER' };
  }

  try {
    const order = await checkout.placeOrder({
      user: customer,
      items: claimed.items.map((line) => ({
        productId: String(line.product),
        quantity: line.quantity,
      })),
      address: claimed.address,
      paymentMethod: claimed.paymentMethod,
      marketId: claimed.market ? String(claimed.market) : undefined,
      lat: claimed.deliveryLocation?.coordinates?.[1],
      lng: claimed.deliveryLocation?.coordinates?.[0],
    });

    // Stamped after the fact rather than threaded through checkout: the link is
    // for reporting, and must not become a parameter every caller has to pass.
    await Order.updateOne({ _id: order._id }, { $set: { schedule: claimed._id } });

    await ScheduledOrder.updateOne(
      { _id: claimed._id },
      {
        $set: { lastOrder: order._id, 'lastFailure.at': null, 'lastFailure.code': null, 'lastFailure.message': null },
        $inc: { runCount: 1 },
      }
    );

    return { placed: true, order };
  } catch (err) {
    /**
     * A failed run is reported, never retried in place.
     *
     * The commonest causes — an empty wallet, a market that has stopped selling
     * one of the items, a product withdrawn from the catalog — do not resolve
     * in the seconds before the next tick, and retrying would place the order
     * at an hour nobody asked for. The schedule has already been advanced, so
     * it simply tries again on its next occurrence.
     */
    await recordFailure(claimed._id, err.code || err.errorCode || 'ERROR', err.message);
    return { placed: false, reason: err.code || 'FAILED', error: err };
  }
}

/**
 * Place every order that has come due.
 *
 * Sequential on purpose: these are wallet debits and stock claims, and a burst
 * of concurrent checkouts against the same market is exactly the contention the
 * conditional decrements are there to survive, not something to seek out.
 */
async function runDueSchedules({ limit = 50, now = new Date() } = {}) {
  /**
   * The half of the lock that has no UI in it.
   *
   * Hiding the Scheduled Deliveries tab stops nobody: this runs from the
   * sweeper, on a timer, and places real orders against real wallets. Locking
   * the feature while leaving this running would charge people on a schedule
   * they can no longer see, let alone cancel.
   *
   * Rows are left `active` and untouched rather than paused, so unlocking
   * resumes them without a migration. Nothing fires for the locked period —
   * anything that fell outside the grace window is swept up by the same
   * overdue branch below that handles the server having been down.
   */
  if (config.scheduledOrdersLocked) {
    return { due: 0, placed: 0, failed: 0, missed: 0, locked: true };
  }

  const due = await ScheduledOrder.find({
    status: 'active',
    nextRunAt: { $lte: now, $gte: new Date(now.getTime() - GRACE_MS) },
  })
    .sort({ nextRunAt: 1 })
    .limit(limit);

  let placed = 0;
  let failed = 0;

  for (const schedule of due) {
    const result = await runSchedule(schedule);
    if (result.placed) placed += 1;
    else if (result.reason !== 'RACED') failed += 1;
  }

  /**
   * Schedules that fell further behind than the grace window.
   *
   * A server down overnight must not wake up and place yesterday's groceries.
   * They are moved to their next occurrence and told why nothing arrived.
   */
  const stale = await ScheduledOrder.find({
    status: 'active',
    nextRunAt: { $lt: new Date(now.getTime() - GRACE_MS) },
  }).limit(limit);

  for (const schedule of stale) {
    const advanceTo = computeNextRunFor(schedule, now);
    await ScheduledOrder.updateOne(
      { _id: schedule._id, nextRunAt: schedule.nextRunAt },
      {
        $set: {
          nextRunAt: advanceTo || new Date(now.getTime() + 24 * 60 * 60 * 1000),
          'lastFailure.at': now,
          'lastFailure.code': 'MISSED',
          'lastFailure.message': 'This delivery was missed and has been moved to the next date.',
        },
      }
    ).catch(() => {});
  }

  return { due: due.length, placed, failed, missed: stale.length };
}

module.exports = {
  GRACE_MS,
  claimDueSchedule,
  runSchedule,
  runDueSchedules,
};
