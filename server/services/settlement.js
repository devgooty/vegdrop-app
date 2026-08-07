'use strict';

const config = require('../config/env');
const Order = require('../models/Order');
const Stall = require('../models/Stall');
const StallEarning = require('../models/StallEarning');
const { ApiError } = require('../middleware/errors');
const wallet = require('./wallet');

/**
 * Paying the sellers — market stalls and independent shops alike.
 *
 * Only the market half existed, and the gap was not cosmetic: `recordDelivery`
 * returned early on an order with no market, so a wallet-paid shop order took
 * the customer's money and wrote no obligation at all. Nothing downstream was
 * broken, because there was nothing downstream — the release sweep can only pay
 * what was recorded. COD hid it, since the rider hands over cash either way.
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
 * What the platform keeps, and what reaches the seller.
 *
 * One place for the arithmetic so a stall and a shop are never rounded
 * differently on the same gross.
 */
function applyCommission(grossPaise) {
  const commissionPaise = Math.round((grossPaise * config.settlement.commissionBps) / 10000);
  return { commissionPaise, netPaise: grossPaise - commissionPaise };
}

/**
 * Write one obligation, absorbing the replay.
 *
 * @returns {Promise<boolean>} whether this call is the one that created it
 */
async function createEarning(doc) {
  try {
    await StallEarning.create(doc);
    return true;
  } catch (err) {
    // 11000 is the (order, stall) unique index doing its job on a replay.
    if (err?.code !== 11000) throw err;
    return false;
  }
}

/**
 * Record what the seller on this order is owed, and start the clock.
 *
 * Called the moment a delivery is confirmed. Safe to call again — the unique
 * index means a repeat writes nothing rather than creating a second obligation.
 *
 * Both kinds of seller come through here. Which branch runs is decided by the
 * order, not by the caller, so the market rider's completion and a shop order's
 * status change cannot disagree about what gets recorded.
 *
 * @returns {Promise<{recorded: number, totalNetPaise: number}>}
 */
async function recordDelivery(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order) return { recorded: 0, totalNetPaise: 0 };

  if (order.market) return recordMarketDelivery(order);
  if (order.shop) return recordShopDelivery(order);

  /**
   * A legacy order with no named seller. There is nobody to pay — these predate
   * both markets and shops — so mark it settled rather than leaving the backfill
   * sweep to pick it up on every tick for ever.
   */
  await markSettled(order._id);
  return { recorded: 0, totalNetPaise: 0, reason: 'NO_SELLER' };
}

/**
 * A market order: one obligation per stall that supplied a line.
 */
async function recordMarketDelivery(order) {
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

    const { commissionPaise, netPaise } = applyCommission(share.grossPaise);
    if (netPaise <= 0) continue;

    const created = await createEarning({
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

    if (created) {
      recorded += 1;
      totalNetPaise += netPaise;
    }
  }

  await markSettled(order._id);
  return { recorded, totalNetPaise };
}

/**
 * An independent shop order: one obligation, for the whole basket.
 *
 * No `splitByStall`, because there is nothing to split — the shop supplied
 * every line itself.
 *
 * Delivery is read from the coarse `status`, not from `fulfillment.status`. A
 * shop order has no sourcing engine and never sets one, so `fulfillment.status`
 * is null for its entire life; keying off it here is what made the first
 * version of this silently record nothing.
 *
 * Recorded whatever the customer paid with, exactly as for a market order. Only
 * a rider or an admin can mark an order Delivered — a shopkeeper cannot — so
 * COD cash reaches the platform through the rider either way, and the platform
 * owes the seller in both cases.
 */
async function recordShopDelivery(order) {
  if (order.status !== 'Delivered') {
    return { recorded: 0, totalNetPaise: 0, reason: 'NOT_DELIVERED' };
  }

  const lines = order.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPricePaise: item.unitPricePaise,
    lineTotalPaise: item.unitPricePaise * item.quantity,
  }));

  /**
   * Summed from the lines rather than taken from `subtotalPaise`, so `lines`
   * and `grossPaise` can never disagree — and the delivery fee stays out of it,
   * because that is the platform's, not the shop's.
   */
  const grossPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
  const { commissionPaise, netPaise } = applyCommission(grossPaise);

  if (netPaise <= 0) {
    await markSettled(order._id);
    return { recorded: 0, totalNetPaise: 0 };
  }

  const earnedAt = new Date();
  const created = await createEarning({
    shop: order.shop,
    owner: order.shop,
    order: order._id,
    orderNumber: order.orderNumber,
    lines,
    grossPaise,
    commissionPaise,
    netPaise,
    status: 'pending',
    earnedAt,
    releaseAt: new Date(earnedAt.getTime() + HOLD_MS),
  });

  await markSettled(order._id);
  return created
    ? { recorded: 1, totalNetPaise: netPaise }
    : { recorded: 0, totalNetPaise: 0 };
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
 *
 * The two branches read different fields on purpose, and it is the same
 * distinction `recordDelivery` makes: a market order's truth is
 * `fulfillment.status`, and a shop order never sets one. A single query over
 * `fulfillment.status: 'delivered'` matched market orders only, which is how
 * every shop delivery slipped past this as well as past the live path.
 */
async function backfillUnsettled({ limit = 50 } = {}) {
  const orders = await Order.find({
    'fulfillment.settledAt': null,
    $or: [
      { market: { $ne: null }, 'fulfillment.status': 'delivered' },
      { shop: { $ne: null }, status: 'Delivered' },
    ],
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

/**
 * The seller's own statement: what each order earned them and where it is.
 *
 * Keyed on `owner` alone, so it answers for a stall keeper and an independent
 * shopkeeper without either route needing to know which it is asking about.
 */
async function recentForOwner(ownerId, { limit = 50 } = {}) {
  const rows = await StallEarning.find({ owner: ownerId })
    .sort({ earnedAt: -1 })
    .limit(limit)
    .select('orderNumber netPaise grossPaise commissionPaise status earnedAt releaseAt releasedAt releasedEarly lines stallNumber shop')
    .lean();

  return rows.map((row) => ({
    id: String(row._id),
    orderNumber: row.orderNumber,
    netPaise: row.netPaise,
    grossPaise: row.grossPaise,
    commissionPaise: row.commissionPaise,
    status: row.status,
    earnedAt: row.earnedAt,
    releaseAt: row.releaseAt,
    releasedAt: row.releasedAt,
    releasedEarly: row.releasedEarly,
    // Lets one screen render both without a second call to work out which.
    seller: row.shop ? 'shop' : 'stall',
    stallNumber: row.stallNumber || null,
    itemCount: row.lines.reduce((sum, l) => sum + l.quantity, 0),
  }));
}

module.exports = {
  recordDelivery,
  releaseDue,
  releaseEarly,
  backfillUnsettled,
  summaryForOwner,
  recentForOwner,
  splitByStall,
  payoutKey,
};
