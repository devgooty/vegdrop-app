'use strict';

const mongoose = require('mongoose');
const config = require('../config/env');
const Order = require('../models/Order');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const { transitionTo } = require('../utils/orderStatus');
const handover = require('./handover');

/**
 * Rider dispatch: getting somebody to the market to carry the order away.
 *
 * The offer cascades. One rider is asked at a time, nearest first, with a short
 * deadline; a refusal or a timeout moves it to the next nearest. That is
 * deliberate — broadcasting to every rider at once produces a scramble where
 * four riders ride to the same market and three waste the trip.
 *
 * After `riderMaxOffers` the cascade gives up and drops the order into an open
 * pool that any rider may claim. Without that backstop, an order in a thinly
 * covered area could cascade through every rider and then sit for ever.
 *
 * Like sourcing.js, every state change here is one conditional
 * `findOneAndUpdate`. Two riders tapping accept at the same instant resolve to
 * one winner because the loser's `assignedTo: null` no longer matches.
 */

const EVENT_CAP = 50;

/** States where a rider is wanted: packing (ride over while stalls bag) or fully packed. */
const OFFERABLE = Object.freeze(['packing', 'awaiting_rider']);

function objectId(value) {
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
}

function eventPush(event) {
  return { $each: [event], $slice: -EVENT_CAP };
}

/**
 * Riders whose last ping is older than this are treated as gone.
 *
 * Duty status alone is not enough: an app killed by the OS never gets to set
 * itself offline, and an offer sent to a phone in someone's pocket at home is
 * `riderOfferTimeoutSeconds` of pure delay for the customer.
 */
function freshnessCutoff() {
  return new Date(Date.now() - config.marketplace.riderStaleLocationSeconds * 1000);
}

/**
 * Find the nearest on-duty rider to a market, skipping anyone who already said
 * no to this order.
 */
async function findNearestRider({ marketLocation, excludeIds }) {
  const riders = await User.aggregate([
    {
      $geoNear: {
        near: marketLocation,
        distanceField: 'distanceMeters',
        maxDistance: config.marketplace.riderSearchRadiusMeters,
        spherical: true,
        key: 'rider.lastLocation',
        query: {
          role: 'delivery',
          status: 'active',
          /**
           * The load-bearing half of the rider gate.
           *
           * Delivery is self-registerable, so `role: 'delivery'` on its own
           * means only "someone proved a phone number". An offer carries the
           * customer's name, phone and home address, and on a COD order their
           * cash — so the question this query has to answer is not "is anyone
           * nearby" but "is anyone nearby that a human has cleared".
           *
           * Checked HERE as well as on the duty-status write, and not only
           * there. That write is the door a rider walks through; this is the
           * one dispatch actually reads. A rider approved, set online, and then
           * rejected would otherwise keep receiving offers until they happened
           * to toggle their own switch — the same reasoning that has
           * middleware/auth.js re-read role and status on every request rather
           * than trusting a token.
           */
          'rider.approvalStatus': 'approved',
          'rider.dutyStatus': 'online',
          'rider.lastLocationAt': { $gte: freshnessCutoff() },
          _id: { $nin: excludeIds.map(objectId) },
        },
      },
    },
    { $limit: 1 },
    { $project: { _id: 1, name: 1, distanceMeters: 1 } },
  ]);

  return riders[0] || null;
}

/**
 * Offer the pickup to the nearest rider who has not already refused it.
 *
 * Safe to call repeatedly: the guard refuses to overwrite an offer that is
 * still live, so a sweeper tick racing a decline cannot silently steal the
 * order from a rider who is mid-decision.
 */
async function offerToNearestRider(orderId) {
  const order = await Order.findById(orderId)
    .select('market assignedTo fulfillment orderNumber')
    .lean();

  if (!order) return { offered: false, reason: 'NOT_FOUND' };
  if (!OFFERABLE.includes(order.fulfillment?.status)) return { offered: false, reason: 'NOT_OFFERABLE' };
  if (order.assignedTo) return { offered: false, reason: 'ALREADY_ASSIGNED' };

  const offer = order.fulfillment.riderOffer || {};

  if (offer.count >= config.marketplace.riderMaxOffers) {
    return openToPool(orderId);
  }

  const market = await Market.findById(order.market).select('location name').lean();
  if (!market?.location?.coordinates?.length) return { offered: false, reason: 'MARKET_HAS_NO_LOCATION' };

  const declined = offer.declinedBy || [];
  const rider = await findNearestRider({ marketLocation: market.location, excludeIds: declined });

  if (!rider) {
    /**
     * Nobody left to ask.
     *
     * Two very different situations share this branch, and telling them apart
     * is what makes the open-pool backstop actually reachable.
     *
     * If somebody HAS been asked and refused, the cascade is exhausted and the
     * pool is the fallback it was written to be. The `count >= riderMaxOffers`
     * check above cannot get us here on its own: every rider who declines or
     * times out is added to `declinedBy` and excluded from then on, so `count`
     * only reaches four when four DISTINCT riders are in range. In a thinly
     * covered area — one rider, who let the offer lapse — the count froze at
     * one, the only candidate was excluded for ever, and the order sat until
     * the sourcing window expired. That is precisely the case the pool exists
     * for, and it was the one case the pool could never be reached in.
     *
     * If nobody has been asked at all, no rider is online yet. Opening the pool
     * then would throw away the nearest-first ordering for nothing, so this
     * stays a non-failure and the sweeper asks again next tick.
     */
    if (declined.length > 0) return openToPool(orderId);
    return { offered: false, reason: 'NO_RIDER_AVAILABLE' };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.marketplace.riderOfferTimeoutSeconds * 1000);

  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      'fulfillment.status': { $in: OFFERABLE },
      assignedTo: null,
      // Do not trample a live offer.
      $or: [
        { 'fulfillment.riderOffer.expiresAt': null },
        { 'fulfillment.riderOffer.expiresAt': { $lte: now } },
      ],
    },
    {
      $set: {
        'fulfillment.riderOffer.rider': rider._id,
        'fulfillment.riderOffer.expiresAt': expiresAt,
      },
      $inc: { 'fulfillment.riderOffer.count': 1 },
      $push: {
        'fulfillment.events': eventPush({
          at: now,
          type: 'rider_offered',
          rider: rider._id,
          note: `${Math.round(rider.distanceMeters)}m away`,
        }),
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) return { offered: false, reason: 'RACED' };
  return { offered: true, rider, order: updated };
}

/**
 * Give up on cascading and let any rider take it.
 *
 * The order stays visible to every on-duty rider until one claims it, rather
 * than being silently stuck behind a cascade that has run out of candidates.
 */
async function openToPool(orderId) {
  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, assignedTo: null, 'fulfillment.status': { $in: OFFERABLE } },
    {
      $set: {
        'fulfillment.riderOffer.openPool': true,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
      },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'rider_open_pool' }) },
    },
    { returnDocument: 'after' }
  );
  return { offered: false, openPool: Boolean(updated), order: updated, reason: 'OPEN_POOL' };
}

/**
 * A rider takes the job.
 *
 * Accepted either as the named offeree while the offer is live, or by anyone
 * once the order has fallen through to the open pool. `assignedTo: null` in the
 * filter is what makes two simultaneous accepts resolve to one winner.
 */
async function acceptOffer({ orderId, riderId }) {
  const rider = objectId(riderId);
  const now = new Date();

  const claimable = {
    _id: orderId,
    assignedTo: null,
    'fulfillment.status': { $in: OFFERABLE },
    $or: [
      { 'fulfillment.riderOffer.rider': rider, 'fulfillment.riderOffer.expiresAt': { $gt: now } },
      { 'fulfillment.riderOffer.openPool': true },
    ],
  };

  const taken = await Order.findOneAndUpdate(
    claimable,
    {
      $set: {
        assignedTo: rider,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
        'fulfillment.riderOffer.openPool': false,
      },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'rider_accepted', rider }) },
    },
    { returnDocument: 'after' }
  );

  if (!taken) return { accepted: false, reason: 'OFFER_GONE' };

  await User.updateOne({ _id: rider }, { $set: { 'rider.dutyStatus': 'busy' } }).catch(() => {});

  // If the stalls already finished, the rider can start collecting immediately.
  const collecting = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.status': 'awaiting_rider', assignedTo: rider },
    {
      $set: transitionTo('collecting'),
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'collection_started', rider }) },
    },
    { returnDocument: 'after' }
  );

  return { accepted: true, order: collecting || taken };
}

/**
 * A rider says no. Remember it so the cascade never asks them twice, then move
 * straight to the next nearest rather than waiting for the offer to time out.
 */
async function declineOffer({ orderId, riderId }) {
  const rider = objectId(riderId);
  const now = new Date();

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, 'fulfillment.riderOffer.rider': rider, assignedTo: null },
    {
      $set: { 'fulfillment.riderOffer.rider': null, 'fulfillment.riderOffer.expiresAt': null },
      $addToSet: { 'fulfillment.riderOffer.declinedBy': rider },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'rider_declined', rider }) },
    },
    { returnDocument: 'after' }
  );

  if (!updated) return { declined: false, reason: 'NOT_YOURS' };

  const next = await offerToNearestRider(orderId);
  return { declined: true, next };
}

/**
 * The offer timed out. Treated exactly like a decline — a rider who did not
 * answer must not be asked again, or the cascade loops on an unattended phone.
 */
async function expireOffer(orderId) {
  const order = await Order.findById(orderId).select('fulfillment.riderOffer assignedTo fulfillment.status').lean();
  if (!order || order.assignedTo) return { action: 'skipped' };

  const offeree = order.fulfillment?.riderOffer?.rider;
  const expiresAt = order.fulfillment?.riderOffer?.expiresAt;
  if (!offeree || !expiresAt || expiresAt > new Date()) return { action: 'skipped' };

  const now = new Date();
  const released = await Order.findOneAndUpdate(
    {
      _id: orderId,
      assignedTo: null,
      'fulfillment.riderOffer.rider': objectId(offeree),
      // Match the exact expiry we read: if another instance already handled this
      // offer, our filter no longer matches and we do nothing.
      'fulfillment.riderOffer.expiresAt': expiresAt,
    },
    {
      $set: { 'fulfillment.riderOffer.rider': null, 'fulfillment.riderOffer.expiresAt': null },
      $addToSet: { 'fulfillment.riderOffer.declinedBy': objectId(offeree) },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'rider_offer_expired', rider: objectId(offeree) }) },
    },
    { returnDocument: 'after' }
  );

  if (!released) return { action: 'skipped' };

  const next = await offerToNearestRider(orderId);
  return { action: 'reoffered', next };
}

/**
 * The rider's round: which stalls, in what order, holding what.
 *
 * Sorted by stall number so they walk the market once instead of criss-crossing
 * it. This is the whole reason `stallNumber` is denormalised onto the claim.
 *
 * `stalls` is an optional Map of id → stall document. The number alone is enough
 * to find a pitch, but not enough to deal with a problem at one: a rider standing
 * in front of a shuttered stall needs the trader's name and a phone number, and
 * those live on Stall rather than on the claim. Optional rather than required
 * because the number is what the round is *ordered* by and must keep working
 * from the denormalised copy alone — a stall deleted after claiming still has
 * bags with the order's name on them.
 */
function buildPickupList(order, stalls = null) {
  const byStall = new Map();

  for (const item of order.items || []) {
    const stall = item.claim?.stall;
    if (!stall) continue;
    const key = String(stall);
    if (!byStall.has(key)) {
      const record = stalls?.get(key) || null;
      byStall.set(key, {
        stall: key,
        stallNumber: item.claim.stallNumber,
        stallName: record?.name || null,
        stallPhone: record?.contactPhone || null,
        collected: true,
        lines: [],
      });
    }
    const entry = byStall.get(key);
    entry.lines.push({
      lineId: String(item.lineId),
      name: item.name,
      quantity: item.quantity,
      packedAt: item.claim.packedAt,
      collectedAt: item.claim.collectedAt,
    });
    if (!item.claim.collectedAt) entry.collected = false;
  }

  return [...byStall.values()].sort((a, b) =>
    String(a.stallNumber).localeCompare(String(b.stallNumber), undefined, { numeric: true })
  );
}

/**
 * The rider has the bags from one stall.
 *
 * Only the assigned rider can tick a stall off, only lines that stall actually
 * packed, and only with the code THAT stall is showing. When the last stall is
 * ticked the order leaves the market.
 *
 * The order is read first so that a rider who taps collect before anything is
 * packed is told so without spending one of the stall code's attempts on it.
 * The read is not the guard - the conditional update below still is.
 */
async function collectStall({ orderId, riderId, stallId, code }) {
  const rider = objectId(riderId);
  const stall = objectId(stallId);
  const now = new Date();

  const before = await Order.findOne({ _id: orderId, assignedTo: rider, 'fulfillment.status': 'collecting' })
    .select('items.claim')
    .lean();
  const ready = (before?.items || []).some(
    (item) => String(item.claim?.stall) === String(stall) && item.claim?.packedAt && !item.claim?.collectedAt
  );
  if (!ready) return { order: null, reason: 'NOT_COLLECTING' };

  const attempt = await handover.redeem({ orderId, stage: 'pickup', stallId: stall, code });
  if (!attempt.ok) return { order: null, ...attempt };

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, assignedTo: rider, 'fulfillment.status': 'collecting' },
    {
      $set: { 'items.$[line].claim.collectedAt': now },
      $push: {
        'fulfillment.events': eventPush({ at: now, type: 'stall_collected', stall, rider }),
      },
    },
    {
      arrayFilters: [
        { 'line.claim.stall': stall, 'line.claim.packedAt': { $ne: null }, 'line.claim.collectedAt': null },
      ],
      returnDocument: 'after',
    }
  );

  if (!updated) return { order: null, reason: 'NOT_COLLECTING' };

  /**
   * One collect releases everything this stall is holding, so its code is
   * retired now.
   *
   * An order only reaches `collecting` once every line is packed
   * (sourcing.advanceWhenFullyPacked), so the arrayFilter above has just ticked
   * all of this stall's lines. If that ever changes and a stall could hand over
   * in two goes, a second collect would be refused as ALREADY_VERIFIED rather
   * than waved through - it fails closed, which is the right way for it to find
   * out.
   */
  await handover.markRedeemed({ handoverId: attempt.handoverId, riderId: rider });

  /**
   * Release exactly what was just collected.
   *
   * `activeLoad` is counted in LINES — a claim adds one per line — so this has
   * to subtract the same unit. Decrementing once per stall would leave a stall
   * that filled three lines of one order looking permanently two-thirds busy,
   * and it would drift further from the truth with every order it handled,
   * until auto-accept stopped choosing it at all.
   */
  const justCollected = updated.items.filter(
    (item) =>
      String(item.claim?.stall) === String(stall) &&
      item.claim?.collectedAt &&
      item.claim.collectedAt.getTime() === now.getTime()
  ).length;

  if (justCollected > 0) {
    await Stall.updateOne({ _id: stall }, { $inc: { activeLoad: -justCollected } }).catch(() => {});
    // Floor at zero: a crash between claim and collection could otherwise leave
    // a stall negative, which would make it win every auto-accept race for ever.
    await Stall.updateOne({ _id: stall, activeLoad: { $lt: 0 } }, { $set: { activeLoad: 0 } }).catch(() => {});
  }

  const dispatched = await Order.findOneAndUpdate(
    {
      _id: orderId,
      'fulfillment.status': 'collecting',
      assignedTo: rider,
      items: { $not: { $elemMatch: { 'claim.collectedAt': null } } },
    },
    {
      $set: transitionTo('dispatched'),
      $push: {
        statusHistory: { status: 'Out for Delivery', at: now, by: rider },
        'fulfillment.events': eventPush({ at: now, type: 'left_market', rider }),
      },
    },
    { returnDocument: 'after' }
  );

  return { order: dispatched || updated, dispatched: Boolean(dispatched) };
}

/**
 * Handed over at the door.
 *
 * A market order cannot be closed through PATCH /orders/:id/status — that route
 * refuses to touch one by hand, because its status is derived. So completion
 * lives here, where the same guard that protects every other transition applies:
 * only the assigned rider, only from `dispatched`.
 *
 * COD flips to paid at exactly this moment, matching the legacy delivery path.
 *
 * And only with the code the customer is showing. It is checked before the
 * transition, so a wrong code fails before the COD flip and before settlement:
 * no money moves on a delivery the customer has not confirmed.
 */
async function deliverOrder({ orderId, riderId, code }) {
  const rider = objectId(riderId);
  const now = new Date();

  const order = await Order.findOne({ _id: orderId, assignedTo: rider })
    .select('paymentMethod paymentStatus fulfillment.status')
    .lean();
  if (!order) return { delivered: false, reason: 'NOT_YOURS' };
  if (order.fulfillment?.status !== 'dispatched') return { delivered: false, reason: 'NOT_DISPATCHED' };

  const attempt = await handover.redeem({ orderId, stage: 'delivery', code });
  if (!attempt.ok) return { delivered: false, ...attempt };

  const paymentStatus = order.paymentMethod === 'cod' ? 'paid' : order.paymentStatus;

  const delivered = await Order.findOneAndUpdate(
    { _id: orderId, assignedTo: rider, 'fulfillment.status': 'dispatched' },
    {
      $set: transitionTo('delivered', { paymentStatus }),
      $push: {
        statusHistory: { status: 'Delivered', at: now, by: rider },
        'fulfillment.events': eventPush({ at: now, type: 'delivered', rider }),
      },
    },
    { returnDocument: 'after' }
  );

  if (!delivered) return { delivered: false, reason: 'NOT_DISPATCHED' };

  await handover.markRedeemed({ handoverId: attempt.handoverId, riderId: rider });

  /**
   * The customer has the goods, so the stalls have now earned their money.
   *
   * This only records what is owed and starts the hold — nothing reaches a
   * shopkeeper's wallet for another day (see services/settlement.js). Awaited
   * rather than fired off, because it is money, but a failure must not undo a
   * delivery that genuinely happened: the sweeper's backfill catches any order
   * left with `settledAt` unset.
   */
  try {
    await require('./settlement').recordDelivery(delivered._id);
  } catch (err) {
    console.warn(`[dispatch] settlement for ${delivered.orderNumber} deferred: ${err.message}`);
  }

  // Free the rider for the next pickup — but only if this was their last job.
  const stillBusy = await Order.countDocuments({
    assignedTo: rider,
    'fulfillment.status': { $in: ['packing', 'awaiting_rider', 'collecting', 'dispatched'] },
  });
  if (stillBusy === 0) {
    await User.updateOne(
      { _id: rider, 'rider.dutyStatus': 'busy' },
      { $set: { 'rider.dutyStatus': 'online' } }
    ).catch(() => {});
  }

  return { delivered: true, order: delivered };
}

// ---------------------------------------------------------------------------
// Independent-shop dispatch
// ---------------------------------------------------------------------------

/**
 * The same nearest-first idea as the market cascade above, but simpler.
 *
 * A shop order has no accept/decline screen — the delivery app's legacy tab
 * just lists whatever `visibilityFilter` hands it and offers a "Delivered"
 * button, nothing more. So instead of asking, the nearest on-duty rider is
 * handed the job directly: `assignedTo` is set the moment the shopkeeper
 * confirms, which is also what makes the order disappear from every OTHER
 * rider's list — `visibilityFilter`'s open-pool clause only matches
 * `assignedTo: null`.
 *
 * The safety net is a timeout rather than a refusal (see
 * `expireShopOrderAssignment`): if the order is still `Preparing` with the
 * same assignee past the deadline, nobody showed up, and it moves to the next
 * nearest — same cascade depth and open-pool backstop as the market side,
 * reusing the same `fulfillment.riderOffer` fields purely as a clock.
 */
async function offerShopOrderToNearestRider(orderId) {
  const order = await Order.findById(orderId)
    .select('shop assignedTo status fulfillment.riderOffer orderNumber')
    .lean();

  if (!order) return { assigned: false, reason: 'NOT_FOUND' };
  if (!order.shop) return { assigned: false, reason: 'NOT_SHOP_ORDER' };
  if (order.status !== 'Preparing') return { assigned: false, reason: 'NOT_OFFERABLE' };
  if (order.assignedTo) return { assigned: false, reason: 'ALREADY_ASSIGNED' };

  const offer = order.fulfillment?.riderOffer || {};

  if (offer.count >= config.marketplace.riderMaxOffers) {
    return openShopOrderToPool(orderId);
  }

  const shopkeeper = await User.findById(order.shop).select('shop.location').lean();
  const shopLocation = shopkeeper?.shop?.location;
  if (!shopLocation?.coordinates?.length) return { assigned: false, reason: 'SHOP_HAS_NO_LOCATION' };

  const declined = offer.declinedBy || [];
  const rider = await findNearestRider({ marketLocation: shopLocation, excludeIds: declined });

  if (!rider) {
    // Same reasoning as the market side: only fall to the pool once someone
    // has actually been asked and missed it, never on the strength of nobody
    // being online yet.
    if (declined.length > 0) return openShopOrderToPool(orderId);
    return { assigned: false, reason: 'NO_RIDER_AVAILABLE' };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.marketplace.shopRiderAssignTimeoutSeconds * 1000);

  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: 'Preparing',
      assignedTo: null,
    },
    {
      $set: {
        assignedTo: rider._id,
        'fulfillment.riderOffer.rider': rider._id,
        'fulfillment.riderOffer.expiresAt': expiresAt,
      },
      $inc: { 'fulfillment.riderOffer.count': 1 },
      $push: {
        'fulfillment.events': eventPush({
          at: now,
          type: 'rider_assigned',
          rider: rider._id,
          note: `${Math.round(rider.distanceMeters)}m away`,
        }),
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) return { assigned: false, reason: 'RACED' };
  return { assigned: true, rider, order: updated };
}

/**
 * Give up cascading through nearby riders; any on-duty rider may take it from
 * the ordinary claim route, same as a marketless order always could.
 */
async function openShopOrderToPool(orderId) {
  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, assignedTo: null, status: 'Preparing' },
    {
      $set: {
        'fulfillment.riderOffer.openPool': true,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
      },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'rider_open_pool' }) },
    },
    { returnDocument: 'after' }
  );
  return { assigned: false, openPool: Boolean(updated), order: updated, reason: 'OPEN_POOL' };
}

/**
 * The deadline passed with the order still `Preparing` and nobody having
 * actively accepted. Release this rider and try the next nearest — the
 * timeout equivalent of `declineOffer`/`expireOffer` on the market side, just
 * triggered by silence rather than a tap or a lapsed clock on an offer that
 * was never asked in the first place.
 *
 * Guarded on `riderAcceptedAt: null`: once a rider has actually tapped accept
 * they are committed and on their way to the counter — silently
 * reassigning at that point would hand the shop's order to a second rider
 * while the first is already on their way, with no way for either side to
 * know. From here the handoff itself, not this clock, decides what happens
 * next.
 */
async function expireShopOrderAssignment(orderId) {
  const order = await Order.findOne({ _id: orderId, shop: { $ne: null } })
    .select('assignedTo status riderAcceptedAt fulfillment.riderOffer')
    .lean();
  if (!order || order.status !== 'Preparing' || !order.assignedTo || order.riderAcceptedAt) {
    return { action: 'skipped' };
  }

  const rider = order.assignedTo;
  const expiresAt = order.fulfillment?.riderOffer?.expiresAt;
  if (!expiresAt || expiresAt > new Date()) return { action: 'skipped' };

  const now = new Date();
  const released = await Order.findOneAndUpdate(
    {
      _id: orderId,
      assignedTo: rider,
      status: 'Preparing',
      riderAcceptedAt: null,
      // Match the exact deadline just read: if another instance already
      // released this assignment, our filter no longer matches.
      'fulfillment.riderOffer.expiresAt': expiresAt,
    },
    {
      $set: {
        assignedTo: null,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
      },
      $addToSet: { 'fulfillment.riderOffer.declinedBy': rider },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'rider_assignment_expired', rider }) },
    },
    { returnDocument: 'after' }
  );

  if (!released) return { action: 'skipped' };

  const next = await offerShopOrderToNearestRider(orderId);
  return { action: 'reoffered', next };
}

/**
 * The rider taps accept: the moment the nearest-picked candidate becomes a
 * person who has actually agreed to come.
 *
 * No code is generated here any more. The pickup code used to be the RIDER's,
 * minted on this tap and read out to the shop; it is now the SHOP's, shown in
 * the shopkeeper's app and typed by the rider (services/handover.js). A rider
 * is exactly the person who must never be handed it, so nothing on this path
 * touches it.
 */
async function acceptShopAssignment({ orderId, riderId }) {
  const rider = objectId(riderId);
  const now = new Date();

  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      shop: { $ne: null },
      assignedTo: rider,
      status: 'Preparing',
      riderAcceptedAt: null,
    },
    {
      $set: { riderAcceptedAt: now },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'shop_rider_accepted', rider }) },
    },
    { returnDocument: 'after' }
  );

  if (!updated) return { accepted: false, reason: 'ASSIGNMENT_GONE' };

  await User.updateOne({ _id: rider }, { $set: { 'rider.dutyStatus': 'busy' } }).catch(() => {});

  return { accepted: true, order: updated };
}

/**
 * The rider taps decline before ever accepting.
 *
 * Only reachable while `riderAcceptedAt` is still null — once a rider has
 * committed, backing out is a phone call to the shop, not a button in this
 * app, the same line `acceptOffer`'s market-side sibling draws by simply
 * having no decline-after-accept route at all.
 */
async function declineShopAssignment({ orderId, riderId }) {
  const rider = objectId(riderId);
  const now = new Date();

  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      shop: { $ne: null },
      assignedTo: rider,
      status: 'Preparing',
      riderAcceptedAt: null,
    },
    {
      $set: {
        assignedTo: null,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
      },
      $addToSet: { 'fulfillment.riderOffer.declinedBy': rider },
      $push: { 'fulfillment.events': eventPush({ at: now, type: 'shop_rider_declined', rider }) },
    },
    { returnDocument: 'after' }
  );

  if (!updated) return { declined: false, reason: 'NOT_YOURS' };

  const next = await offerShopOrderToNearestRider(orderId);
  return { declined: true, next };
}

/**
 * The rider types in the code the shop is showing, standing at the counter.
 *
 * This is the only thing that moves an independent-shop order from `Preparing`
 * to `Out for Delivery` - routes/orders.js refuses the manual PATCH for every
 * shop order. It used to run the other way round (the rider was shown a code
 * and the SHOPKEEPER typed it), which meant the shopkeeper alone could advance
 * the order once they had heard six digits. Now the shopkeeper cannot move it
 * at all and the rider cannot move it without the shop's code, so a false
 * handover needs both of them.
 *
 * Only the rider the order is assigned to. A rider who reaches the counter
 * before tapping accept has plainly accepted, so `riderAcceptedAt` is stamped
 * here if it is still empty; that is also what an order taken from the open
 * pool through /claim needs, since that path never set it.
 */
async function verifyShopPickup({ orderId, riderId, code }) {
  const rider = objectId(riderId);
  const order = await Order.findOne({ _id: orderId, shop: { $ne: null }, assignedTo: rider })
    .select('status riderAcceptedAt')
    .lean();

  if (!order) return { verified: false, reason: 'NOT_FOUND' };
  if (order.status !== 'Preparing') return { verified: false, reason: 'NOT_PREPARING' };

  const attempt = await handover.redeem({ orderId, stage: 'pickup', code });
  if (!attempt.ok) return { verified: false, ...attempt };

  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, shop: { $ne: null }, assignedTo: rider, status: 'Preparing' },
    {
      $set: { status: 'Out for Delivery', ...(order.riderAcceptedAt ? {} : { riderAcceptedAt: now }) },
      $push: {
        statusHistory: { status: 'Out for Delivery', at: now, by: rider },
        'fulfillment.events': eventPush({ at: now, type: 'pickup_verified', rider }),
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) return { verified: false, reason: 'RACED' };
  await handover.markRedeemed({ handoverId: attempt.handoverId, riderId: rider });
  return { verified: true, order: updated };
}

/**
 * The rider types in the code the customer is showing, at the door, for an
 * order that has no market - an independent shop's, or a legacy one.
 *
 * The market equivalent is `deliverOrder` above. This one replaces the
 * rider's old `PATCH /orders/:id/status -> Delivered`, which routes/orders.js
 * now refuses. Same effects as that PATCH, in the same order: COD flips to paid
 * in the transition write, then a shop is settled.
 *
 * An unassigned order can still be completed and is claimed by doing so, as the
 * PATCH allowed - but the conditional update pins `assignedTo` to what was just
 * read, so two riders cannot both close it.
 */
async function deliverMarketlessOrder({ orderId, riderId, code }) {
  const rider = objectId(riderId);
  const order = await Order.findOne({
    _id: orderId,
    market: null,
    $or: [{ assignedTo: rider }, { assignedTo: null }],
  })
    .select('status paymentMethod assignedTo shop orderNumber')
    .lean();

  if (!order) return { delivered: false, reason: 'NOT_FOUND' };
  if (order.status !== 'Out for Delivery') return { delivered: false, reason: 'NOT_OUT_FOR_DELIVERY' };

  const attempt = await handover.redeem({ orderId, stage: 'delivery', code });
  if (!attempt.ok) return { delivered: false, ...attempt };

  const now = new Date();
  const delivered = await Order.findOneAndUpdate(
    { _id: orderId, market: null, status: 'Out for Delivery', assignedTo: order.assignedTo || null },
    {
      $set: {
        status: 'Delivered',
        assignedTo: rider,
        ...(order.paymentMethod === 'cod' ? { paymentStatus: 'paid' } : {}),
      },
      $push: { statusHistory: { status: 'Delivered', at: now, by: rider } },
    },
    { returnDocument: 'after' }
  );

  if (!delivered) return { delivered: false, reason: 'RACED' };
  await handover.markRedeemed({ handoverId: attempt.handoverId, riderId: rider });

  if (delivered.shop) {
    try {
      await require('./settlement').recordDelivery(delivered._id);
    } catch (err) {
      console.warn(`[dispatch] settlement for ${delivered.orderNumber} deferred: ${err.message}`);
    }
  }

  return { delivered: true, order: delivered };
}

module.exports = {
  OFFERABLE,
  deliverOrder,
  findNearestRider,
  offerToNearestRider,
  openToPool,
  acceptOffer,
  declineOffer,
  expireOffer,
  buildPickupList,
  collectStall,
  offerShopOrderToNearestRider,
  openShopOrderToPool,
  expireShopOrderAssignment,
  acceptShopAssignment,
  declineShopAssignment,
  verifyShopPickup,
  deliverMarketlessOrder,
};
