'use strict';

const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTransaction } = require('../db/connect');
const wallet = require('../services/wallet');
const sourcing = require('../services/sourcing');
const { CANCELLABLE_BY_CUSTOMER, CANCELLABLE_BY_STAFF, transitionTo } = require('../utils/orderStatus');

const router = express.Router();

/**
 * Which roles may drive which status transition. Enforced in addition to the
 * transition graph on the model, so a delivery agent cannot mark an order
 * Preparing and a customer cannot mark their own order Delivered.
 *
 * This governs LEGACY (marketless) orders only. A market order's status is
 * derived from its fulfillment state and is never pushed by hand — see the
 * guard in PATCH /:id/status.
 */
const TRANSITION_PERMISSIONS = {
  Preparing: ['shopkeeper', 'market_owner', 'developer'],
  'Out for Delivery': ['shopkeeper', 'market_owner', 'developer'],
  Delivered: ['delivery', 'market_owner', 'developer'],
  Cancelled: ['customer', 'shopkeeper', 'market_owner', 'developer'],
};

const DELIVERY_FEE_PAISE = 2500; // ₹25
const FREE_DELIVERY_THRESHOLD_PAISE = 30000; // ₹300

/** Matches no document. Used when a caller has no scope at all. */
const MATCH_NOTHING = { _id: null };

/**
 * Restrict the query to what this caller is allowed to see.
 *
 * Async because a shopkeeper's scope depends on which stall they run, which is
 * a lookup. Every caller must await it.
 */
async function visibilityFilter(user) {
  if (user.role === 'market_owner' || user.role === 'developer') return {};

  /**
   * A shopkeeper used to fall into a blanket staff bucket that returned `{}` —
   * every order in the system, including the name, phone and address on orders
   * belonging to a market they have nothing to do with. Once there is more than
   * one market that is a straightforward data leak between competitors.
   *
   * Scoped now to three things: live offers in their own market that they could
   * still accept, anything they hold a line on, and the legacy marketless
   * orders that the current single-shop flow depends on.
   */
  if (user.role === 'shopkeeper') {
    const stall = await Stall.findOne({ owner: user._id, isActive: true }).select('_id market').lean();
    if (!stall) return { market: null };
    return {
      $or: [
        { market: stall.market, 'fulfillment.status': 'sourcing' },
        { 'items.claim.stall': stall._id },
        { market: null },
      ],
    };
  }

  if (user.role === 'delivery') {
    /**
     * An agent sees their own assignments plus what they may still take.
     *
     * The previous filter matched every order in Preparing/Out for Delivery
     * regardless of assignment, which exposed the customer name, phone and
     * address on another agent's active delivery — and, because the status
     * handler never checked `assignedTo`, let any agent mark it Delivered.
     *
     * The two market branches matter: during a rider offer `assignedTo` is
     * still null, so without them the rider we just picked could never actually
     * see the order we are offering them.
     */
    return {
      $or: [
        { assignedTo: user._id },
        {
          'fulfillment.riderOffer.rider': user._id,
          'fulfillment.riderOffer.expiresAt': { $gt: new Date() },
        },
        { assignedTo: null, 'fulfillment.riderOffer.openPool': true },
        // Legacy marketless orders keep the original unclaimed-pool behaviour.
        { assignedTo: null, market: null, status: { $in: ['Preparing', 'Out for Delivery'] } },
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

    const filter = await visibilityFilter(req.user);
    if (status) filter.status = status;

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit);
    return res.json({ data: orders.map((o) => o.toJSON()) });
  }
);

router.get(
  '/:id',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await Order.findOne({ _id: req.valid.params.id, ...(await visibilityFilter(req.user)) });
    // 404 rather than 403 so order ids are not probeable.
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
    return res.json({ data: order.toJSON() });
  }
);

/**
 * Create an order.
 *
 * The client sends only product ids and quantities. Every price, line total, fee
 * and grand total is recomputed here from the catalog — the previous
 * implementation did `new Order(req.body)`, which let a caller set their own
 * totalAmount, status, and paymentStatus.
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
        paymentMethod: z.enum(['wallet', 'cod']),
        // razorpay is not accepted here: those orders are created only after a
        // verified payment, via the wallet top-up flow.

        /**
         * Which market to buy from. Optional, and that is what makes this whole
         * feature additive: omit it and the order behaves exactly as it always
         * has — one flat catalog, one implicit shop, Pending until a shopkeeper
         * accepts. Supply it and the order is offered to that market's stalls.
         */
        marketId: fields.objectId.optional(),
        // Where it is going. Used to find the next nearest market if the first
        // one cannot fill the order. The customer app has had these in local
        // storage all along and simply never sent them.
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { items, address, paymentMethod, marketId, lat, lng } = req.valid.body;

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
    const products = await Product.find({ _id: { $in: productIds }, isActive: true });

    if (products.length !== productIds.length) {
      throw new ApiError(400, 'One or more products are unavailable.', 'PRODUCT_UNAVAILABLE');
    }

    /**
     * Resolve the market and its price sheet up front.
     *
     * A market order is priced from the market's own sheet, not the platform
     * catalog — that is what "one price per market" means. The catalog price is
     * only the fallback for a marketless order.
     */
    let market = null;
    let marketPrices = null;
    if (marketId) {
      market = await Market.findOne({ _id: marketId, isActive: true, isOpen: true });
      if (!market) {
        throw new ApiError(400, 'That market is not open right now.', 'MARKET_UNAVAILABLE');
      }

      const priced = await sourcing.priceLinesAtMarket(
        market._id,
        products.map((p) => ({ product: p._id, quantity: quantities.get(p._id.toHexString()), lineId: p._id }))
      );
      if (!priced) {
        throw new ApiError(
          409,
          'This market is not selling one or more of these items today.',
          'MARKET_CANNOT_FILL'
        );
      }
      marketPrices = new Map(priced.priced.map((line) => [String(line.lineId), line.sourcePricePaise]));
    }

    /** The market's price when buying from a market; the catalog price otherwise. */
    const unitPriceFor = (product) =>
      marketPrices ? marketPrices.get(String(product._id)) : product.pricePaise;

    const order = await withTransaction(async (session) => {
      const lines = [];
      let subtotalPaise = 0;
      const decremented = [];

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

          const unitPricePaise = unitPriceFor(product);
          const lineTotalPaise = unitPricePaise * quantity;
          subtotalPaise += lineTotalPaise;
          lines.push({
            product: product._id,
            name: product.name,
            unitPricePaise,
            quantity,
            lineTotalPaise,
            // Market orders get a stable per-line handle so a stall can claim
            // "these two" without depending on array position, plus an
            // explicitly-empty claim so `claim.stall: null` unambiguously means
            // unclaimed. Legacy orders leave both null and nothing reads them.
            ...(market
              ? {
                  lineId: new mongoose.Types.ObjectId(),
                  sourcePricePaise: unitPricePaise,
                  claim: sourcing.emptyClaim(),
                }
              : {}),
          });
        }

        const deliveryFeePaise = subtotalPaise >= FREE_DELIVERY_THRESHOLD_PAISE ? 0 : DELIVERY_FEE_PAISE;
        const totalAmountPaise = subtotalPaise + deliveryFeePaise;

        const orderNumber = `VB${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        const [created] = await Order.create(
          [{
            orderNumber,
            customer: req.user._id,
            customerName: req.user.name,
            // Falls back to an unverified number: a courier needs someone to
            // ring, and an account may hold a claimed-but-unproven one.
            phone: req.user.contactPhone(),
            address,
            items: lines,
            subtotalPaise,
            deliveryFeePaise,
            totalAmountPaise,
            paymentMethod,
            paymentStatus: paymentMethod === 'cod' ? 'pending' : 'pending',
            status: 'Pending',
            statusHistory: [{ status: 'Pending', at: new Date(), by: req.user._id }],

            ...(market
              ? {
                  market: market._id,
                  marketName: market.name,
                  ...(lat !== undefined && lng !== undefined
                    ? { deliveryLocation: { type: 'Point', coordinates: [lng, lat] } }
                    : {}),
                  /**
                   * Built here rather than in a follow-up update so the order is
                   * never briefly visible in `sourcing` with no deadline — the
                   * sweeper would find it and have no idea what to do with it.
                   */
                  fulfillment: {
                    ...sourcing.initialFulfillment(market._id),
                    sourceSubtotalPaise: subtotalPaise,
                  },
                }
              : {}),
          }],
          session ? { session } : {}
        );

        if (paymentMethod === 'wallet') {
          // Throws 402 when the ledger balance is short, rolling back the
          // transaction (and the stock claims) on a replica set.
          await wallet.debit({
            userId: req.user._id,
            amountPaise: totalAmountPaise,
            reason: 'order_payment',
            idempotencyKey: `order:${created._id.toHexString()}`,
            order: created._id,
            note: `Payment for ${orderNumber}`,
            session,
          });

          created.paymentStatus = 'paid';
          await created.save(session ? { session } : {});
        }

        return created;
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

    /**
     * Let the stalls that answer automatically answer now.
     *
     * Deliberately AFTER the transaction commits: a stall must never be shown,
     * or be able to claim, an order that could still be rolled back. Awaited so
     * the customer's own response already reflects any instant acceptance — a
     * fully auto-accepted order comes back locked, with nothing to wait for.
     */
    if (order.market) {
      await sourcing.runAutoAccept(order._id, req.user._id).catch((err) => {
        // A failure here costs nothing: the order simply waits for a human, and
        // the sweeper still owns the deadline. Never fail a paid checkout for it.
        console.warn(`[orders] auto-accept failed for ${order.orderNumber}: ${err.message}`);
      });
      const settled = await Order.findById(order._id);
      return res.status(201).json({ data: settled.toJSON() });
    }

    return res.status(201).json({ data: order.toJSON() });
  }
);

/**
 * Cancel a market order.
 *
 * Split out because it cannot be a read-modify-`save()` like the legacy path.
 * The sweeper and the stall claim route are both writing to this document
 * concurrently, and `save()` would write back whatever `fulfillment.status` was
 * read before those landed — silently resurrecting an order the sweeper had
 * just failed, or unlocking one a stall had just locked.
 *
 * So the state change is one conditional update, and the states it will accept
 * are the guard. A customer past the lock matches nothing and gets a clean 409.
 */
async function cancelMarketOrder({ req, res, order }) {
  const isCustomer = req.user.role === 'customer';

  if (isCustomer && order.customer.toString() !== req.user._id.toHexString()) {
    throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
  }

  const allowedStates = isCustomer ? CANCELLABLE_BY_CUSTOMER : CANCELLABLE_BY_STAFF;

  /**
   * Refund BEFORE the state change, on the same idempotency key the sweeper
   * uses. If this succeeds and the update below then loses its race, the ledger
   * entry is simply replayed by whoever did win — the customer is credited
   * exactly once either way.
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

  const now = new Date();
  const paymentStatus =
    order.paymentMethod === 'wallet' && order.paymentStatus === 'paid' ? 'refunded' : order.paymentStatus;

  const cancelled = await Order.findOneAndUpdate(
    { _id: order._id, 'fulfillment.status': { $in: allowedStates } },
    {
      $set: transitionTo('cancelled', { paymentStatus }),
      $push: {
        statusHistory: { status: 'Cancelled', at: now, by: req.user._id },
        'fulfillment.events': {
          $each: [{ at: now, type: 'cancelled', note: isCustomer ? 'by customer' : 'by staff' }],
          $slice: -50,
        },
      },
    },
    { new: true }
  );

  if (!cancelled) {
    throw new ApiError(
      409,
      'This order is already being packed and can no longer be cancelled.',
      'ORDER_LOCKED'
    );
  }

  // Hand the produce back: stall queues shrink, and the catalog is restocked.
  await sourcing.releaseClaims(cancelled);
  await Promise.all(
    cancelled.items.map((item) =>
      Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }).catch(() => {})
    )
  );

  return res.json({ data: cancelled.toJSON() });
}

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

    const order = await Order.findOne({ _id: id, ...(await visibilityFilter(req.user)) });
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    /**
     * A market order's coarse status is DERIVED, never pushed.
     *
     * Left open, this endpoint was a way to corrupt the sourcing engine: a
     * shopkeeper could move an order to `Preparing` while stalls were still
     * racing to claim it. The customer would see "Preparing", lose the ability
     * to cancel, and no stall would have committed to anything — the coarse
     * status simply lied.
     *
     * Cancelling is the one thing that still belongs here, because it is a
     * decision about the order rather than a step in fulfilling it. Everything
     * else on a market order happens through the stall and rider routes.
     */
    if (order.market && status !== 'Cancelled') {
      throw new ApiError(
        409,
        'This order is fulfilled by a market. Its status follows the stalls and the rider, and cannot be set by hand.',
        'MARKET_ORDER_IMMUTABLE'
      );
    }

    if (order.market && status === 'Cancelled') {
      return cancelMarketOrder({ req, res, order });
    }

    /**
     * A delivery agent may only complete an order that is theirs.
     *
     * The visibility filter above already hides another agent's assignment, so
     * this is defence in depth — but it belongs at the call site, because the
     * consequence of getting it wrong is one agent closing another's delivery
     * and, for a COD order, flipping it to paid.
     */
    if (req.user.role === 'delivery') {
      const assignee = order.assignedTo ? order.assignedTo.toString() : null;
      if (assignee && assignee !== req.user._id.toHexString()) {
        throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
      }
      // Completing an unclaimed order claims it, so the record shows who did.
      if (!assignee) order.assignedTo = req.user._id;
    }

    // A customer may only cancel their own order, and only before preparation.
    if (req.user.role === 'customer') {
      if (order.customer.toString() !== req.user._id.toHexString()) {
        throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
      }
      if (status !== 'Cancelled' || order.status !== 'Pending') {
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

    // Refund a wallet-paid order when it is cancelled, idempotently.
    if (status === 'Cancelled' && order.paymentStatus === 'paid') {
      await wallet.credit({
        userId: order.customer,
        amountPaise: order.totalAmountPaise,
        reason: 'order_refund',
        idempotencyKey: `refund:${order._id.toHexString()}`,
        note: `Refund for ${order.orderNumber}`,
      });
      order.paymentStatus = 'refunded';

      await Promise.all(
        order.items.map((item) =>
          Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }).catch(() => {})
        )
      );
    }

    if (status === 'Delivered' && order.paymentMethod === 'cod') {
      order.paymentStatus = 'paid';
    }

    // NOTE: there was an auto-assign branch here for a `delivery` caller moving
    // an order to 'Out for Delivery'. It was unreachable — that transition is
    // restricted to staff by TRANSITION_PERMISSIONS above — and assignment is
    // now handled by /claim and by the Delivered branch.

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
    /**
     * Conditional update: only an unassigned order can be claimed, so two agents
     * racing for the same order cannot both win.
     *
     * Scoped to `market: null` — legacy orders only. A market order is offered
     * to one rider at a time, nearest first, and letting anyone grab it here
     * would undercut that cascade and hand the job to a rider who happened to
     * be watching the list rather than the one standing closest to the market.
     * Riders take those through POST /api/rider/orders/:id/accept.
     */
    const order = await Order.findOneAndUpdate(
      {
        _id: req.valid.params.id,
        assignedTo: null,
        market: null,
        status: { $in: ['Preparing', 'Out for Delivery'] },
      },
      { $set: { assignedTo: req.user._id } },
      { new: true }
    );
    if (!order) throw new ApiError(409, 'That order is no longer available to claim.', 'ALREADY_CLAIMED');
    return res.json({ data: order.toJSON() });
  }
);

module.exports = router;
