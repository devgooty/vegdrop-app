'use strict';

const express = require('express');
const crypto = require('crypto');
const Order = require('../models/Order');
const StallOrder = require('../models/StallOrder');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const Market = require('../models/Market');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTransaction } = require('../db/connect');
const { resolveOwnedStall } = require('../services/stallAccess');
const wallet = require('../services/wallet');
const fulfilment = require('../services/fulfilment');

const router = express.Router();

const OPERATOR_ROLES = ['market_owner', 'developer'];

/**
 * Which roles may drive which status transition. Enforced in addition to the
 * transition graph on the model.
 *
 * `Confirmed` and `Rejected` are absent deliberately: an order leaves the
 * acceptance phase only through services/fulfilment.js, as a consequence of
 * stall decisions. No client can put it there directly.
 *
 * `shopkeeper` appears nowhere here either. A vendor acts on their own
 * StallOrder — accept, reject, packed — and the parent order advances as a
 * consequence. Letting one stall drive the whole order would hand it authority
 * over the other stalls' work.
 */
const TRANSITION_PERMISSIONS = {
  Preparing: ['market_owner', 'developer'],
  'Ready for Pickup': ['market_owner', 'developer'],
  'Out for Delivery': ['delivery', 'market_owner', 'developer'],
  Delivered: ['delivery', 'market_owner', 'developer'],
  Cancelled: ['customer', 'market_owner', 'developer'],
};

const DELIVERY_FEE_PAISE = 2500; // ₹25
const FREE_DELIVERY_THRESHOLD_PAISE = 30000; // ₹300

/** Restrict the query to what this caller is allowed to see. */
function visibilityFilter(user) {
  if (OPERATOR_ROLES.includes(user.role)) return {};
  if (user.role === 'delivery') {
    return {
      $or: [
        { assignedTo: user._id },
        { status: { $in: ['Ready for Pickup', 'Out for Delivery'] } },
      ],
    };
  }
  return { customer: user._id };
}

router.get(
  '/',
  requireAuth,
  validate({
    query: z
      .object({
        status: z.enum(Order.ORDER_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  async (req, res) => {
    const { status, limit } = req.valid.query;

    /**
     * A shopkeeper's queue is their StallOrders, not whole orders — they must
     * never see another vendor's lines or the order total.
     */
    if (req.user.role === 'shopkeeper') {
      const stall = await resolveOwnedStall(req.user);
      const stallOrders = await StallOrder.find({ stall: stall._id })
        .populate('order', 'orderNumber status address customerName phone createdAt')
        .sort({ createdAt: -1 })
        .limit(limit);
      return res.json({ data: stallOrders.map((s) => s.toJSON()), scope: 'stall' });
    }

    const filter = visibilityFilter(req.user);
    if (status) filter.status = status;

    const orders = await Order.find(filter)
      .populate('stallOrders')
      .sort({ createdAt: -1 })
      .limit(limit);

    return res.json({ data: orders.map((o) => o.toJSON()), scope: 'order' });
  }
);

router.get(
  '/:id',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await Order.findOne({ _id: req.valid.params.id, ...visibilityFilter(req.user) })
      .populate('stallOrders')
      .populate('market', 'name address city');
    // 404 rather than 403 so order ids are not probeable.
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
    return res.json({ data: order.toJSON() });
  }
);

/**
 * Create an order.
 *
 * The client sends only product ids and quantities. Every price, line total, fee
 * and grand total is recomputed here from the catalog.
 *
 * The basket is then split by owning stall into one StallOrder each, and the
 * order sits in `Awaiting Acceptance` until every stall answers. Stock is
 * claimed now; wallet funds are taken as a hold, not a payment.
 */
router.post(
  '/',
  requireAuth,
  requireRole('customer', 'developer'),
  validate({
    body: z
      .object({
        items: z
          .array(
            z.object({ productId: fields.objectId, quantity: z.number().int().min(1).max(99) }).strict()
          )
          .min(1)
          .max(50),
        address: fields.nonEmptyString(500),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        paymentMethod: z.enum(['wallet', 'cod']),
        // razorpay is not accepted here: those orders are created only after a
        // verified payment, via the wallet top-up flow.
      })
      .strict(),
  }),
  async (req, res) => {
    const { items, address, latitude, longitude, paymentMethod } = req.valid.body;

    // Collapse duplicate lines so quantity limits cannot be bypassed by repetition.
    const quantities = new Map();
    for (const { productId, quantity } of items) {
      quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    }
    for (const [productId, quantity] of quantities) {
      if (quantity > 99) {
        throw new ApiError(400, `Quantity for a single product may not exceed 99.`, 'VALIDATION_ERROR', [
          { field: 'items', message: `Total quantity for product ${productId} is ${quantity}.` },
        ]);
      }
    }

    const productIds = [...quantities.keys()];
    const products = await Product.find({ _id: { $in: productIds }, isActive: true }).populate(
      'stall',
      'stallNumber name isOpen isActive market'
    );

    if (products.length !== productIds.length) {
      throw new ApiError(400, 'One or more products are unavailable.', 'PRODUCT_UNAVAILABLE');
    }

    // --- One market per basket ---------------------------------------------
    const marketIds = new Set(products.map((p) => p.market.toString()));
    if (marketIds.size > 1) {
      throw new ApiError(
        400,
        'A single order cannot mix products from different markets. Please check out one market at a time.',
        'MIXED_MARKETS'
      );
    }
    const marketId = products[0].market;

    const market = await Market.findOne({ _id: marketId, isActive: true }).lean();
    if (!market) throw new ApiError(400, 'This market is not currently serving orders.', 'MARKET_UNAVAILABLE');

    // --- Every stall must be open before we take the customer's money -------
    const closed = products.filter((p) => !p.stall || !p.stall.isActive || !p.stall.isOpen);
    if (closed.length > 0) {
      throw new ApiError(
        409,
        `${closed[0].name} is from a stall that is currently closed.`,
        'STALL_CLOSED',
        closed.map((p) => ({ field: 'items', message: `${p.name} — ${p.stall?.name || 'unknown stall'} is closed.` }))
      );
    }

    const created = await withTransaction(async (session) => {
      const decremented = [];
      // stallId -> { stall, lines[], subtotalPaise }
      const byStall = new Map();
      let subtotalPaise = 0;

      try {
        for (const product of products) {
          const quantity = quantities.get(product._id.toHexString());

          // Conditional decrement: the guard and the write are one atomic
          // operation, so concurrent checkouts cannot oversell the last unit.
          const claim = await Product.findOneAndUpdate(
            { _id: product._id, stock: { $gte: quantity }, isActive: true },
            { $inc: { stock: -quantity } },
            { new: true, ...(session ? { session } : {}) }
          );

          if (!claim) {
            throw new ApiError(
              409,
              `${product.name} does not have enough stock remaining.`,
              'INSUFFICIENT_STOCK'
            );
          }
          decremented.push({ id: product._id, quantity });

          const lineTotalPaise = product.pricePaise * quantity;
          subtotalPaise += lineTotalPaise;

          const line = {
            product: product._id,
            name: product.name,
            unitPricePaise: product.pricePaise,
            quantity,
            lineTotalPaise,
          };

          const stallKey = product.stall._id.toHexString();
          if (!byStall.has(stallKey)) {
            byStall.set(stallKey, { stall: product.stall, lines: [], subtotalPaise: 0 });
          }
          const bucket = byStall.get(stallKey);
          bucket.lines.push(line);
          bucket.subtotalPaise += lineTotalPaise;
        }

        const deliveryFeePaise = subtotalPaise >= FREE_DELIVERY_THRESHOLD_PAISE ? 0 : DELIVERY_FEE_PAISE;
        const totalAmountPaise = subtotalPaise + deliveryFeePaise;

        const orderNumber = `VB${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        const allLines = [...byStall.values()].flatMap((b) => b.lines);

        const [order] = await Order.create(
          [{
            orderNumber,
            customer: req.user._id,
            customerName: req.user.name,
            phone: req.user.phone,
            address,
            ...(latitude !== undefined && longitude !== undefined
              ? { deliveryLocation: { type: 'Point', coordinates: [longitude, latitude] } }
              : {}),
            market: marketId,
            items: allLines,
            subtotalPaise,
            deliveryFeePaise,
            totalAmountPaise,
            paymentMethod,
            paymentStatus: 'pending',
            status: 'Awaiting Acceptance',
            stallOrderCount: byStall.size,
            acceptedCount: 0,
            statusHistory: [{ status: 'Awaiting Acceptance', at: new Date(), by: req.user._id }],
          }],
          session ? { session } : {}
        );

        const respondByAt = fulfilment.acceptanceDeadline();

        await StallOrder.create(
          [...byStall.values()].map((bucket) => ({
            order: order._id,
            orderNumber,
            stall: bucket.stall._id,
            market: marketId,
            stallNumber: bucket.stall.stallNumber,
            stallName: bucket.stall.name,
            items: bucket.lines,
            subtotalPaise: bucket.subtotalPaise,
            status: 'awaiting',
            respondByAt,
          })),
          session ? { session } : {}
        );

        /**
         * Take the money as a hold, not a payment. It is released in full the
         * instant any stall declines — see services/fulfilment.js.
         */
        if (paymentMethod === 'wallet') {
          await wallet.debit({
            userId: req.user._id,
            amountPaise: totalAmountPaise,
            reason: 'order_hold',
            idempotencyKey: `hold:${order._id.toHexString()}`,
            order: order._id,
            note: `Hold for ${orderNumber}`,
            session,
          });

          order.paymentStatus = 'held';
          await order.save(session ? { session } : {});
        }

        return order;
      } catch (err) {
        // Standalone mongod has no transaction to roll back, so undo the stock
        // claims by hand. On a replica set this is redundant but harmless
        // because the abort discards it.
        if (!session) {
          await Promise.all(
            decremented.map(({ id, quantity }) =>
              Product.updateOne({ _id: id }, { $inc: { stock: quantity } }).catch(() => {})
            )
          );
        }
        throw err;
      }
    });

    const withStalls = await Order.findById(created._id).populate('stallOrders');

    return res.status(201).json({
      data: withStalls.toJSON(),
      acceptance: {
        stallCount: created.stallOrderCount,
        respondBySeconds: fulfilment.ACCEPTANCE_WINDOW_SECONDS,
        message: `Waiting for ${created.stallOrderCount} stall(s) to confirm your items.`,
      },
    });
  }
);

/**
 * Markets other than this one that could fulfil the same basket.
 *
 * Offered after a rejection, which is the moment the customer needs it. Ordered
 * by distance from the delivery address, and only markets where every requested
 * product is in stock at an open stall are returned — suggesting a market that
 * would fail the same way is worse than suggesting nothing.
 */
router.get(
  '/:id/alternative-markets',
  requireAuth,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    query: z.object({ radiusM: z.coerce.number().int().min(500).max(50_000).default(15_000) }).strict(),
  }),
  async (req, res) => {
    const order = await Order.findOne({ _id: req.valid.params.id, ...visibilityFilter(req.user) });
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    const coordinates = order.deliveryLocation?.coordinates;
    if (!coordinates || coordinates.length !== 2) {
      throw new ApiError(
        409,
        'This order has no delivery location, so nearby markets cannot be ranked.',
        'NO_DELIVERY_LOCATION'
      );
    }

    const nearby = await Market.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates },
          distanceField: 'distanceM',
          maxDistance: req.valid.query.radiusM,
          query: { isActive: true, _id: { $ne: order.market } },
          spherical: true,
        },
      },
      { $limit: 10 },
    ]);

    // Match on SKU: the "same product" in another market is a different document.
    const skus = await Product.find({ _id: { $in: order.items.map((i) => i.product) } })
      .select('sku name')
      .lean();
    const wanted = new Map(skus.map((p) => [p.sku, p.name]));

    const candidates = [];
    for (const market of nearby) {
      const openStalls = await Stall.find({ market: market._id, isActive: true, isOpen: true })
        .select('_id')
        .lean();
      if (openStalls.length === 0) continue;

      const available = await Product.find({
        market: market._id,
        stall: { $in: openStalls.map((s) => s._id) },
        sku: { $in: [...wanted.keys()] },
        isActive: true,
        stock: { $gt: 0 },
      })
        .select('sku')
        .lean();

      const foundSkus = new Set(available.map((p) => p.sku));
      const missing = [...wanted.entries()]
        .filter(([sku]) => !foundSkus.has(sku))
        .map(([, name]) => name);

      candidates.push({
        id: market._id.toHexString(),
        name: market.name,
        address: market.address,
        distanceM: Math.round(market.distanceM),
        latitude: market.location?.coordinates?.[1] ?? null,
        longitude: market.location?.coordinates?.[0] ?? null,
        canFulfilAll: missing.length === 0,
        missingItems: missing,
      });
    }

    // Complete baskets first, then by distance.
    candidates.sort((a, b) => Number(b.canFulfilAll) - Number(a.canFulfilAll) || a.distanceM - b.distanceM);

    return res.json({ data: candidates });
  }
);

router.patch(
  '/:id/status',
  requireAuth,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ status: z.enum(Order.ORDER_STATUSES) }).strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { status } = req.valid.body;

    const allowedRoles = TRANSITION_PERMISSIONS[status] || [];
    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(403, `Your role cannot move an order to ${status}.`, 'FORBIDDEN');
    }

    const order = await Order.findOne({ _id: id, ...visibilityFilter(req.user) });
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    // A customer may only cancel their own order, and only before it is confirmed.
    if (req.user.role === 'customer') {
      if (order.customer.toString() !== req.user._id.toHexString()) {
        throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
      }
      if (status !== 'Cancelled' || !['Awaiting Acceptance', 'Confirmed'].includes(order.status)) {
        throw new ApiError(409, 'This order can no longer be cancelled.', 'INVALID_TRANSITION');
      }
    }

    if (!Order.canTransition(order.status, status)) {
      throw new ApiError(
        409,
        `An order cannot move from ${order.status} to ${status}.`,
        'INVALID_TRANSITION'
      );
    }

    if (status === 'Cancelled') {
      // Cancelling during acceptance is the same compensation as a rejection:
      // release the hold, put the stock back, stand the stalls down.
      if (order.status === 'Awaiting Acceptance') {
        const failed = await fulfilment.failOrder(order._id, {
          reason: 'Cancelled by the customer before the stalls responded.',
        });
        if (failed) {
          failed.status = 'Cancelled';
          failed.statusHistory.push({ status: 'Cancelled', at: new Date(), by: req.user._id });
          await failed.save();
          return res.json({ data: failed.toJSON() });
        }
        throw new ApiError(409, 'This order can no longer be cancelled.', 'INVALID_TRANSITION');
      }

      // Past confirmation the money has been captured, so this is a real refund.
      if (order.paymentStatus === 'paid') {
        await wallet.credit({
          userId: order.customer,
          amountPaise: order.totalAmountPaise,
          reason: 'order_refund',
          idempotencyKey: `refund:${order._id.toHexString()}`,
          note: `Refund for ${order.orderNumber}`,
        });
        order.paymentStatus = 'refunded';
      }

      await fulfilment.restoreStock(order);
      await StallOrder.updateMany(
        { order: order._id, status: { $nin: ['rejected', 'picked_up'] } },
        { $set: { status: 'cancelled' } }
      );
    }

    if (status === 'Delivered' && order.paymentMethod === 'cod') {
      order.paymentStatus = 'paid';
    }

    if (status === 'Out for Delivery' && !order.assignedTo && req.user.role === 'delivery') {
      order.assignedTo = req.user._id;
    }

    order.status = status;
    order.statusHistory.push({ status, at: new Date(), by: req.user._id });
    await order.save();

    return res.json({ data: order.toJSON() });
  }
);

router.post(
  '/:id/claim',
  requireAuth,
  requireRole('delivery'),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    // Conditional update: only an unassigned order can be claimed, so two agents
    // racing for the same order cannot both win.
    const order = await Order.findOneAndUpdate(
      {
        _id: req.valid.params.id,
        assignedTo: null,
        status: { $in: ['Confirmed', 'Preparing', 'Ready for Pickup'] },
      },
      { $set: { assignedTo: req.user._id } },
      { new: true }
    );
    if (!order) throw new ApiError(409, 'That order is no longer available to claim.', 'ALREADY_CLAIMED');
    return res.json({ data: order.toJSON() });
  }
);

module.exports = router;
