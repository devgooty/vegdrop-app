'use strict';

const express = require('express');
const Order = require('../models/Order');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const Product = require('../models/Product');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const StallEarning = require('../models/StallEarning');
const { stallActionLimiter } = require('../middleware/rateLimit');
const sourcing = require('../services/sourcing');
const settlement = require('../services/settlement');

const router = express.Router();

/**
 * The shopkeeper's side of a market: see what has been offered, take what you
 * can fill, bag it.
 *
 * A running theme here is that a stall is NEVER shown the customer.
 * A stall is being asked "can you supply 2kg of tomatoes"; the name, phone and
 * address belong to the rider's job, not theirs. The projections below are
 * deliberately narrow rather than `order.toJSON()`.
 */

/** Resolve the caller's stall once, for every route below. */
async function loadStall(req, _res, next) {
  const stall = await Stall.findOne({ owner: req.user._id, isActive: true });
  if (!stall) {
    return next(
      new ApiError(404, 'You do not have a stall yet. Ask the market owner to set one up.', 'NO_STALL')
    );
  }
  req.stall = stall;
  return next();
}

const stallGate = [requireAuth, requireRole('shopkeeper', 'developer'), loadStall];

/** Shape one order for a stall's eyes: the goods, never the customer. */
function forStall(order, stallId) {
  const key = String(stallId);
  const mine = order.items.filter((i) => String(i.claim?.stall) === key);
  const open = order.items.filter((i) => !i.claim?.stall);

  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    marketName: order.marketName,
    status: order.fulfillment?.status,
    // What the customer sees as the deadline to beat.
    sourcingDeadline: order.fulfillment?.sourcingDeadline,
    placedAt: order.createdAt,
    /** Lines nobody has taken — what this stall may still claim. */
    openLines: open.map((i) => ({
      lineId: String(i.lineId),
      name: i.name,
      quantity: i.quantity,
      // The market's price, which is what this stall is paid — never the
      // customer's locked price, which may differ after a hop.
      unitPricePaise: i.sourcePricePaise,
    })),
    /** Lines this stall has committed to. */
    myLines: mine.map((i) => ({
      lineId: String(i.lineId),
      name: i.name,
      quantity: i.quantity,
      unitPricePaise: i.sourcePricePaise,
      auto: i.claim.auto,
      packedAt: i.claim.packedAt,
      collectedAt: i.claim.collectedAt,
    })),
    myTotalPaise: mine.reduce((sum, i) => sum + (i.sourcePricePaise || 0) * i.quantity, 0),
  };
}

// ---------------------------------------------------------------------------
// The stall itself
// ---------------------------------------------------------------------------

router.get('/me', ...stallGate, async (req, res) => {
  return res.json({ data: req.stall.toJSON() });
});

/**
 * Open/close the shutter, and switch automatic accepting on or off.
 *
 * Auto-accept only ever fires where the stall has declared stock for the line,
 * so switching it on without any inventory changes nothing — which is why the
 * response says how many lines are actually declared.
 */
router.patch(
  '/me',
  ...stallGate,
  validate({
    body: z
      .object({
        isOpen: z.boolean().optional(),
        autoAccept: z.boolean().optional(),
        name: fields.nonEmptyString(160).optional(),
        contactPhone: z.string().trim().max(20).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const update = { ...req.valid.body };
    if (Object.keys(update).length === 0) {
      throw new ApiError(400, 'No fields to update.', 'VALIDATION_ERROR');
    }

    const stall = await Stall.findByIdAndUpdate(
      req.stall._id,
      { $set: update },
      { new: true, runValidators: true }
    );

    const declaredLines = await StallInventory.countDocuments({ stall: stall._id, stock: { $gt: 0 } });

    return res.json({ data: { ...stall.toJSON(), declaredLines } });
  }
);

// ---------------------------------------------------------------------------
// Declared stock — what powers auto-accept
// ---------------------------------------------------------------------------

router.get('/me/inventory', ...stallGate, async (req, res) => {
  const rows = await StallInventory.find({ stall: req.stall._id })
    .populate('product', 'name weight image categoryId')
    .lean();

  return res.json({
    data: rows.map((row) => ({
      id: String(row._id),
      product: row.product
        ? { id: String(row.product._id), name: row.product.name, weight: row.product.weight, image: row.product.image }
        : null,
      stock: row.stock,
      updatedAt: row.updatedAt,
    })),
  });
});

router.put(
  '/me/inventory',
  ...stallGate,
  validate({
    body: z
      .object({
        items: z
          .array(
            z.object({ productId: fields.objectId, stock: z.number().int().min(0).max(1_000_000) }).strict()
          )
          .min(1)
          .max(300),
      })
      .strict(),
  }),
  async (req, res) => {
    const { items } = req.valid.body;

    const productIds = [...new Set(items.map((i) => i.productId))];
    const known = await Product.countDocuments({ _id: { $in: productIds }, isActive: true });
    if (known !== productIds.length) {
      throw new ApiError(400, 'One or more products do not exist.', 'PRODUCT_UNAVAILABLE');
    }

    await StallInventory.bulkWrite(
      items.map((row) => ({
        updateOne: {
          filter: { stall: req.stall._id, product: row.productId },
          update: { $set: { stock: row.stock, market: req.stall.market } },
          upsert: true,
        },
      }))
    );

    return res.json({ data: { updated: items.length } });
  }
);

// ---------------------------------------------------------------------------
// The live feed — this is the "alert"
// ---------------------------------------------------------------------------

/**
 * Everything this stall needs to look at right now.
 *
 * `offers` are live in this market and still have unclaimed lines; `packing` is
 * work already committed to. The apps poll this on the same 5s cycle they
 * already use for orders, so a new offer surfaces within five seconds without
 * any push infrastructure.
 */
router.get('/me/orders', ...stallGate, async (req, res) => {
  const [sourcingOrders, mine] = await Promise.all([
    Order.find({
      market: req.stall.market,
      'fulfillment.status': 'sourcing',
      // Only orders with something left to take.
      items: { $elemMatch: { 'claim.stall': null } },
    })
      .select('orderNumber marketName items fulfillment.status fulfillment.sourcingDeadline createdAt')
      .sort({ createdAt: 1 })
      .limit(50)
      .lean(),

    Order.find({
      'items.claim.stall': req.stall._id,
      'fulfillment.status': { $in: ['packing', 'awaiting_rider', 'collecting'] },
    })
      .select('orderNumber marketName items fulfillment.status fulfillment.sourcingDeadline createdAt')
      .sort({ createdAt: 1 })
      .limit(50)
      .lean(),
  ]);

  return res.json({
    data: {
      offers: sourcingOrders.map((o) => forStall(o, req.stall._id)),
      packing: mine.map((o) => forStall(o, req.stall._id)),
      stall: {
        id: String(req.stall._id),
        stallNumber: req.stall.stallNumber,
        isOpen: req.stall.isOpen,
        autoAccept: req.stall.autoAccept,
        activeLoad: req.stall.activeLoad,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Accepting and packing
// ---------------------------------------------------------------------------

/**
 * Take some lines of an offered order.
 *
 * Its own route rather than the existing POST /orders/:id/claim, which is a
 * rider claiming a whole order for delivery — a different actor, a different
 * unit of work, and sharing them would eventually let one become the other.
 *
 * Partial success is normal: another stall may have taken one of the lines a
 * moment ago. The response says exactly what was won and what was lost so the
 * shopkeeper sees the truth rather than an optimistic echo of what they tapped.
 */
router.post(
  '/orders/:id/claim',
  ...stallGate,
  stallActionLimiter,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ lineIds: z.array(fields.objectId).min(1).max(100) }).strict(),
  }),
  async (req, res) => {
    const order = await Order.findOne({
      _id: req.valid.params.id,
      market: req.stall.market,
    }).select('_id fulfillment.status');

    // 404 rather than 403: a stall must not be able to probe for orders in
    // markets it has nothing to do with.
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    if (!req.stall.isOpen) {
      throw new ApiError(409, 'Your stall is closed. Open it before accepting orders.', 'STALL_CLOSED');
    }

    const result = await sourcing.claimLines({
      orderId: order._id,
      stallId: req.stall._id,
      stallNumber: req.stall.stallNumber,
      lineIds: req.valid.body.lineIds,
      auto: false,
      actorId: req.user._id,
    });

    if (result.won.length === 0) {
      throw new ApiError(
        409,
        result.reason === 'NOT_SOURCING'
          ? 'That order has already moved on.'
          : 'Another stall took those items first.',
        result.reason || 'ALREADY_TAKEN'
      );
    }

    const fresh = await Order.findById(order._id).lean();
    return res.json({
      data: {
        ...forStall(fresh, req.stall._id),
        won: result.won.map((i) => String(i.lineId)),
        lost: result.lost.map(String),
        // True when this claim was the one that completed the order.
        locked: Boolean(result.promoted),
      },
    });
  }
);

/**
 * Bagged and ready for the rider.
 *
 * Scoped to lines this stall actually holds, so one shopkeeper cannot mark
 * another's lines packed and send a rider to a stall with nothing ready.
 */
router.post(
  '/orders/:id/pack',
  ...stallGate,
  stallActionLimiter,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ lineIds: z.array(fields.objectId).min(1).max(100).optional() }).strict(),
  }),
  async (req, res) => {
    const order = await Order.findOne({
      _id: req.valid.params.id,
      'items.claim.stall': req.stall._id,
    }).lean();
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    // No list means "everything I hold on this order", which is what the pack
    // button on the stall screen actually means.
    const lineIds =
      req.valid.body.lineIds ||
      order.items
        .filter((i) => String(i.claim?.stall) === String(req.stall._id) && !i.claim.packedAt)
        .map((i) => String(i.lineId));

    if (lineIds.length === 0) {
      throw new ApiError(409, 'Nothing left to pack on this order.', 'NOTHING_TO_PACK');
    }

    const result = await sourcing.packLines({
      orderId: order._id,
      stallId: req.stall._id,
      lineIds,
    });

    if (!result.order) {
      throw new ApiError(409, 'That order is not being packed right now.', result.reason || 'NOT_PACKING');
    }

    return res.json({ data: forStall(result.order.toJSON ? result.order.toJSON() : result.order, req.stall._id) });
  }
);

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/**
 * What this stall is owed, what has already been paid, and when the rest lands.
 *
 * Nothing appears here until a customer has actually taken delivery. An order
 * that was accepted, packed, then cancelled pays nothing, because nothing was
 * sold — which is worth showing plainly rather than letting a shopkeeper wonder
 * where an order went.
 */
router.get('/me/earnings', ...stallGate, async (req, res) => {
  const [summary, recent] = await Promise.all([
    settlement.summaryForOwner(req.user._id),
    StallEarning.find({ owner: req.user._id })
      .sort({ earnedAt: -1 })
      .limit(50)
      .select('orderNumber netPaise grossPaise commissionPaise status earnedAt releaseAt releasedAt releasedEarly lines')
      .lean(),
  ]);

  return res.json({
    data: {
      ...summary,
      recent: recent.map((row) => ({
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
        itemCount: row.lines.reduce((sum, l) => sum + l.quantity, 0),
      })),
    },
  });
});

/**
 * Take the held money now rather than waiting for it.
 *
 * Rate-limited on the shopkeeper, because this is the one route here that moves
 * money and a retry loop against it is worth bounding hard.
 */
router.post('/me/earnings/withdraw', ...stallGate, stallActionLimiter, async (req, res) => {
  // Throws 409 BELOW_MINIMUM with the shortfall when there is not enough yet.
  const result = await settlement.releaseEarly(req.user._id);
  const summary = await settlement.summaryForOwner(req.user._id);

  return res.json({ data: { ...result, ...summary } });
});

module.exports = router;
