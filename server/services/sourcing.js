'use strict';

const mongoose = require('mongoose');
const config = require('../config/env');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const wallet = require('./wallet');
const { transitionTo } = require('../utils/orderStatus');

/**
 * Market sourcing: offering an order to a market's stalls and deciding what
 * happens when they answer, or don't.
 *
 * THE ONE RULE THAT MATTERS HERE
 *
 * Every state change below is a single conditional `findOneAndUpdate`. Not one
 * of them is a read-modify-write, and not one of them needs a transaction. A
 * document update in MongoDB is atomic on its own, so two stalls racing for the
 * same line, or a customer cancelling at the exact moment the last stall
 * accepts, resolve to exactly one winner because the loser's filter no longer
 * matches. Rewriting any of this as "read the order, change it, save it" would
 * reintroduce the race it is written to avoid.
 *
 * `fulfillment.status` is authoritative; the coarse `status` the apps already
 * render is written from it in the SAME `$set`, via `transitionTo()`.
 */

/** Events array is capped so a pathological order cannot grow without bound. */
const EVENT_CAP = 50;

/**
 * How long a sweeper holds an expired order while it decides what to do with it.
 * Short, because the work is a handful of queries; long enough that a slow hop
 * lookup is not picked up twice.
 */
const SWEEP_LEASE_MS = 30_000;

function objectId(value) {
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
}

function eventPush(event) {
  return { $each: [event], $slice: -EVENT_CAP };
}

/**
 * Side effects that must not block the caller — currently just calling a rider
 * when an order locks.
 *
 * A shopkeeper's accept must succeed the instant the claim lands; whether a
 * rider happened to be reachable at that moment is not their problem, and the
 * sweeper retries anyway. So the dispatch call is deliberately not awaited.
 *
 * Tracking them anyway buys two things: a graceful shutdown can drain what is
 * in flight, and tests can wait for the system to settle instead of sleeping
 * and hoping.
 */
const pendingSideEffects = new Set();

function fireAndForget(promise, label) {
  const tracked = promise
    .catch((err) => console.warn(`[sourcing] ${label}: ${err.message}`))
    .finally(() => pendingSideEffects.delete(tracked));
  pendingSideEffects.add(tracked);
  return tracked;
}

/**
 * Wait until nothing is in flight.
 *
 * Loops rather than awaiting once, because one side effect can start another —
 * a rider offer that finds nobody schedules the next attempt.
 */
async function settlePending() {
  while (pendingSideEffects.size > 0) {
    await Promise.all([...pendingSideEffects]);
  }
}

// ---------------------------------------------------------------------------
// Pricing a set of lines against a market
// ---------------------------------------------------------------------------

/**
 * What would this market charge to fill these lines?
 *
 * Returns null when the market cannot fill the order at all — a product it does
 * not carry, or has marked unavailable today. That is a hard disqualification:
 * an order that hops to a market missing one line has not moved any closer to
 * being delivered.
 *
 * @param {mongoose.Types.ObjectId} marketId
 * @param {Array<{product: any, quantity: number, lineId: any}>} lines
 * @returns {Promise<null | { priced: Array<{lineId: any, sourcePricePaise: number}>, sourceSubtotalPaise: number }>}
 */
async function priceLinesAtMarket(marketId, lines) {
  const productIds = lines.map((l) => objectId(l.product));

  const sheet = await MarketPrice.find({
    market: objectId(marketId),
    product: { $in: productIds },
    isAvailable: true,
  })
    .select('product pricePaise')
    .lean();

  const byProduct = new Map(sheet.map((row) => [String(row.product), row.pricePaise]));

  const priced = [];
  let sourceSubtotalPaise = 0;

  for (const line of lines) {
    const unit = byProduct.get(String(line.product));
    if (unit === undefined) return null;
    sourceSubtotalPaise += unit * line.quantity;
    priced.push({ lineId: line.lineId, sourcePricePaise: unit });
  }

  return { priced, sourceSubtotalPaise };
}

/**
 * The most we are willing to pay a market to fill an order.
 *
 * The customer's total was fixed at checkout and never moves, so anything a
 * second market charges above the first comes straight out of margin. The
 * default tolerance is 10000bps — "same price or cheaper only" — which makes a
 * hop incapable of losing money. Raising it buys a better fill rate at a known,
 * bounded cost per order.
 */
function hopPriceCeiling(subtotalPaise) {
  return Math.floor((subtotalPaise * config.marketplace.hopPriceToleranceBps) / 10000);
}

// ---------------------------------------------------------------------------
// Starting a sourcing round
// ---------------------------------------------------------------------------

/**
 * The `fulfillment` block for a brand-new market order.
 *
 * Built here rather than inside a follow-up update so the order is never
 * briefly visible in a state with no deadline — the sweeper would see a
 * sourcing order with a null deadline and have no idea what to do with it.
 */
function initialFulfillment(marketId) {
  const now = Date.now();
  return {
    status: 'sourcing',
    // The backstop, not the working clock. `stallOffer.expiresAt` drives the
    // cascade; this only catches an order whose round bookkeeping went wrong.
    sourcingDeadline: new Date(now + config.marketplace.sourcingWindowSeconds * 1000),
    attempt: 1,
    triedMarkets: [objectId(marketId)],
    lockedAt: null,
    stallOffer: emptyStallOffer(),
    droppedItems: [],
    partialDeadline: null,
    riderOffer: { rider: null, expiresAt: null, count: 0, declinedBy: [], openPool: false },
    events: [{ at: new Date(now), type: 'sourcing_started', market: objectId(marketId) }],
  };
}

/** A fresh, explicitly-null claim. Never leave this implicit — see the note in Order.js. */
function emptyClaim() {
  return { stall: null, stallNumber: null, claimedAt: null, auto: false, packedAt: null, collectedAt: null };
}

/** A fresh, explicitly-null offer. Same reasoning as `emptyClaim`. */
function emptyOffer() {
  return { stall: null, offeredAt: null };
}

/**
 * A cascade with no history. Written on a new order and again on every hop —
 * a stall's refusal in one market says nothing about the stalls in the next.
 */
function emptyStallOffer() {
  return { round: 0, expiresAt: null, declinedBy: [], openPool: false };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * A stall takes some lines of an offered order.
 *
 * Partial success is normal and expected: a stall asks for four lines, another
 * stall got two of them a moment ago, and this call awards the remaining two.
 * The caller is told exactly what it won so it can show the shopkeeper the
 * truth rather than an optimistic echo of what they tapped.
 *
 * @returns {Promise<{won: Array, lost: Array, order: object|null, promoted: object|null}>}
 */
async function claimLines({
  orderId,
  stallId,
  stallNumber,
  lineIds,
  auto = false,
  actorId = null,
  /**
   * Require the line to have been offered to this stall.
   *
   * True for a shopkeeper tapping accept — the cascade splits an order between
   * several stalls, and without this any stall could take any line and the
   * ranking would mean nothing. False for the cascade's own auto-accept, which
   * claims straight from the plan without writing an offer first.
   */
  requireOffer = false,
}) {
  const stall = objectId(stallId);
  const wanted = lineIds.map((id) => objectId(id));
  const wantedKeys = new Set(wanted.map(String));

  // Read first purely so we can report accurately. The read is NOT the guard —
  // the guard is the arrayFilter below, which is evaluated by the server at
  // write time and cannot be raced.
  const before = await Order.findById(orderId)
    .select('items.lineId items.claim.stall items.offer.stall fulfillment.status fulfillment.stallOffer.openPool')
    .lean();
  if (!before) return { won: [], lost: [], order: null, promoted: null };
  if (before.fulfillment?.status !== 'sourcing') {
    return { won: [], lost: [], order: null, promoted: null, reason: 'NOT_SOURCING' };
  }

  // In the open pool the ranking has already been exhausted, so a line needs no
  // offer to be claimable — that is the whole point of the pool.
  const enforceOffer = requireOffer && !before.fulfillment?.stallOffer?.openPool;

  const eligible = before.items.filter(
    (item) =>
      item.lineId &&
      wantedKeys.has(String(item.lineId)) &&
      !item.claim?.stall &&
      (!enforceOffer || String(item.offer?.stall) === String(stall))
  );
  if (eligible.length === 0) {
    return {
      won: [],
      lost: [...wantedKeys],
      order: null,
      promoted: null,
      reason: enforceOffer ? 'NOT_OFFERED' : 'ALREADY_TAKEN',
    };
  }

  const now = new Date();

  /**
   * One atomic update. `arrayFilters` matches only the elements that are both
   * requested AND still unclaimed, so a second stall arriving a millisecond
   * later matches nothing and writes nothing. There is no window between the
   * check and the write because they are the same operation.
   */
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'sourcing' },
    {
      $set: {
        'items.$[line].claim.stall': stall,
        'items.$[line].claim.stallNumber': stallNumber,
        'items.$[line].claim.claimedAt': now,
        'items.$[line].claim.auto': auto,
        // The offer is answered; clear it so the round expiry does not later
        // record this stall as having gone silent on a line it actually took.
        'items.$[line].offer.stall': null,
        'items.$[line].offer.offeredAt': null,
      },
      $push: {
        'fulfillment.events': eventPush({
          at: now,
          type: auto ? 'lines_auto_claimed' : 'lines_claimed',
          stall,
          note: `${eligible.length} line(s)`,
        }),
      },
    },
    {
      arrayFilters: [
        {
          'line.lineId': { $in: wanted },
          'line.claim.stall': null,
          ...(enforceOffer ? { 'line.offer.stall': stall } : {}),
        },
      ],
      returnDocument: 'after',
    }
  );

  if (!updated) return { won: [], lost: [...wantedKeys], order: null, promoted: null, reason: 'NOT_SOURCING' };

  const stallKey = String(stall);
  const won = updated.items.filter(
    (item) => item.lineId && wantedKeys.has(String(item.lineId)) && String(item.claim?.stall) === stallKey
  );
  const wonKeys = new Set(won.map((item) => String(item.lineId)));
  const lost = [...wantedKeys].filter((key) => !wonKeys.has(key));

  if (won.length > 0) {
    // $inc, never read-then-write: two concurrent claims on the same stall must
    // both count. This is the "how busy is this stall right now" signal that
    // auto-accept ranks on.
    await Stall.updateOne({ _id: stall }, { $inc: { activeLoad: won.length } }).catch(() => {});
  }

  const promoted = await promoteIfComplete(orderId, actorId);

  return { won, lost, order: promoted || updated, promoted };
}

/**
 * Lock the order once every line has a taker.
 *
 * This single update IS the cancellation cutoff the customer is told about:
 * past `lockedAt`, stalls have set produce aside and the order is no longer
 * theirs to call off. It is guarded so that exactly one caller can perform it,
 * and so that a customer cancel landing at the same instant either wins
 * outright or fails cleanly — never both.
 */
async function promoteIfComplete(orderId, actorId = null) {
  const now = new Date();

  const promoted = await Order.findOneAndUpdate(
    {
      _id: orderId,
      'fulfillment.status': 'sourcing',
      // "No element is still unclaimed." The 1-100 item validator on the schema
      // rules out the empty-array reading of this.
      items: { $not: { $elemMatch: { 'claim.stall': null } } },
    },
    {
      $set: transitionTo('packing', { 'fulfillment.lockedAt': now }),
      $push: {
        statusHistory: { status: 'Preparing', at: now, by: actorId },
        'fulfillment.events': eventPush({ at: now, type: 'locked_all_claimed' }),
      },
    },
    { returnDocument: 'after' }
  );

  if (promoted && config.marketplace.riderDispatchOn === 'packing') {
    // Required lazily: dispatch reads orders, sourcing writes them, and a
    // top-level require in both directions would be a cycle.
    const dispatch = require('./dispatch');
    fireAndForget(dispatch.offerToNearestRider(promoted._id), `rider dispatch for ${promoted.orderNumber}`);
  }

  return promoted;
}

// ---------------------------------------------------------------------------
// The stall cascade: who gets asked, in what order
// ---------------------------------------------------------------------------

/**
 * Rank the market's stalls against the lines still needing a taker, and split
 * those lines between the best few.
 *
 * THE RANKING, IN ORDER OF PRECEDENCE
 *
 * 1. **Coverage** — how many of the remaining lines this stall could supply.
 *    Most first. This is the rule the whole cascade exists for: a stall holding
 *    four of the five items is worth far more than one holding a single item,
 *    because an order split across fewer stalls is one the rider can actually
 *    collect. The previous implementation ranked each line INDEPENDENTLY and so
 *    scattered a five-line order across five stalls whenever it could.
 * 2. **Load** — `activeLoad`, lines claimed but not yet collected. Between two
 *    stalls that cover the same amount, the quieter one gets the work.
 * 3. **Stall number** — purely so the outcome is deterministic and testable.
 *
 * Greedy set cover, not exhaustive: after each pick the covered lines are
 * removed and every remaining stall is re-scored against what is left. Optimal
 * set cover is NP-hard and the greedy answer is within a log factor, which for
 * a handful of stalls and a handful of lines is indistinguishable from perfect.
 *
 * @returns {Promise<Array<{stallId, stallNumber, autoAccept, lineIds: Array, take: Array}>>}
 */
async function planRound({ marketId, lines, declinedBy = [] }) {
  if (lines.length === 0) return [];

  const rows = await StallInventory.aggregate([
    {
      $match: {
        market: objectId(marketId),
        product: { $in: lines.map((l) => objectId(l.product)) },
        stock: { $gt: 0 },
      },
    },
    {
      $lookup: {
        from: Stall.collection.collectionName,
        localField: 'stall',
        foreignField: '_id',
        as: 'stallDoc',
      },
    },
    { $unwind: '$stallDoc' },
    // `status` is checked alongside `isActive` rather than trusting it alone: a
    // stall awaiting its market owner's approval is held inactive, but nothing
    // stops an owner toggling `isActive` on a row they have not yet accepted,
    // and the cascade would then offer produce from an unapproved stall.
    //
    // Note there is NO `autoAccept` filter here, unlike the auto-accept-only
    // query this replaced. Every qualifying stall is a candidate to be ASKED;
    // auto-accept only decides whether a human has to tap the button.
    {
      $match: {
        'stallDoc.isOpen': true,
        'stallDoc.isActive': true,
        'stallDoc.status': 'approved',
        'stallDoc._id': { $nin: declinedBy.map(objectId) },
      },
    },
    {
      $project: {
        _id: 0,
        product: 1,
        stock: 1,
        stallId: '$stallDoc._id',
        stallNumber: '$stallDoc.stallNumber',
        activeLoad: '$stallDoc.activeLoad',
        autoAccept: '$stallDoc.autoAccept',
      },
    },
  ]);

  if (rows.length === 0) return [];

  const stalls = new Map();
  for (const row of rows) {
    const key = String(row.stallId);
    if (!stalls.has(key)) {
      stalls.set(key, {
        stallId: row.stallId,
        stallNumber: row.stallNumber,
        activeLoad: row.activeLoad || 0,
        autoAccept: Boolean(row.autoAccept),
        stock: new Map(),
        used: false,
      });
    }
    stalls.get(key).stock.set(String(row.product), row.stock);
  }

  /**
   * What this stall could take from what is left.
   *
   * Walks a scratch copy of the declared stock so a stall holding 3kg is
   * credited with covering ONE 2kg line, not two — the same reservation the
   * previous implementation did inline, kept because it is the difference
   * between a plan that works and one that over-commits a single crate.
   */
  function coverageOf(stall, remaining) {
    const scratch = new Map(stall.stock);
    const lineIds = [];
    const take = [];

    for (const line of remaining.values()) {
      const key = String(line.product);
      const available = scratch.get(key) || 0;
      if (available < line.quantity) continue;
      scratch.set(key, available - line.quantity);
      lineIds.push(line.lineId);
      take.push({ product: line.product, quantity: line.quantity });
    }

    return { lineIds, take };
  }

  const remaining = new Map(lines.map((l) => [String(l.lineId), l]));
  const plan = [];

  while (remaining.size > 0 && plan.length < config.marketplace.maxStallsPerOrder) {
    let best = null;

    for (const stall of stalls.values()) {
      if (stall.used) continue;
      const cover = coverageOf(stall, remaining);
      if (cover.lineIds.length === 0) continue;

      if (
        !best ||
        cover.lineIds.length > best.cover.lineIds.length ||
        (cover.lineIds.length === best.cover.lineIds.length &&
          (stall.activeLoad < best.stall.activeLoad ||
            (stall.activeLoad === best.stall.activeLoad &&
              String(stall.stallNumber).localeCompare(String(best.stall.stallNumber), undefined, {
                numeric: true,
              }) < 0)))
      ) {
        best = { stall, cover };
      }
    }

    // Nobody left who can supply anything still outstanding. The remaining
    // lines simply go unoffered this round; the caller decides what that means.
    if (!best) break;

    best.stall.used = true;
    plan.push({
      stallId: best.stall.stallId,
      stallNumber: best.stall.stallNumber,
      autoAccept: best.stall.autoAccept,
      lineIds: best.cover.lineIds,
      take: best.cover.take,
    });

    for (const lineId of best.cover.lineIds) remaining.delete(String(lineId));
  }

  return plan;
}

/**
 * Draw down a stall's declared stock for lines it actually won.
 *
 * Guarded, and deliberately best-effort: if the guard fails the stall's
 * declared figure was stale, but the claim still stands. Declared stock is an
 * availability hint, not a ledger — the produce itself is on a table and the
 * shopkeeper reconciles it. Failing the claim here would leave the line
 * unsourced for a stall that does have the goods.
 */
async function drawDownStock(stallId, take, wonLineIds, lineIds) {
  const wonKeys = new Set(wonLineIds.map(String));
  await Promise.all(
    take
      .filter((_, index) => wonKeys.has(String(lineIds[index])))
      .map((t) =>
        StallInventory.updateOne(
          { stall: stallId, product: t.product, stock: { $gte: t.quantity } },
          { $inc: { stock: -t.quantity } }
        ).catch(() => {})
      )
  );
}

/**
 * Open one round: rank the stalls, then ask them.
 *
 * A round asks SEVERAL stalls at once, each about its own disjoint slice of the
 * order. Asking them one at a time would be more literal but multiplies the
 * customer's wait by the number of stalls needed, for no gain — the slices do
 * not compete, so there is nothing to serialise.
 *
 * A stall with `autoAccept` and the stock declared is claimed for outright
 * rather than offered, which is what keeps a well-stocked market locking in
 * milliseconds exactly as it did before the cascade existed.
 */
async function offerRound(orderId, actorId = null) {
  const order = await Order.findById(orderId).select('items market fulfillment').lean();

  if (!order || !order.market || order.fulfillment?.status !== 'sourcing') {
    return { offered: 0, claimed: 0, promoted: null, reason: 'NOT_SOURCING' };
  }

  const unclaimed = order.items.filter((item) => item.lineId && !item.claim?.stall);
  if (unclaimed.length === 0) {
    return { offered: 0, claimed: 0, promoted: await promoteIfComplete(orderId, actorId) };
  }

  const stallOffer = order.fulfillment.stallOffer || {};
  const round = stallOffer.round || 0;

  // Ranked rounds are spent. Fall through to the market-wide pool rather than
  // cascading for ever — the same backstop the rider dispatch uses.
  if (round >= config.marketplace.maxStallRounds) return openStallPool(orderId);

  const plan = await planRound({
    marketId: order.market,
    lines: unclaimed,
    declinedBy: stallOffer.declinedBy || [],
  });

  // Nobody ranked is left who can supply anything. Straight to the pool: a
  // stall that declared no inventory is invisible to `planRound` but can still
  // answer by hand, and this is where it gets the chance.
  if (plan.length === 0) return openStallPool(orderId);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.marketplace.stallOfferWindowSeconds * 1000);

  /**
   * Claim the round before making any offer.
   *
   * Guarded on the round number we planned against, so two sweeper instances
   * expiring the same order cannot both open a round and double-offer the same
   * lines to different stalls.
   */
  const opened = await Order.findOneAndUpdate(
    {
      _id: orderId,
      'fulfillment.status': 'sourcing',
      'fulfillment.stallOffer.round': round,
    },
    {
      $set: { 'fulfillment.stallOffer.expiresAt': expiresAt },
      $inc: { 'fulfillment.stallOffer.round': 1 },
      $push: {
        'fulfillment.events': eventPush({
          at: now,
          type: 'stall_round_opened',
          note: `round ${round + 1}, ${plan.length} stall(s)`,
        }),
      },
    },
    { returnDocument: 'after' }
  );

  if (!opened) return { offered: 0, claimed: 0, promoted: null, reason: 'RACED' };

  let offered = 0;
  let claimed = 0;
  let promoted = null;

  for (const entry of plan) {
    if (entry.autoAccept) {
      const result = await claimLines({
        orderId,
        stallId: entry.stallId,
        stallNumber: entry.stallNumber,
        lineIds: entry.lineIds,
        auto: true,
        actorId,
      });

      claimed += result.won.length;
      if (result.promoted) promoted = result.promoted;
      await drawDownStock(entry.stallId, entry.take, result.won.map((i) => i.lineId), entry.lineIds);
      continue;
    }

    /**
     * `claim.stall: null` in the arrayFilter, not just the line id: an
     * auto-accepting stall earlier in this same plan may have taken a line a
     * moment ago, and offering an already-claimed line would show a shopkeeper
     * work they cannot actually win.
     */
    const written = await Order.updateOne(
      { _id: orderId, 'fulfillment.status': 'sourcing' },
      {
        $set: {
          'items.$[line].offer.stall': objectId(entry.stallId),
          'items.$[line].offer.offeredAt': now,
        },
      },
      {
        arrayFilters: [
          { 'line.lineId': { $in: entry.lineIds.map(objectId) }, 'line.claim.stall': null },
        ],
      }
    );

    if (written.modifiedCount > 0) offered += 1;
  }

  return { offered, claimed, promoted, round: round + 1, expiresAt };
}

/**
 * Give up on ranking and let any stall in the market take what is left.
 *
 * This is the behaviour the whole market had before the cascade: every
 * approved, open stall sees every unclaimed line. Demoting it to the last tier
 * INSIDE a market — rather than removing it — is what makes hopping to another
 * market rare, which is the point. A stall that never declared its inventory is
 * invisible to `planRound` and would otherwise never be asked at all.
 *
 * Guarded on `openPool: false` so repeated calls cannot keep pushing the
 * deadline out and hold an order in the pool for ever.
 */
async function openStallPool(orderId) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.marketplace.stallOfferWindowSeconds * 1000);

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'sourcing', 'fulfillment.stallOffer.openPool': false },
    {
      $set: {
        'fulfillment.stallOffer.openPool': true,
        'fulfillment.stallOffer.expiresAt': expiresAt,
        'items.$[line].offer.stall': null,
        'items.$[line].offer.offeredAt': null,
      },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'stall_open_pool' }) },
    },
    { arrayFilters: [{ 'line.claim.stall': null }], returnDocument: 'after' }
  );

  return { offered: 0, claimed: 0, promoted: null, openPool: Boolean(updated), order: updated, reason: 'OPEN_POOL' };
}

/**
 * A stall says no. Never ask it again in this market, and move to the next
 * round immediately rather than making everyone wait out the clock.
 */
async function declineRound({ orderId, stallId }) {
  const stall = objectId(stallId);
  const now = new Date();

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'sourcing', 'items.offer.stall': stall },
    {
      $set: { 'items.$[line].offer.stall': null, 'items.$[line].offer.offeredAt': null },
      $addToSet: { 'fulfillment.stallOffer.declinedBy': stall },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'stall_declined', stall }) },
    },
    { arrayFilters: [{ 'line.offer.stall': stall }], returnDocument: 'after' }
  );

  if (!updated) return { declined: false, reason: 'NOT_YOURS' };

  // Straight to the next round. If this was the pool tier there is no next
  // round to open — `offerRound` recognises that and the sweeper finishes it.
  const next = updated.fulfillment?.stallOffer?.openPool ? null : await offerRound(orderId);
  return { declined: true, next };
}

/**
 * The round's clock ran out.
 *
 * Every stall still sitting on an unanswered offer is recorded as having
 * refused. A timeout has to be treated exactly like a decline, or the next
 * round re-offers the same lines to the same unattended phone and the cascade
 * makes no progress at all — the same reasoning as `dispatch.expireOffer`.
 */
async function expireStallRound(orderId) {
  const order = await Order.findById(orderId).select('items fulfillment market').lean();
  if (!order || order.fulfillment?.status !== 'sourcing') return { action: 'skipped' };

  const stallOffer = order.fulfillment.stallOffer || {};
  const expiresAt = stallOffer.expiresAt;
  if (!expiresAt || expiresAt > new Date()) return { action: 'skipped' };

  // A stall may have taken the last line between the timer firing and this
  // running. Promotion is guarded, so asking costs nothing and is the
  // difference between a delivered order and a spurious extra round.
  const promoted = await promoteIfComplete(orderId);
  if (promoted) return { action: 'promoted', order: promoted };

  // The pool was the last tier this market had. Nothing else to try here.
  if (stallOffer.openPool) return exhaustMarket(orderId);

  const silent = [
    ...new Set(
      order.items
        .filter((item) => !item.claim?.stall && item.offer?.stall)
        .map((item) => String(item.offer.stall))
    ),
  ].map(objectId);

  const now = new Date();

  /**
   * Match the exact expiry we read. If another instance already handled this
   * round, our filter no longer matches and we write nothing.
   */
  const released = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'sourcing', 'fulfillment.stallOffer.expiresAt': expiresAt },
    {
      $set: {
        'items.$[line].offer.stall': null,
        'items.$[line].offer.offeredAt': null,
        /**
         * Clearing this is what makes the optimistic lock actually lock.
         *
         * Nothing else in this update touches `expiresAt`, so without it a
         * second instance matching on the same value it read would still match
         * and expire the round a second time — burning two rounds of the
         * market's budget for one lapsed clock. Leaving it null is also safe if
         * the re-offer below fails: the sweeper's unopened-round query picks
         * the order straight back up.
         */
        'fulfillment.stallOffer.expiresAt': null,
      },
      $addToSet: { 'fulfillment.stallOffer.declinedBy': { $each: silent } },
      $push: {
        'fulfillment.events': eventPush({
          at: now,
          type: 'stall_round_expired',
          note: `${silent.length} stall(s) did not answer`,
        }),
      },
    },
    { arrayFilters: [{ 'line.claim.stall': null }], returnDocument: 'after' }
  );

  if (!released) return { action: 'skipped' };

  const next = await offerRound(orderId);
  return { action: 'reoffered', next };
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * A stall marks its own lines bagged.
 *
 * Scoped to lines this stall actually holds — the arrayFilter carries
 * `claim.stall`, so one shopkeeper cannot mark another's lines packed and pull
 * a rider to a stall that has nothing ready.
 */
async function packLines({ orderId, stallId, lineIds }) {
  const stall = objectId(stallId);
  const wanted = lineIds.map((id) => objectId(id));
  const now = new Date();

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'packing' },
    {
      $set: { 'items.$[line].claim.packedAt': now },
      $push: {
        'fulfillment.events': eventPush({ at: now, type: 'lines_packed', stall }),
      },
    },
    {
      arrayFilters: [
        { 'line.lineId': { $in: wanted }, 'line.claim.stall': stall, 'line.claim.packedAt': null },
      ],
      returnDocument: 'after',
    }
  );

  if (!updated) return { order: null, reason: 'NOT_PACKING' };

  const advanced = await advanceWhenFullyPacked(orderId);
  return { order: advanced || updated };
}

/**
 * Everything bagged → either the rider already accepted and is on the way
 * (`collecting`), or nobody has taken it yet (`awaiting_rider`).
 *
 * Two guarded updates rather than a read-and-branch: exactly one can match, so
 * a rider accepting at the same moment as the final pack cannot land the order
 * in the wrong state.
 */
async function advanceWhenFullyPacked(orderId) {
  const allPacked = {
    _id: orderId,
    'fulfillment.status': 'packing',
    items: { $not: { $elemMatch: { 'claim.packedAt': null } } },
  };
  const now = new Date();

  const toCollecting = await Order.findOneAndUpdate(
    { ...allPacked, assignedTo: { $ne: null } },
    {
      $set: transitionTo('collecting'),
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'packed_rider_present' }) },
    },
    { returnDocument: 'after' }
  );
  if (toCollecting) return toCollecting;

  const toWaiting = await Order.findOneAndUpdate(
    { ...allPacked, assignedTo: null },
    {
      $set: transitionTo('awaiting_rider'),
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'packed_awaiting_rider' }) },
    },
    { returnDocument: 'after' }
  );

  if (toWaiting && config.marketplace.riderDispatchOn === 'ready') {
    const dispatch = require('./dispatch');
    fireAndForget(dispatch.offerToNearestRider(toWaiting._id), `rider dispatch for ${toWaiting.orderNumber}`);
  }

  return toWaiting;
}

// ---------------------------------------------------------------------------
// Hopping to the next market, and giving up
// ---------------------------------------------------------------------------

/**
 * The nearest market we have not already asked that can fill the whole order
 * within the price ceiling.
 *
 * Measured from the delivery address when we have its coordinates, and outward
 * from the current market when we do not — a customer who never granted
 * location still gets a sensible second choice rather than none.
 */
async function findNextMarket(order) {
  const tried = (order.fulfillment?.triedMarkets || []).map(objectId);

  let origin = order.deliveryLocation;
  if (!origin?.coordinates?.length) {
    const current = await Market.findById(order.market).select('location').lean();
    origin = current?.location;
  }
  if (!origin?.coordinates?.length) return null;

  const nearby = await Market.aggregate([
    {
      $geoNear: {
        near: origin,
        distanceField: 'distanceMeters',
        maxDistance: config.marketplace.searchRadiusMeters,
        spherical: true,
        query: { isActive: true, isOpen: true, _id: { $nin: tried } },
      },
    },
    { $limit: 10 },
    { $project: { name: 1, distanceMeters: 1 } },
  ]);

  const ceiling = hopPriceCeiling(order.subtotalPaise);

  for (const market of nearby) {
    const priced = await priceLinesAtMarket(market._id, order.items);
    if (!priced) continue;
    if (priced.sourceSubtotalPaise > ceiling) continue;
    return { market, priced };
  }

  return null;
}

/**
 * Hand every claimed line back and drop each stall's busy count accordingly.
 *
 * Called before a hop and before a terminal failure. The counts must come down
 * or a stall that was offered work it never delivered looks permanently busy
 * and stops being picked for auto-accept.
 */
async function releaseClaims(order) {
  const perStall = new Map();
  for (const item of order.items || []) {
    const stall = item.claim?.stall;
    if (!stall) continue;
    const key = String(stall);
    perStall.set(key, (perStall.get(key) || 0) + 1);
  }

  await Promise.all(
    [...perStall.entries()].map(([stallId, count]) =>
      Stall.updateOne({ _id: objectId(stallId) }, { $inc: { activeLoad: -count } }).catch(() => {})
    )
  );

  // Floor at zero. A crash between claim and release can otherwise leave a
  // stall permanently negative, which would make it win every auto-accept race.
  await Promise.all(
    [...perStall.keys()].map((stallId) =>
      Stall.updateOne({ _id: objectId(stallId), activeLoad: { $lt: 0 } }, { $set: { activeLoad: 0 } }).catch(() => {})
    )
  );
}

/**
 * Move the order to a different market and restart the clock.
 *
 * Every claim is cleared and every line is re-priced from the new market's
 * sheet. `unitPricePaise` — what the customer agreed to pay — is deliberately
 * NOT touched. Only `sourcePricePaise` moves, so the stalls in the new market
 * are shown their own prices and can reconcile against their own sheet.
 */
async function hopToMarket(order, market, priced) {
  const now = new Date();

  /**
   * One `$set` key per line, each under its own array-filter identifier.
   *
   * Tempting alternative: clear the claims with the all-positional `items.$[]`
   * and set the prices with `items.$[lN]`. MongoDB rejects that — two update
   * paths both rooted at `items` are treated as conflicting. Giving every line
   * its own identifier keeps each path distinct and the whole thing atomic.
   */
  const set = {
    ...transitionTo('sourcing', {
      market: market._id,
      marketName: market.name,
      'fulfillment.sourcingDeadline': new Date(now.getTime() + config.marketplace.sourcingWindowSeconds * 1000),
      'fulfillment.sourceSubtotalPaise': priced.sourceSubtotalPaise,
      'fulfillment.lockedAt': null,
      /**
       * The cascade starts from nothing in the new market.
       *
       * `declinedBy` in particular MUST be cleared: it holds stall ids from the
       * market we are leaving, and carrying them over would silently bar
       * unrelated stalls here — stall ids are unique across markets, so the
       * filter would not misfire, but the round counter and open-pool flag
       * would, and the order would reach its new market with its budget
       * already spent.
       */
      'fulfillment.stallOffer': emptyStallOffer(),
    }),
  };
  const arrayFilters = [];

  priced.priced.forEach((line, index) => {
    const id = `l${index}`;
    set[`items.$[${id}].sourcePricePaise`] = line.sourcePricePaise;
    set[`items.$[${id}].claim.stall`] = null;
    set[`items.$[${id}].claim.stallNumber`] = null;
    set[`items.$[${id}].claim.claimedAt`] = null;
    set[`items.$[${id}].claim.auto`] = false;
    set[`items.$[${id}].claim.packedAt`] = null;
    set[`items.$[${id}].offer.stall`] = null;
    set[`items.$[${id}].offer.offeredAt`] = null;
    arrayFilters.push({ [`${id}.lineId`]: objectId(line.lineId) });
  });

  const hopped = await Order.findOneAndUpdate(
    { _id: order._id, 'fulfillment.status': 'sourcing' },
    {
      $set: set,
      $inc: { 'fulfillment.attempt': 1 },
      $push: {
        'fulfillment.triedMarkets': market._id,
        'fulfillment.events': eventPush({
          at: now,
          type: 'hopped_to_market',
          market: market._id,
          note: market.name,
        }),
      },
    },
    { arrayFilters, returnDocument: 'after' }
  );

  if (hopped) await offerRound(hopped._id);
  return hopped;
}

/**
 * Put a wallet-paid order's money back.
 *
 * THE ORDER OF THESE TWO STEPS IS THE WHOLE POINT.
 *
 * This runs only AFTER the order has been moved into a terminal state by a
 * guarded update that actually matched. Refunding first — which both this file
 * and the customer-cancel route used to do — is only safe if the state change
 * that follows is certain to succeed, and it is not: a stall can claim the last
 * line in the same millisecond, promoting the order to `packing` so the guard
 * no longer matches. The credit had already landed, so the customer kept the
 * money AND the groceries.
 *
 * Crediting second inverts the failure: a crash between the state change and
 * the credit leaves a cancelled order still marked `paid`, which is visible,
 * bounded, and swept up by `sweepPendingRefunds` rather than silently costing an
 * order's value every time someone taps cancel on a locked order.
 *
 * The key is shared with every other refund path for this order, so a cancel and
 * a sweep racing each other still credit exactly once.
 *
 * No session, deliberately. `wallet.appendEntry` retries a sequence collision up
 * to five times — unless it is inside a transaction, where retrying is futile
 * and it throws WALLET_CONFLICT instead. Wrapping this would turn an ordinary
 * concurrent wallet write into a dead sweeper tick.
 */
async function refundToWallet(order) {
  if (order.paymentMethod !== 'wallet' || order.paymentStatus !== 'paid') {
    return { refunded: false };
  }

  await wallet.credit({
    userId: order.customer,
    amountPaise: order.totalAmountPaise,
    reason: 'order_refund',
    idempotencyKey: `refund:${order._id.toHexString()}`,
    note: `Refund for ${order.orderNumber}`,
    session: null,
  });

  // Guarded on `paid` so a concurrent refunder cannot flip this twice, and so a
  // replayed credit is a no-op here too.
  await Order.updateOne(
    { _id: order._id, paymentStatus: 'paid' },
    { $set: { paymentStatus: 'refunded' } }
  );

  return { refunded: true };
}

/**
 * Nobody can fill this order. Close it, refund, and restock.
 *
 * The close comes first and is guarded on `sourcing`, so an order a stall
 * completed while we were deciding is left alone entirely — no refund, no
 * restock, no status change.
 */
async function failOrder(order, note = 'No market could source this order.') {
  await releaseClaims(order);

  const now = new Date();
  // COD never took money, so there is nothing to give back — the payment simply
  // never happens. A wallet refund is settled below, once the close has stuck.
  const paymentStatus = order.paymentMethod === 'cod' ? 'failed' : order.paymentStatus;

  const failed = await Order.findOneAndUpdate(
    { _id: order._id, 'fulfillment.status': 'sourcing' },
    {
      $set: transitionTo('failed', { paymentStatus }),
      $push: {
        statusHistory: { status: 'Cancelled', at: now, by: null },
        'fulfillment.events': eventPush({ at: now, type: 'sourcing_failed', note }),
      },
    },
    { returnDocument: 'after' }
  );

  // A stall took the last line between our decision and this write. The order is
  // alive and on its way; touching the money or the stock now would corrupt it.
  if (!failed) return null;

  await refundToWallet(failed);

  // The catalog was decremented at checkout; put it back regardless of which
  // lines a stall had committed to, because none of it ever left a table.
  await Promise.all(
    (failed.items || []).map((item) =>
      Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }).catch(() => {})
    )
  );

  return Order.findById(failed._id);
}

/**
 * This market has nothing left to offer: the ranked rounds are spent and the
 * open pool has closed. Decide what happens to the order.
 *
 * The split here is the whole reason a partial fill exists. If NOTHING was
 * claimed, the market simply could not help and the order moves on — the
 * original behaviour, untouched. If SOME lines were claimed, hopping would
 * throw that progress away and restart the clock somewhere else, so instead the
 * customer is asked whether a smaller order is worth having.
 */
async function exhaustMarket(orderId) {
  const order = await Order.findById(orderId);
  if (!order || order.fulfillment?.status !== 'sourcing') return { action: 'skipped' };

  const claimed = order.items.filter((item) => item.claim?.stall).length;
  if (claimed > 0) return openPartialReview(order);

  if (order.fulfillment.attempt >= config.marketplace.maxSourcingAttempts) {
    const failed = await failOrder(order, 'Ran out of markets to try.');
    return { action: 'failed', order: failed };
  }

  const next = await findNextMarket(order);
  if (!next) {
    const failed = await failOrder(order, 'No other market nearby can fill this order.');
    return { action: 'failed', order: failed };
  }

  await releaseClaims(order);
  const hopped = await hopToMarket(order, next.market, next.priced);
  return hopped ? { action: 'hopped', order: hopped, market: next.market } : { action: 'skipped' };
}

/**
 * Hold the order and ask the customer: some of this is available, some is not.
 *
 * The claims are deliberately KEPT. Those stalls have produce set aside, and
 * releasing it while we wait would mean re-sourcing from scratch if the answer
 * turns out to be yes — which is the likely answer.
 */
async function openPartialReview(order) {
  const now = new Date();
  const missing = order.items.filter((item) => !item.claim?.stall).length;

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, 'fulfillment.status': 'sourcing' },
    {
      $set: transitionTo('partial_review', {
        'fulfillment.partialDeadline': new Date(
          now.getTime() + config.marketplace.partialDecisionWindowSeconds * 1000
        ),
        'fulfillment.stallOffer.expiresAt': null,
        'items.$[line].offer.stall': null,
        'items.$[line].offer.offeredAt': null,
      }),
      $push: {
        'fulfillment.events': eventPush({
          at: now,
          type: 'partial_review_opened',
          note: `${missing} line(s) unfilled`,
        }),
      },
    },
    { arrayFilters: [{ 'line.claim.stall': null }], returnDocument: 'after' }
  );

  return { action: 'partial', order: updated };
}

/**
 * The customer will take what is available (or said nothing and the clock ran
 * out, which is treated the same way — they have already waited through a full
 * sourcing attempt, and cancelling on them turns a mostly-successful order into
 * nothing at all).
 *
 * The unfilled lines are moved to `fulfillment.droppedItems` rather than
 * deleted, and their value comes back.
 */
async function acceptPartial(orderId, actorId = null) {
  const order = await Order.findById(orderId);
  if (!order || order.fulfillment?.status !== 'partial_review') {
    return { accepted: false, reason: 'NOT_PARTIAL' };
  }

  const dropped = order.items.filter((item) => !item.claim?.stall);
  const kept = order.items.filter((item) => item.claim?.stall);

  // Cannot happen from `exhaustMarket`, which only opens a review when at least
  // one line is claimed — but an order with no items at all would violate the
  // schema's 1-100 validator, so it is worth refusing explicitly.
  if (kept.length === 0) return { accepted: false, reason: 'NOTHING_CLAIMED' };

  const droppedValuePaise = dropped.reduce((sum, item) => sum + item.lineTotalPaise, 0);
  const subtotalPaise = kept.reduce((sum, item) => sum + item.lineTotalPaise, 0);

  /**
   * Only money already taken comes back. A COD order has paid nothing yet, so
   * there is nothing to refund — the total simply drops and less is collected
   * at the door.
   */
  const refundPaise = order.paymentStatus === 'paid' ? droppedValuePaise : 0;

  /**
   * The delivery fee is NOT recomputed.
   *
   * It is waived above a subtotal threshold, so recalculating it on a smaller
   * basket could ADD a fee the customer never agreed to — charging them more
   * because we failed to supply what they ordered. It stays exactly as quoted.
   */
  const totalAmountPaise = subtotalPaise + order.deliveryFeePaise;
  const now = new Date();

  /**
   * One guarded update does the whole thing, so a customer tapping twice — or
   * tapping at the moment the sweeper fires — resolves to exactly one winner.
   * The loser's `partial_review` filter no longer matches and it writes nothing.
   *
   * `$pull` on `items` and `$push` on `fulfillment.droppedItems` are distinct
   * paths, so they do not trip MongoDB's conflicting-update-path rule.
   */
  const settled = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'partial_review' },
    {
      $set: transitionTo('packing', {
        subtotalPaise,
        totalAmountPaise,
        'fulfillment.lockedAt': now,
        'fulfillment.partialDeadline': null,
        'fulfillment.sourceSubtotalPaise': kept.reduce(
          (sum, item) => sum + (item.sourcePricePaise ?? item.unitPricePaise) * item.quantity,
          0
        ),
      }),
      $pull: { items: { 'claim.stall': null } },
      $push: {
        'fulfillment.droppedItems': {
          $each: dropped.map((item) => ({
            product: item.product,
            name: item.name,
            quantity: item.quantity,
            lineTotalPaise: item.lineTotalPaise,
            refundedPaise: order.paymentStatus === 'paid' ? item.lineTotalPaise : 0,
            at: now,
          })),
        },
        statusHistory: { status: 'Preparing', at: now, by: actorId },
        'fulfillment.events': eventPush({
          at: now,
          type: 'partial_accepted',
          note: `${kept.length} kept, ${dropped.length} dropped`,
        }),
      },
    },
    { returnDocument: 'after' }
  );

  if (!settled) return { accepted: false, reason: 'RACED' };

  /**
   * Refund after winning the guard, never before: the other thing a customer
   * can do from this screen is ask to try another market, and crediting first
   * would refund lines that then get sourced somewhere else.
   *
   * `refundedPaise` is written on the dropped lines above, so an order whose
   * process died in this gap is identifiable after the fact rather than
   * silently short-paying someone.
   */
  if (refundPaise > 0) {
    await wallet
      .credit({
        userId: settled.customer,
        amountPaise: refundPaise,
        reason: 'order_refund',
        // Distinct from the full-refund key used by `failOrder` and cancel, so
        // a partial followed by a cancellation pays out both, exactly once each.
        idempotencyKey: `refund:${settled._id.toHexString()}:partial`,
        note: `${dropped.length} unavailable item(s) from ${settled.orderNumber}`,
        session: null,
      })
      .catch((err) => console.warn(`[sourcing] partial refund for ${settled.orderNumber}: ${err.message}`));
  }

  // Put the dropped produce back on the shelf — it was decremented at checkout.
  await Promise.all(
    dropped.map((item) =>
      Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }).catch(() => {})
    )
  );

  if (config.marketplace.riderDispatchOn === 'packing') {
    const dispatch = require('./dispatch');
    fireAndForget(dispatch.offerToNearestRider(settled._id), `rider dispatch for ${settled.orderNumber}`);
  }

  return { accepted: true, order: settled, refundPaise, dropped: dropped.length };
}

/**
 * The customer would rather we looked somewhere else.
 *
 * Everything claimed here is handed back — those stalls are released, not left
 * holding produce for an order that has moved on — and the order re-enters
 * sourcing in the next market with a fresh cascade.
 */
async function retryPartial(orderId) {
  const order = await Order.findById(orderId);
  if (!order || order.fulfillment?.status !== 'partial_review') {
    return { retried: false, reason: 'NOT_PARTIAL' };
  }

  if (order.fulfillment.attempt >= config.marketplace.maxSourcingAttempts) {
    return { retried: false, reason: 'NO_ATTEMPTS_LEFT' };
  }

  const next = await findNextMarket(order);
  if (!next) return { retried: false, reason: 'NO_MARKET' };

  /**
   * Back to `sourcing` before hopping, because `hopToMarket` is guarded on that
   * state — it is written for an order whose window expired, not one parked in
   * review. Guarded on `partial_review` so this cannot race the accept path.
   */
  const reopened = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'partial_review' },
    {
      $set: transitionTo('sourcing', { 'fulfillment.partialDeadline': null }),
      $push: { 'fulfillment.events': eventPush({ at: new Date(), type: 'partial_retried' }) },
    },
    { returnDocument: 'after' }
  );

  if (!reopened) return { retried: false, reason: 'RACED' };

  await releaseClaims(reopened);
  const hopped = await hopToMarket(reopened, next.market, next.priced);
  return hopped
    ? { retried: true, order: hopped, market: next.market }
    : { retried: false, reason: 'RACED' };
}

/**
 * The customer never answered. Send what we have.
 *
 * Leases the deadline first so two instances cannot both settle the order; the
 * accept path is idempotent anyway, but the lease keeps the ledger warning in
 * `acceptPartial` from firing spuriously.
 */
async function expirePartialReview(orderId) {
  const order = await Order.findById(orderId).select('fulfillment.status fulfillment.partialDeadline').lean();
  if (!order || order.fulfillment?.status !== 'partial_review') return { action: 'skipped' };

  const seen = order.fulfillment.partialDeadline;
  if (!seen || seen > new Date()) return { action: 'skipped' };

  const leased = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'partial_review', 'fulfillment.partialDeadline': seen },
    { $set: { 'fulfillment.partialDeadline': new Date(Date.now() + SWEEP_LEASE_MS) } },
    { returnDocument: 'after' }
  );
  if (!leased) return { action: 'skipped' };

  const result = await acceptPartial(orderId);
  return result.accepted ? { action: 'partial_auto_accepted', order: result.order } : { action: 'skipped' };
}

/**
 * The absolute ceiling on one market ran out.
 *
 * This is a BACKSTOP, not the normal path — `expireStallRound` drives the
 * cascade, and an order reaching this point means its round bookkeeping stalled
 * somehow. Rather than guess at what went wrong, treat the market as spent and
 * take the ordinary hop-or-partial decision.
 *
 * Claiming the work is an optimistic lock on the deadline we read: the first
 * sweeper to push it forward owns this order, and any other instance matching
 * on the old value writes nothing and moves on. If this process dies
 * mid-decision, the extended lease expires and the next sweep retries.
 */
async function expireSourcing(orderId) {
  const order = await Order.findById(orderId);
  if (!order || order.fulfillment?.status !== 'sourcing') return { action: 'skipped' };

  const seenDeadline = order.fulfillment.sourcingDeadline;

  const leased = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'sourcing', 'fulfillment.sourcingDeadline': seenDeadline },
    { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() + SWEEP_LEASE_MS) } },
    { returnDocument: 'after' }
  );
  if (!leased) return { action: 'skipped' };

  // A stall may have taken the last line in the moment between the timer firing
  // and this running. Promotion is guarded, so asking costs nothing and is the
  // difference between a delivered order and a spurious hop.
  const promoted = await promoteIfComplete(orderId);
  if (promoted) return { action: 'promoted', order: promoted };

  return exhaustMarket(orderId);
}

module.exports = {
  settlePending,
  priceLinesAtMarket,
  hopPriceCeiling,
  initialFulfillment,
  emptyClaim,
  emptyOffer,
  emptyStallOffer,
  claimLines,
  promoteIfComplete,
  planRound,
  offerRound,
  openStallPool,
  declineRound,
  expireStallRound,
  packLines,
  advanceWhenFullyPacked,
  findNextMarket,
  releaseClaims,
  hopToMarket,
  refundToWallet,
  failOrder,
  exhaustMarket,
  openPartialReview,
  acceptPartial,
  retryPartial,
  expirePartialReview,
  expireSourcing,
};
