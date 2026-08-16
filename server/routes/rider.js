'use strict';

const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const RiderBankDetails = require('../models/RiderBankDetails');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { riderLocationLimiter, riderBankDetailsLimiter } = require('../middleware/rateLimit');
const dispatch = require('../services/dispatch');

const router = express.Router();

const riderGate = [requireAuth, requireRole('delivery', 'developer')];

/** Metres between two [lng, lat] GeoJSON points, or null if either is missing. */
function metresBetween(a, b) {
  if (!a?.coordinates?.length || !b?.coordinates?.length) return null;

  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const [lng1, lat1] = a.coordinates;
  const [lng2, lat2] = b.coordinates;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Words that introduce a specific unit rather than name a place. */
const UNIT_WORDS = new Set([
  'flat', 'plot', 'house', 'door', 'apt', 'apartment',
  'no', 'hno', 'shop', 'villa', 'block', 'survey',
]);

/**
 * Roughly where the order is going, without saying which door.
 *
 * Two steps, because neither alone is enough.
 *
 * Dropping the first comma-separated component is the obvious rule and it is
 * wrong often: Indian addresses are written both as "Flat 4B, Banjara Hills,
 * Hyderabad" — where it works — and as "12 Banjara Hills, Hyderabad", where the
 * number and the locality share a component, so dropping it throws away the
 * locality and leaves the bare city. "Hyderabad" tells a rider nothing.
 *
 * So the door is stripped at the token level — leading words that carry a digit,
 * or that announce a unit — and only then is the result narrowed to the last two
 * components, which is locality and city in the overwhelming majority of Indian
 * addresses. The raw address is never returned by either path.
 */
function coarseArea(address) {
  const parts = String(address || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  const words = parts[0].split(/\s+/);
  let cut = 0;
  while (cut < words.length) {
    const word = words[cut].toLowerCase().replace(/[.#,]/g, '');
    if (!/\d/.test(words[cut]) && !UNIT_WORDS.has(word)) break;
    cut += 1;
  }

  const head = words.slice(cut).join(' ').trim();
  const rest = head ? [head, ...parts.slice(1)] : parts.slice(1);

  // An address that was nothing but a number leaves nothing safe to say.
  if (rest.length === 0) return null;

  return rest.slice(-2).join(', ').slice(0, 80);
}

/** The traders behind one order's claims, keyed by id for buildPickupList. */
async function stallsFor(order) {
  const ids = (order.items || []).map((item) => item.claim?.stall).filter(Boolean);
  if (ids.length === 0) return new Map();

  const stalls = await Stall.find({ _id: { $in: ids } }).select('name contactPhone').lean();
  return new Map(stalls.map((s) => [String(s._id), s]));
}

/**
 * Shape an order for the rider.
 *
 * TWO SHAPES, AND WHY
 *
 * The rider is the one role that legitimately needs the customer's name, phone
 * and door — but only the rider who is actually bringing the order. An offer
 * cascades through up to four riders and can then sit in an open pool visible
 * to every rider on duty, so returning the full record on an offer handed the
 * customer's home address and phone number to a queue of people, most of whom
 * decline and none of whom needed it to decide.
 *
 * `offer` therefore carries what the decision actually rests on — which market,
 * how many stalls, how far the drop is, and whether there is cash to collect —
 * and `assigned` carries the rest. This is the same line the codebase already
 * draws for stalls, which are never shown the customer at all.
 */
function forRider(order, { market, stalls, scope = 'assigned' } = {}) {
  const pickups = dispatch.buildPickupList(order, stalls);
  const marketPoint = market?.location || null;

  const base = {
    id: String(order._id),
    orderNumber: order.orderNumber,
    status: order.fulfillment?.status,
    marketName: order.marketName,
    marketAddress: market?.address || null,
    marketLat: marketPoint?.coordinates?.[1] ?? null,
    marketLng: marketPoint?.coordinates?.[0] ?? null,
    stallCount: pickups.length,
    // How much there is to carry, which is part of judging a job on a bike.
    itemCount: (order.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0),
    // Cash to collect, or nothing to handle. Relevant before accepting.
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    totalAmountPaise: order.totalAmountPaise,
    offerExpiresAt: order.fulfillment?.riderOffer?.expiresAt || null,
  };

  if (scope === 'offer') {
    return {
      ...base,
      /**
       * Deliberately not `pickups`: the round is a list of which stalls hold
       * what, and it is only useful once you are walking it. The count is the
       * part that informs the decision.
       */
      dropoffArea: coarseArea(order.address),
      dropoffDistanceMeters: metresBetween(marketPoint, order.deliveryLocation),
    };
  }

  return {
    ...base,
    // The round, already in walking order by stall number.
    pickups,
    allPacked: pickups.every((p) => p.lines.every((l) => l.packedAt)),
    customerName: order.customerName,
    phone: order.phone,
    address: order.address,
    deliveryLat: order.deliveryLocation?.coordinates?.[1] ?? null,
    deliveryLng: order.deliveryLocation?.coordinates?.[0] ?? null,
    dropoffDistanceMeters: metresBetween(marketPoint, order.deliveryLocation),
  };
}

/**
 * Position heartbeat.
 *
 * The whole dispatch engine rests on this: an offer goes to the rider nearest
 * the market, and a rider with no recent position is treated as gone regardless
 * of what their duty status claims. The delivery app has been running
 * `watchPosition` while online all along and simply never sent the result.
 */
router.post(
  '/location',
  ...riderGate,
  riderLocationLimiter,
  validate({
    body: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .strict(),
  }),
  async (req, res) => {
    const { lat, lng } = req.valid.body;

    await User.updateOne(
      { _id: req.user._id },
      {
        $set: {
          'rider.lastLocation': { type: 'Point', coordinates: [lng, lat] },
          'rider.lastLocationAt': new Date(),
        },
      }
    );

    return res.json({ data: { ok: true } });
  }
);

/** Go on or off duty. Going offline does not abandon an order already accepted. */
router.patch(
  '/duty',
  ...riderGate,
  validate({ body: z.object({ dutyStatus: z.enum(['online', 'offline']) }).strict() }),
  async (req, res) => {
    const { dutyStatus } = req.valid.body;

    const active = await Order.countDocuments({
      assignedTo: req.user._id,
      'fulfillment.status': { $in: ['packing', 'awaiting_rider', 'collecting', 'dispatched'] },
    });

    if (dutyStatus === 'offline' && active > 0) {
      throw new ApiError(
        409,
        'Finish or hand back your current delivery before going offline.',
        'DELIVERY_IN_PROGRESS'
      );
    }

    await User.updateOne({ _id: req.user._id }, { $set: { 'rider.dutyStatus': dutyStatus } });
    return res.json({ data: { dutyStatus } });
  }
);

/**
 * What this rider should be looking at: a live offer, anything already
 * accepted, and whatever has fallen through to the open pool.
 */
router.get('/orders', ...riderGate, async (req, res) => {
  const now = new Date();

  const orders = await Order.find({
    'fulfillment.status': { $in: ['packing', 'awaiting_rider', 'collecting', 'dispatched'] },
    $or: [
      { assignedTo: req.user._id },
      { 'fulfillment.riderOffer.rider': req.user._id, 'fulfillment.riderOffer.expiresAt': { $gt: now } },
      { assignedTo: null, 'fulfillment.riderOffer.openPool': true },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(30)
    .lean();

  const markets = await Market.find({ _id: { $in: orders.map((o) => o.market) } })
    .select('address location')
    .lean();
  const byMarket = new Map(markets.map((m) => [String(m._id), m]));

  const mine = (order) => String(order.assignedTo) === String(req.user._id);

  /**
   * Stall details are looked up only for the orders this rider actually holds.
   *
   * An offer does not render the round, so fetching the traders behind a job
   * four other riders might take is both wasted work and a wider read than the
   * response needs.
   */
  const stallIds = orders
    .filter(mine)
    .flatMap((o) => (o.items || []).map((item) => item.claim?.stall))
    .filter(Boolean);

  const stalls = stallIds.length
    ? await Stall.find({ _id: { $in: stallIds } }).select('name contactPhone').lean()
    : [];
  const byStall = new Map(stalls.map((s) => [String(s._id), s]));

  const shaped = orders.map((o) => ({
    ...forRider(o, {
      market: byMarket.get(String(o.market)),
      stalls: byStall,
      // Distinguishes "we picked you" from "anyone can take this", and decides
      // whether the customer's details are in the response at all.
      scope: mine(o) ? 'assigned' : 'offer',
    }),
    kind: mine(o) ? 'assigned' : 'offer',
  }));

  return res.json({
    data: {
      assigned: shaped.filter((o) => o.kind === 'assigned'),
      offers: shaped.filter((o) => o.kind === 'offer'),
    },
  });
});

/**
 * A rider accepts a pickup — either a market cascade offer, or an
 * independent-shop assignment waiting on their confirmation.
 *
 * One route for both, branching on which kind of order this is, so the
 * rider's app never has to know or care which engine is behind a given job —
 * it just taps Accept. The two dispatch functions are otherwise unrelated:
 * the market side hands over the full pickup record, the shop side generates
 * the pickup code the shopkeeper will ask for at the counter.
 */
router.post(
  '/orders/:id/accept',
  ...riderGate,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const orderId = req.valid.params.id;
    const kind = await Order.findById(orderId).select('shop').lean();
    if (!kind) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    if (kind.shop) {
      const result = await dispatch.acceptShopAssignment({ orderId, riderId: req.user._id });
      if (!result.accepted) {
        throw new ApiError(409, 'That pickup is no longer available.', result.reason || 'ASSIGNMENT_GONE');
      }
      return res.json({ data: result.order.toJSON() });
    }

    const result = await dispatch.acceptOffer({ orderId, riderId: req.user._id });
    if (!result.accepted) {
      throw new ApiError(409, 'That pickup is no longer available.', 'OFFER_GONE');
    }

    // Accepting is the moment the full record becomes theirs to see.
    const order = result.order.toJSON();
    const [market, stalls] = await Promise.all([
      Market.findById(order.market).select('address location').lean(),
      stallsFor(order),
    ]);

    return res.json({ data: forRider(order, { market, stalls, scope: 'assigned' }) });
  }
);

/**
 * Turn a pickup down.
 *
 * Same branch as accept above. Either way the refusal is remembered so the
 * cascade never comes back to this rider for this order, and the next
 * nearest is asked immediately rather than after the offer times out.
 */
router.post(
  '/orders/:id/decline',
  ...riderGate,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const orderId = req.valid.params.id;
    const kind = await Order.findById(orderId).select('shop').lean();
    if (!kind) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    const result = kind.shop
      ? await dispatch.declineShopAssignment({ orderId, riderId: req.user._id })
      : await dispatch.declineOffer({ orderId, riderId: req.user._id });

    if (!result.declined) {
      throw new ApiError(409, 'That pickup was not offered to you.', 'NOT_YOURS');
    }
    return res.json({ data: { declined: true } });
  }
);

/**
 * Bags collected from one stall.
 *
 * Ticking the last stall is what sends the order out for delivery — the rider
 * never has to remember a separate "I'm leaving" step.
 */
router.post(
  '/orders/:id/collect',
  ...riderGate,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ stallId: fields.objectId }).strict(),
  }),
  async (req, res) => {
    const result = await dispatch.collectStall({
      orderId: req.valid.params.id,
      riderId: req.user._id,
      stallId: req.valid.body.stallId,
    });

    if (!result.order) {
      throw new ApiError(
        409,
        'Those items are not ready to collect yet.',
        result.reason || 'NOT_COLLECTING'
      );
    }

    const order = result.order.toJSON ? result.order.toJSON() : result.order;
    const [market, stalls] = await Promise.all([
      Market.findById(order.market).select('address location').lean(),
      stallsFor(order),
    ]);

    return res.json({
      data: {
        ...forRider(order, { market, stalls, scope: 'assigned' }),
        dispatched: Boolean(result.dispatched),
      },
    });
  }
);

/**
 * Delivered.
 *
 * A market order's status is derived, so PATCH /orders/:id/status refuses to
 * touch it — this is the completion path for one. Same guarantee as everywhere
 * else: only the assigned rider, and only once the order has actually left the
 * market.
 */
router.post(
  '/orders/:id/deliver',
  ...riderGate,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const result = await dispatch.deliverOrder({
      orderId: req.valid.params.id,
      riderId: req.user._id,
    });

    if (!result.delivered) {
      throw new ApiError(
        result.reason === 'NOT_YOURS' ? 404 : 409,
        result.reason === 'NOT_YOURS'
          ? 'Order not found.'
          : 'That order has not left the market yet.',
        result.reason
      );
    }

    return res.json({ data: result.order.toJSON() });
  }
);

/**
 * Settlement details — where the market office should send this rider's
 * payouts. There is no rider payout ledger in this codebase, so nothing reads
 * this to decide what to pay; it just keeps the details on file. Unlike vendor
 * KYC, there is no penny-drop step: nothing here is unlocked or gated by it.
 */
router.get('/bank-details', ...riderGate, async (req, res) => {
  const details = await RiderBankDetails.findOne({ user: req.user._id });
  return res.json({ data: details ? details.toPublicJSON() : null });
});

/** Submit or replace settlement details. Re-submitting simply overwrites them. */
router.put(
  '/bank-details',
  ...riderGate,
  riderBankDetailsLimiter,
  validate({
    body: z
      .object({
        legalName: fields.nonEmptyString(120),
        bankName: fields.nonEmptyString(120),
        bankAccount: fields.bankAccount,
        ifsc: fields.ifsc,
      })
      .strict(),
  }),
  async (req, res) => {
    const { legalName, bankName, bankAccount, ifsc } = req.valid.body;
    const secrets = RiderBankDetails.buildSecrets({ bankAccount });

    const details = await RiderBankDetails.findOneAndUpdate(
      { user: req.user._id },
      { $set: { legalName, bankName, ifsc, ...secrets } },
      { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    return res.json({ data: details.toPublicJSON() });
  }
);

module.exports = router;
