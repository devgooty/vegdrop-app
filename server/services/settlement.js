'use strict';

const config = require('../config/env');
const Order = require('../models/Order');
const Stall = require('../models/Stall');
const StallEarning = require('../models/StallEarning');
const { ApiError } = require('../middleware/errors');
const wallet = require('./wallet');

/**
 * Paying the stalls.
 *
 * Three rules, and the order of them is the whole design:
 *
 *   1. Nothing is owed until the customer has the goods. An order that was
 *      accepted, packed, and then cancelled pays nobody — no sale happened.
 *   2. What is owed is HELD for a day. That window is when a delivery can still
 *      go wrong, and money not yet paid is far easier to withhold than paid
 *      money is to claw back.
 *   3. After the hold it lands in the shopkeeper's wallet on its own. They
 *      never have to ask. If they want it sooner they can take it early,
 *      provided there is at least the minimum sitting there.
 *
 * IDEMPOTENCY, TWICE OVER
 *
 * Money paid twice is the worst bug this file could have, so it is guarded in
 * two independent places. Recording an obligation collides on the unique
 * (order, stall) index. Releasing one uses a wallet idempotency key derived
 * from the obligation's own id, so a replayed release finds the existing ledger
 * entry and moves nothing. Either guard alone would do; both means a bug in one
 * is not a bug in the payout.
 */

const HOLD_MS = config.settlement.holdHours * 60 * 60 * 1000;

/** `settlement:<earningId>` — one ledger entry per obligation, for ever. */
function payoutKey(earningId) {
  return `settlement:${earningId}`;
}

/**
 * Split an order into what each stall is owed.
 *
 * Priced from `sourcePricePaise`, which is the market's own price sheet — not
 * the customer's `unitPricePaise`, which is locked at checkout and can differ
 * from it once an order has hopped to a second market. The stall is owed what
 * its own market charges; the gap either way is the platform's.
 */
function splitByStall(order) {
  const byStall = new Map();

  for (const item of order.items) {
    const stallId = item.claim?.stall;
    if (!stallId) continue;

    const key = String(stallId);
    const unitPricePaise = item.sourcePricePaise ?? item.unitPricePaise;
    const lineTotalPaise = unitPricePaise * item.quantity;

    if (!byStall.has(key)) {
      byStall.set(key, {
        stall: stallId,
        stallNumber: item.claim.stallNumber || null,
        lines: [],
        grossPaise: 0,
      });
    }

    const entry = byStall.get(key);
    entry.lines.push({
      name: item.name,
      quantity: item.quantity,
      unitPricePaise,
      lineTotalPaise,
    });
    entry.grossPaise += lineTotalPaise;
  }

  return [...byStall.values()];
}

/**
 * Record what every stall on this order is owed, and start the clock.
 *
 * Called the moment a delivery is confirmed. Safe to call again — the unique
 * index means a repeat writes nothing rather than creating a second obligation.
 *
 * @returns {Promise<{recorded: number, totalNetPaise: number}>}
 */
async function recordDelivery(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order || !order.market) return { recorded: 0, totalNetPaise: 0 };

  if (order.fulfillment?.status !== 'delivered') {
    // Not an error worth throwing: the sweeper scans broadly and may reach an
    // order that has since been cancelled.
    return { recorded: 0, totalNetPaise: 0, reason: 'NOT_DELIVERED' };
  }

  const shares = splitByStall(order);
  if (shares.length === 0) {
    await markSettled(order._id);
    return { recorded: 0, totalNetPaise: 0 };
  }

  // Owner is read from the stall now and frozen onto the obligation. If the
  // stall later changes hands, money earned under the old owner still pays the
  // old owner.
  const stalls = await Stall.find({ _id: { $in: shares.map((s) => s.stall) } })
    .select('owner stallNumber')
    .lean();
  const ownerByStall = new Map(stalls.map((s) => [String(s._id), s]));

  const earnedAt = new Date();
  const releaseAt = new Date(earnedAt.getTime() + HOLD_MS);

  let recorded = 0;
  let totalNetPaise = 0;

  for (const share of shares) {
    const stall = ownerByStall.get(String(share.stall));
    if (!stall?.owner) continue;

    const commissionPaise = Math.round((share.grossPaise * config.settlement.commissionBps) / 10000);
    const netPaise = share.grossPaise - commissionPaise;
    if (netPaise <= 0) continue;

    try {
      await StallEarning.create({
        stall: share.stall,
        stallNumber: share.stallNumber || stall.stallNumber || null,
        owner: stall.owner,
        market: order.market,
        order: order._id,
        orderNumber: order.orderNumber,
        lines: share.lines,
        grossPaise: share.grossPaise,
        commissionPaise,
        netPaise,
        status: 'pending',
        earnedAt,
        releaseAt,
      });
      recorded += 1;
      totalNetPaise += netPaise;
    } catch (err) {
      // 11000 is the (order, stall) unique index doing its job on a replay.
      if (err?.code !== 11000) throw err;
    }
  }

  await markSettled(order._id);
  return { recorded, totalNetPaise };
}

/** Flag the order so the backfill sweep stops looking at it. */
function markSettled(orderId) {
  return Order.updateOne(
    { _id: orderId },
    { $set: { 'fulfillment.settledAt': new Date() } }
  ).catch(() => {});
}

/**
 * Move one obligation into the shopkeeper's wallet.
 *
 * The credit happens BEFORE the status flips, deliberately. Crash in between
 * and the money is already with the shopkeeper and the next sweep replays
 * harmlessly onto the same idempotency key; flip first and a crash would leave
 * an obligation marked paid that never was.
 *
 * No session is passed to `wallet.credit`. A seq collision inside a transaction
 * throws WALLET_CONFLICT immediately and cannot be retried, whereas outside one
 * the ledger's own retry loop resolves it — see the note in services/wallet.js.
 */
async function releaseEarning(earning, { early = false } = {}) {
  const result = await wallet.credit({
    userId: earning.owner,
    amountPaise: earning.netPaise,
    reason: 'stall_settlement',
    idempotencyKey: payoutKey(earning._id),
    order: earning.order,
    note: `Payout for ${earning.orderNumber}${earning.stallNumber ? ` (stall ${earning.stallNumber})` : ''}`,
    session: null,
  });

  await StallEarning.updateOne(
    { _id: earning._id, status: 'pending' },
    {
      $set: {
        status: 'released',
        releasedAt: new Date(),
        releasedEarly: early,
        walletTransaction: result.transaction?._id || null,
      },
    }
  );

  return { paidPaise: earning.netPaise, replayed: result.replayed };
}

/**
 * Release everything whose hold has expired. Driven by the sweeper.
 *
 * @returns {Promise<{released: number, paidPaise: number}>}
 */
async function releaseDue({ limit = 100 } = {}) {
  const due = await StallEarning.find({ status: 'pending', releaseAt: { $lte: new Date() } })
    .sort({ releaseAt: 1 })
    .limit(limit)
    .lean();

  let released = 0;
  let paidPaise = 0;

  for (const earning of due) {
    try {
      const result = await releaseEarning(earning);
      released += 1;
      paidPaise += result.paidPaise;
    } catch (err) {
      // One stuck payout must not stop the rest. Ordinary ledger contention
      // resolves itself on the next tick.
      console.warn(`[settlement] ${earning.orderNumber}: ${err.message}`);
    }
  }

  return { released, paidPaise };
}

/**
 * Take the money now, before the hold expires.
 *
 * The floor exists because every payout is a ledger write and eventually a bank
 * transfer that costs something to make; without one a stall could drain ₹20 at
 * a time all day. Reaching the floor releases EVERYTHING pending, not just the
 * floor amount — a partial payout would leave dust behind that could never be
 * withdrawn again.
 *
 * @throws {ApiError} 409 BELOW_MINIMUM
 */
async function releaseEarly(ownerId) {
  const pending = await StallEarning.find({ owner: ownerId, status: 'pending' })
    .sort({ earnedAt: 1 })
    .lean();

  const totalPaise = pending.reduce((sum, e) => sum + e.netPaise, 0);
  const minimum = config.settlement.minEarlyPayoutPaise;

  if (totalPaise < minimum) {
    throw new ApiError(
      409,
      `You need at least ₹${(minimum / 100).toFixed(0)} to withdraw early. You have ₹${(totalPaise / 100).toFixed(2)}. ` +
      'Anything still waiting reaches your wallet on its own within a day.',
      'BELOW_MINIMUM',
      [{ field: 'pendingPaise', message: String(totalPaise) }]
    );
  }

  let paidPaise = 0;
  let released = 0;

  for (const earning of pending) {
    try {
      const result = await releaseEarning(earning, { early: true });
      paidPaise += result.paidPaise;
      released += 1;
    } catch (err) {
      console.warn(`[settlement] early payout ${earning.orderNumber}: ${err.message}`);
    }
  }

  if (released === 0) {
    throw new ApiError(409, 'Could not pay out right now. Please try again in a moment.', 'PAYOUT_FAILED');
  }

  return { released, paidPaise };
}

/**
 * Catch deliveries whose payout record never got written — a crash between
 * confirming delivery and recording what was owed.
 *
 * Cheap because it is driven by a flag on the order rather than by joining
 * against the earnings collection.
 */
async function backfillUnsettled({ limit = 50 } = {}) {
  const orders = await Order.find({
    'fulfillment.status': 'delivered',
    'fulfillment.settledAt': null,
    market: { $ne: null },
  })
    .select('_id orderNumber')
    .limit(limit)
    .lean();

  let recorded = 0;
  for (const order of orders) {
    try {
      const result = await recordDelivery(order._id);
      recorded += result.recorded;
    } catch (err) {
      console.warn(`[settlement] backfill ${order.orderNumber}: ${err.message}`);
    }
  }

  return { scanned: orders.length, recorded };
}

/** What one shopkeeper is owed and has been paid. Drives the earnings screen. */
async function summaryForOwner(ownerId) {
  const [totals] = await StallEarning.aggregate([
    { $match: { owner: ownerId } },
    {
      $group: {
        _id: '$status',
        total: { $sum: '$netPaise' },
        count: { $sum: 1 },
      },
    },
    { $group: { _id: null, buckets: { $push: { status: '$_id', total: '$total', count: '$count' } } } },
  ]);

  const buckets = new Map((totals?.buckets || []).map((b) => [b.status, b]));
  const pendingPaise = buckets.get('pending')?.total || 0;
  const releasedPaise = buckets.get('released')?.total || 0;

  // The soonest any of it becomes payable without asking.
  const next = await StallEarning.findOne({ owner: ownerId, status: 'pending' })
    .sort({ releaseAt: 1 })
    .select('releaseAt')
    .lean();

  return {
    pendingPaise,
    releasedPaise,
    pendingCount: buckets.get('pending')?.count || 0,
    nextReleaseAt: next?.releaseAt || null,
    minEarlyPayoutPaise: config.settlement.minEarlyPayoutPaise,
    canWithdrawNow: pendingPaise >= config.settlement.minEarlyPayoutPaise,
    holdHours: config.settlement.holdHours,
  };
}

module.exports = {
  recordDelivery,
  releaseDue,
  releaseEarly,
  backfillUnsettled,
  summaryForOwner,
  splitByStall,
  payoutKey,
};
