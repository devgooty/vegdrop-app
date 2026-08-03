'use strict';

const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const Market = require('../models/Market');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { riderLocationLimiter } = require('../middleware/rateLimit');
const dispatch = require('../services/dispatch');

const router = express.Router();

const riderGate = [requireAuth, requireRole('delivery', 'developer')];

/**
 * Shape an order for the rider: where to go, which stalls, and who to hand it
 * to. This is the one role that legitimately needs the customer's details.
 */
function forRider(order, { market } = {}) {
  const pickups = dispatch.buildPickupList(order);

  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    status: order.fulfillment?.status,
    marketName: order.marketName,
    marketAddress: market?.address || null,
    marketLat: market?.location?.coordinates?.[1] ?? null,
    marketLng: market?.location?.coordinates?.[0] ?? null,
    // The round, already in walking order by stall number.
    pickups,
    stallCount: pickups.length,
    allPacked: pickups.every((p) => p.lines.every((l) => l.packedAt)),
    customerName: order.customerName,
    phone: order.phone,
    address: order.address,
    deliveryLat: order.deliveryLocation?.coordinates?.[1] ?? null,
    deliveryLng: order.deliveryLocation?.coordinates?.[0] ?? null,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    totalAmountPaise: order.totalAmountPaise,
    offerExpiresAt: order.fulfillment?.riderOffer?.expiresAt || null,
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

  const shaped = orders.map((o) => ({
    ...forRider(o, { market: byMarket.get(String(o.market)) }),
    // Distinguishes "we picked you" from "anyone can take this".
    kind: String(o.assignedTo) === String(req.user._id) ? 'assigned' : 'offer',
  }));

  return res.json({
    data: {
      assigned: shaped.filter((o) => o.kind === 'assigned'),
      offers: shaped.filter((o) => o.kind === 'offer'),
    },
  });
});

router.post(
  '/orders/:id/accept',
  ...riderGate,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const result = await dispatch.acceptOffer({ orderId: req.valid.params.id, riderId: req.user._id });

    if (!result.accepted) {
      throw new ApiError(409, 'That pickup is no longer available.', 'OFFER_GONE');
    }

    const market = await Market.findById(result.order.market).select('address location').lean();
    return res.json({ data: forRider(result.order.toJSON(), { market }) });
  }
);

/**
 * Turn a pickup down.
 *
 * The refusal is remembered so the cascade never comes back to this rider for
 * this order, and the next nearest is asked immediately rather than after the
 * offer times out.
 */
router.post(
  '/orders/:id/decline',
  ...riderGate,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const result = await dispatch.declineOffer({ orderId: req.valid.params.id, riderId: req.user._id });
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
    const market = await Market.findById(order.market).select('address location').lean();

    return res.json({
      data: { ...forRider(order, { market }), dispatched: Boolean(result.dispatched) },
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

module.exports = router;
