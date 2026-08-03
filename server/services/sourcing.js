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
    sourcingDeadline: new Date(now + config.marketplace.sourcingWindowSeconds * 1000),
    attempt: 1,
    triedMarkets: [objectId(marketId)],
    lockedAt: null,
    riderOffer: { rider: null, expiresAt: null, count: 0, declinedBy: [], openPool: false },
    events: [{ at: new Date(now), type: 'sourcing_started', market: objectId(marketId) }],
  };
}

/** A fresh, explicitly-null claim. Never leave this implicit — see the note in Order.js. */
function emptyClaim() {
  return { stall: null, stallNumber: null, claimedAt: null, auto: false, packedAt: null, collectedAt: null };
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
async function claimLines({ orderId, stallId, stallNumber, lineIds, auto = false, actorId = null }) {
  const stall = objectId(stallId);
  const wanted = lineIds.map((id) => objectId(id));
  const wantedKeys = new Set(wanted.map(String));

  // Read first purely so we can report accurately. The read is NOT the guard —
  // the guard is the arrayFilter below, which is evaluated by the server at
  // write time and cannot be raced.
  const before = await Order.findById(orderId).select('items.lineId items.claim.stall fulfillment.status').lean();
  if (!before) return { won: [], lost: [], order: null, promoted: null };
  if (before.fulfillment?.status !== 'sourcing') {
    return { won: [], lost: [], order: null, promoted: null, reason: 'NOT_SOURCING' };
  }

  const eligible = before.items.filter(
    (item) => item.lineId && wantedKeys.has(String(item.lineId)) && !item.claim?.stall
  );
  if (eligible.length === 0) {
    return { won: [], lost: [...wantedKeys], order: null, promoted: null, reason: 'ALREADY_TAKEN' };
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
      arrayFilters: [{ 'line.lineId': { $in: wanted }, 'line.claim.stall': null }],
      new: true,
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
    { new: true }
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
// Auto-accept
// ---------------------------------------------------------------------------

/**
 * Answer on behalf of the stalls that opted into answering automatically.
 *
 * Auto-accept fires ONLY where the stall has declared stock covering the line.
 * That declared stock is the whole signal — a stall saying "this is on my table
 * right now", which is what makes answering without a human safe. A stall with
 * auto-accept switched on but no inventory rows simply never fires; it can
 * still accept by hand.
 *
 * Among stalls that qualify, the least busy wins (`activeLoad`), so a market's
 * orders spread across its stalls instead of piling onto whichever stall
 * happens to sort first — and the rider's collection round stays short.
 */
async function runAutoAccept(orderId, actorId = null) {
  const order = await Order.findById(orderId)
    .select('items market fulfillment.status')
    .lean();

  if (!order || !order.market || order.fulfillment?.status !== 'sourcing') {
    return { claimed: 0, promoted: null };
  }

  const unclaimed = order.items.filter((item) => item.lineId && !item.claim?.stall);
  if (unclaimed.length === 0) return { claimed: 0, promoted: null };

  const candidates = await StallInventory.aggregate([
    {
      $match: {
        market: objectId(order.market),
        product: { $in: unclaimed.map((l) => objectId(l.product)) },
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
    { $match: { 'stallDoc.autoAccept': true, 'stallDoc.isOpen': true, 'stallDoc.isActive': true } },
    {
      $project: {
        _id: 0,
        product: 1,
        stock: 1,
        stallId: '$stallDoc._id',
        stallNumber: '$stallDoc.stallNumber',
        activeLoad: '$stallDoc.activeLoad',
      },
    },
  ]);

  if (candidates.length === 0) return { claimed: 0, promoted: null };

  const byProduct = new Map();
  for (const row of candidates) {
    const key = String(row.product);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(row);
  }

  /**
   * Load we are about to add but have not written yet. Without this, every line
   * of a five-line order would be handed to whichever stall was quietest when
   * the round started — the exact pile-up the ranking exists to prevent.
   */
  const pending = new Map();
  const plan = new Map(); // stallId -> { stallNumber, lineIds[], take: [{product, quantity}] }

  for (const line of unclaimed) {
    const pool = (byProduct.get(String(line.product)) || []).filter((c) => c.stock >= line.quantity);
    if (pool.length === 0) continue;

    pool.sort((a, b) => {
      const la = a.activeLoad + (pending.get(String(a.stallId)) || 0);
      const lb = b.activeLoad + (pending.get(String(b.stallId)) || 0);
      if (la !== lb) return la - lb;
      return String(a.stallNumber).localeCompare(String(b.stallNumber));
    });

    const chosen = pool[0];
    const key = String(chosen.stallId);

    if (!plan.has(key)) plan.set(key, { stallId: chosen.stallId, stallNumber: chosen.stallNumber, lineIds: [], take: [] });
    plan.get(key).lineIds.push(line.lineId);
    plan.get(key).take.push({ product: line.product, quantity: line.quantity });

    pending.set(key, (pending.get(key) || 0) + 1);
    // Reflect the reservation locally so a stall holding 3kg is not offered two
    // 2kg lines of the same product in the same pass.
    chosen.stock -= line.quantity;
  }

  let claimed = 0;
  let promoted = null;

  for (const entry of plan.values()) {
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

    /**
     * Draw down declared stock for what was actually won.
     *
     * Guarded, and deliberately best-effort: if the guard fails the stall's
     * declared figure was stale, but the claim still stands. Declared stock is
     * an availability hint that powers auto-accept, not a ledger — the produce
     * itself is on a table, and the shopkeeper reconciles it. Failing the claim
     * here would leave the line unsourced for a stall that does have the goods.
     */
    const wonKeys = new Set(result.won.map((item) => String(item.lineId)));
    await Promise.all(
      entry.take
        .filter((_, index) => wonKeys.has(String(entry.lineIds[index])))
        .map((t) =>
          StallInventory.updateOne(
            { stall: entry.stallId, product: t.product, stock: { $gte: t.quantity } },
            { $inc: { stock: -t.quantity } }
          ).catch(() => {})
        )
    );
  }

  return { claimed, promoted };
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
      new: true,
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
    { new: true }
  );
  if (toCollecting) return toCollecting;

  const toWaiting = await Order.findOneAndUpdate(
    { ...allPacked, assignedTo: null },
    {
      $set: transitionTo('awaiting_rider'),
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'packed_awaiting_rider' }) },
    },
    { new: true }
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
    { arrayFilters, new: true }
  );

  if (hopped) await runAutoAccept(hopped._id);
  return hopped;
}

/**
 * Nobody can fill this order. Refund, restock, and close it.
 *
 * The refund uses the SAME idempotency key as the customer-cancel path
 * (`refund:<orderId>`), which is what makes a cancel and a sweep firing at the
 * same moment safe: whichever arrives first writes the ledger entry, and the
 * second is recognised as a replay and writes nothing. The customer is refunded
 * exactly once, whichever path wins.
 */
async function failOrder(order, note = 'No market could source this order.') {
  await releaseClaims(order);

  /**
   * No session, deliberately.
   *
   * `wallet.appendEntry` retries a sequence collision up to five times — unless
   * it is inside a transaction, where retrying is futile and it throws
   * WALLET_CONFLICT instead. Wrapping this would turn an ordinary concurrent
   * wallet write into a dead sweeper tick.
   */
  if (order.paymentMethod === 'wallet' && order.paymentStatus === 'paid') {
    await wallet.credit({
      userId: order.customer,
      amountPaise: order.totalAmountPaise,
      reason: 'order_refund',
      idempotencyKey: `refund:${order._id.toHexString()}`,
      note: `Refund for ${order.orderNumber}`,
      session: null,
    });
  }

  // The catalog was decremented at checkout; put it back regardless of which
  // lines a stall had committed to, because none of it ever left a table.
  await Promise.all(
    (order.items || []).map((item) =>
      Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }).catch(() => {})
    )
  );

  const now = new Date();
  const paymentStatus =
    order.paymentMethod === 'wallet' && order.paymentStatus === 'paid'
      ? 'refunded'
      : order.paymentMethod === 'cod'
        ? 'failed'
        : order.paymentStatus;

  return Order.findOneAndUpdate(
    { _id: order._id, 'fulfillment.status': 'sourcing' },
    {
      $set: transitionTo('failed', { paymentStatus }),
      $push: {
        statusHistory: { status: 'Cancelled', at: now, by: null },
        'fulfillment.events': eventPush({ at: now, type: 'sourcing_failed', note }),
      },
    },
    { new: true }
  );
}

/**
 * The sourcing window ran out. Hop, or give up.
 *
 * Claiming the work is an optimistic lock on the deadline we read: the first
 * sweeper to push the deadline forward owns this order, and any other instance
 * matching on the old value writes nothing and moves on. If this process dies
 * mid-decision, the extended lease expires and the next sweep retries.
 */
async function expireSourcing(orderId) {
  const order = await Order.findById(orderId);
  if (!order || order.fulfillment?.status !== 'sourcing') return { action: 'skipped' };

  const seenDeadline = order.fulfillment.sourcingDeadline;

  const leased = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'sourcing', 'fulfillment.sourcingDeadline': seenDeadline },
    { $set: { 'fulfillment.sourcingDeadline': new Date(Date.now() + SWEEP_LEASE_MS) } },
    { new: true }
  );
  if (!leased) return { action: 'skipped' };

  // A stall may have taken the last line in the moment between the timer firing
  // and this running. Promotion is guarded, so asking costs nothing and is the
  // difference between a delivered order and a spurious hop.
  const promoted = await promoteIfComplete(orderId);
  if (promoted) return { action: 'promoted', order: promoted };

  if (leased.fulfillment.attempt >= config.marketplace.maxSourcingAttempts) {
    const failed = await failOrder(leased, 'Ran out of markets to try.');
    return { action: 'failed', order: failed };
  }

  const next = await findNextMarket(leased);
  if (!next) {
    const failed = await failOrder(leased, 'No other market nearby can fill this order.');
    return { action: 'failed', order: failed };
  }

  await releaseClaims(leased);
  const hopped = await hopToMarket(leased, next.market, next.priced);
  return hopped ? { action: 'hopped', order: hopped, market: next.market } : { action: 'skipped' };
}

module.exports = {
  settlePending,
  priceLinesAtMarket,
  hopPriceCeiling,
  initialFulfillment,
  emptyClaim,
  claimLines,
  promoteIfComplete,
  runAutoAccept,
  packLines,
  advanceWhenFullyPacked,
  findNextMarket,
  releaseClaims,
  hopToMarket,
  failOrder,
  expireSourcing,
};
