'use strict';

const express = require('express');
const StallOrder = require('../models/StallOrder');
const Order = require('../models/Order');
const Stall = require('../models/Stall');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOwnedStall } = require('../services/stallAccess');
const fulfilment = require('../services/fulfilment');

const router = express.Router();

const OPERATOR_ROLES = ['market_owner', 'developer'];

/**
 * Load a stall order the caller is entitled to act on.
 *
 * The stall is derived from the authenticated user, never from the request, so a
 * vendor cannot accept or reject another stall's slice by guessing an id. 404
 * rather than 403 keeps ids unprobeable.
 */
async function loadOwnStallOrder(user, stallOrderId) {
  const stallOrder = await StallOrder.findById(stallOrderId);
  if (!stallOrder) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

  if (OPERATOR_ROLES.includes(user.role)) return stallOrder;

  const stall = await Stall.findOne({ _id: stallOrder.stall, owner: user._id }).select('_id').lean();
  if (!stall) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

  return stallOrder;
}

/** The vendor's queue. Only their own slices, never the parent order total. */
router.get(
  '/',
  requireAuth,
  requireRole('shopkeeper', 'developer'),
  validate({
    query: z
      .object({
        status: z.enum(StallOrder.STALL_ORDER_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  async (req, res) => {
    const stall = await resolveOwnedStall(req.user);

    const filter = { stall: stall._id };
    if (req.valid.query.status) filter.status = req.valid.query.status;

    const stallOrders = await StallOrder.find(filter)
      .populate('order', 'orderNumber status address customerName phone createdAt')
      .sort({ createdAt: -1 })
      .limit(req.valid.query.limit);

    const now = Date.now();
    const data = stallOrders.map((s) => {
      const json = s.toJSON();
      // Drives the countdown in the vendor panel.
      json.secondsRemaining =
        s.status === 'awaiting' ? Math.max(0, Math.round((s.respondByAt.getTime() - now) / 1000)) : 0;
      return json;
    });

    return res.json({ data, stall: stall.toJSON() });
  }
);

/**
 * Accept this stall's slice.
 *
 * Accepting does not confirm the order — it only records this vendor's answer.
 * The order is confirmed by services/fulfilment.js once every stall has accepted.
 */
router.post(
  '/:id/accept',
  requireAuth,
  requireRole('shopkeeper', 'developer'),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const stallOrder = await loadOwnStallOrder(req.user, req.valid.params.id);

    const { stallOrder: accepted, order } = await fulfilment.acceptStallOrder({
      stallOrder,
      userId: req.user._id,
    });

    // The pickup code exists only once the whole order is confirmed, and is
    // returned here exactly once, to the vendor who will hand the bag over.
    const pickupCode = accepted.$locals?.plainPickupCode || null;
    const fresh = await StallOrder.findById(accepted._id);

    return res.json({
      data: fresh.toJSON(),
      order: order ? { id: order._id.toHexString(), status: order.status } : null,
      pickupCode,
      waitingOn: order && order.status === 'Awaiting Acceptance'
        ? Math.max(0, order.stallOrderCount - order.acceptedCount)
        : 0,
    });
  }
);

/**
 * Decline this stall's slice.
 *
 * Per the operating rule, one decline fails the entire order: the customer's
 * hold is released, all stock returns, and any stall that already accepted is
 * stood down. The customer is then offered another market.
 */
router.post(
  '/:id/reject',
  requireAuth,
  requireRole('shopkeeper', 'developer'),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ reason: z.string().trim().max(300).optional() }).strict(),
  }),
  async (req, res) => {
    const stallOrder = await loadOwnStallOrder(req.user, req.valid.params.id);

    const { stallOrder: rejected, order } = await fulfilment.rejectStallOrder({
      stallOrder,
      reason: req.valid.body.reason || 'The stall could not fulfil these items.',
    });

    return res.json({
      data: rejected.toJSON(),
      order: order ? { id: order._id.toHexString(), status: order.status } : null,
    });
  }
);

/** Mark the slice bagged and on the counter. */
router.post(
  '/:id/packed',
  requireAuth,
  requireRole('shopkeeper', 'developer'),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const stallOrder = await loadOwnStallOrder(req.user, req.valid.params.id);

    const packed = await StallOrder.findOneAndUpdate(
      { _id: stallOrder._id, status: 'accepted' },
      { $set: { status: 'packed', packedAt: new Date() } },
      { new: true }
    );
    if (!packed) {
      throw new ApiError(409, 'Only an accepted order can be marked packed.', 'INVALID_TRANSITION');
    }

    /**
     * When every stall has packed, the order becomes collectable. Counted from
     * the rows rather than a counter so a lost increment cannot advance an order
     * whose bags are not all ready.
     */
    const siblings = await StallOrder.find({ order: packed.order }).select('status').lean();
    const allPacked = siblings.every((s) => ['packed', 'picked_up', 'cancelled'].includes(s.status));

    if (allPacked) {
      await Order.findOneAndUpdate(
        { _id: packed.order, status: { $in: ['Confirmed', 'Preparing'] } },
        {
          $set: { status: 'Ready for Pickup' },
          $push: { statusHistory: { status: 'Ready for Pickup', at: new Date(), by: req.user._id } },
        }
      );
    }

    return res.json({ data: packed.toJSON(), allPacked });
  }
);

module.exports = router;
