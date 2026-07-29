'use strict';

const express = require('express');
const Order = require('../models/Order');
const StallOrder = require('../models/StallOrder');
const Stall = require('../models/Stall');
const Market = require('../models/Market');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const fulfilment = require('../services/fulfilment');

const router = express.Router();

const RIDER_ROLES = ['delivery', 'developer'];

/**
 * Delivery agent endpoints.
 *
 * A multi-stall order is a multi-stop job: the rider collects from each stall in
 * turn and only then drives to the customer. A single destination is not enough
 * information to do the work, so this route returns an ordered pickup list with
 * a map pin and a stall number for each stop.
 */

/**
 * Where a stall physically is. Falls back to the market centroid when the stall
 * has no pin of its own — a market-level pin plus a stall number is still enough
 * to find it, whereas null coordinates would render no marker at all.
 */
function resolveStallPoint(stall, market) {
  const coords = stall?.location?.coordinates || market?.location?.coordinates || null;
  if (!coords || coords.length !== 2) return { latitude: null, longitude: null, precision: 'none' };
  return {
    latitude: coords[1],
    longitude: coords[0],
    precision: stall?.location?.coordinates ? 'stall' : 'market',
  };
}

/**
 * The rider's job sheet for one order: every stall to visit, in stall-number
 * order, then the customer.
 */
router.get(
  '/orders/:id/route',
  requireAuth,
  requireRole(RIDER_ROLES),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await Order.findById(req.valid.params.id);
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    // A rider sees only their own job, or one still unclaimed.
    const claimedByAnother =
      order.assignedTo && order.assignedTo.toString() !== req.user._id.toHexString();
    if (claimedByAnother && req.user.role !== 'developer') {
      throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
    }

    const [market, stallOrders] = await Promise.all([
      Market.findById(order.market).lean(),
      StallOrder.find({ order: order._id, status: { $in: ['accepted', 'packed', 'picked_up'] } })
        .sort({ stallNumber: 1 })
        .lean(),
    ]);

    const stalls = await Stall.find({ _id: { $in: stallOrders.map((s) => s.stall) } })
      .select('stallNumber name phone location')
      .lean();
    const stallById = new Map(stalls.map((s) => [s._id.toString(), s]));

    const pickups = stallOrders.map((stallOrder, index) => {
      const stall = stallById.get(stallOrder.stall.toString());
      return {
        sequence: index + 1,
        stallOrderId: stallOrder._id.toHexString(),
        stallNumber: stallOrder.stallNumber,
        stallName: stallOrder.stallName,
        phone: stall?.phone || null,
        status: stallOrder.status,
        collected: stallOrder.status === 'picked_up',
        itemCount: stallOrder.items.reduce((sum, i) => sum + i.quantity, 0),
        items: stallOrder.items.map((i) => ({ name: i.name, quantity: i.quantity })),
        ...resolveStallPoint(stall, market),
      };
    });

    return res.json({
      data: {
        orderNumber: order.orderNumber,
        status: order.status,
        market: market
          ? {
              name: market.name,
              address: market.address,
              latitude: market.location?.coordinates?.[1] ?? null,
              longitude: market.location?.coordinates?.[0] ?? null,
            }
          : null,
        pickups,
        pickupsRemaining: pickups.filter((p) => !p.collected).length,
        dropoff: {
          customerName: order.customerName,
          phone: order.phone,
          address: order.address,
          latitude: order.deliveryLocation?.coordinates?.[1] ?? null,
          longitude: order.deliveryLocation?.coordinates?.[0] ?? null,
        },
      },
    });
  }
);

/**
 * Confirm collection from one stall.
 *
 * The vendor reads their 6-digit code to the rider. Requiring it means a rider
 * cannot clear a stop they never visited — the same reason a delivery OTP exists
 * at the customer's door.
 */
router.post(
  '/stall-orders/:id/pickup',
  requireAuth,
  requireRole(RIDER_ROLES),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ pickupCode: fields.otpCode }).strict(),
  }),
  async (req, res) => {
    const stallOrder = await StallOrder.findById(req.valid.params.id).select('+pickupCodeHash');
    if (!stallOrder) throw new ApiError(404, 'Pickup not found.', 'NOT_FOUND');

    const order = await Order.findById(stallOrder.order);
    if (!order) throw new ApiError(404, 'Pickup not found.', 'NOT_FOUND');

    const claimedByAnother =
      order.assignedTo && order.assignedTo.toString() !== req.user._id.toHexString();
    if (claimedByAnother && req.user.role !== 'developer') {
      throw new ApiError(404, 'Pickup not found.', 'NOT_FOUND');
    }

    if (stallOrder.status !== 'packed') {
      throw new ApiError(409, 'This stall has not marked the items packed yet.', 'NOT_PACKED');
    }

    const matches = fulfilment.pickupCodeMatches(
      stallOrder._id.toHexString(),
      req.valid.body.pickupCode,
      stallOrder.pickupCodeHash
    );
    if (!matches) {
      throw new ApiError(400, 'That pickup code is not correct.', 'INVALID_PICKUP_CODE');
    }

    const collected = await StallOrder.findOneAndUpdate(
      { _id: stallOrder._id, status: 'packed' },
      { $set: { status: 'picked_up', pickedUpAt: new Date() } },
      { new: true }
    );
    if (!collected) throw new ApiError(409, 'This pickup was already recorded.', 'ALREADY_COLLECTED');

    // The rider only leaves the market once every bag is aboard.
    const siblings = await StallOrder.find({ order: order._id }).select('status').lean();
    const remaining = siblings.filter((s) => !['picked_up', 'cancelled', 'rejected'].includes(s.status)).length;

    if (remaining === 0) {
      await Order.findOneAndUpdate(
        { _id: order._id, status: { $in: ['Confirmed', 'Preparing', 'Ready for Pickup'] } },
        {
          $set: { status: 'Out for Delivery', assignedTo: req.user._id },
          $push: { statusHistory: { status: 'Out for Delivery', at: new Date(), by: req.user._id } },
        }
      );
    }

    return res.json({ data: collected.toJSON(), pickupsRemaining: remaining });
  }
);

module.exports = router;
