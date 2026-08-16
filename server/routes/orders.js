'use strict';

const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const config = require('../config/env');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const wallet = require('../services/wallet');
const sourcing = require('../services/sourcing');
const checkout = require('../services/checkout');
const settlement = require('../services/settlement');
const dispatch = require('../services/dispatch');
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

/** Matches no document. Used when a caller has no scope at all. */
const MATCH_NOTHING = { _id: null };

/**
 * Restrict the query to what this caller is allowed to see.
 *
 * Async because a shopkeeper's scope depends on which stall they run, which is
 * a lookup. Every caller must await it.
 */
async function visibilityFilter(user) {
  if (user.role === 'developer') return {};

  /**
   * A market owner sees their own markets and nothing else.
   *
   * This used to return `{}` — every order in the system, with the customer's
   * name, phone and address on all of them. That was defensible only while
   * `market_owner` meant "administrator"; now that Market carries an `owner` and
   * anyone running a market holds the role, it is the same competitor-to-
   * competitor leak the shopkeeper branch below was scoped to close.
   *
   * Owning no market means seeing no orders. Deliberately not falling back to
   * the marketless legacy filter used below: an operator with nothing to run has
   * no claim on orders that merely happen to predate markets.
   */
  if (user.role === 'market_owner') {
    const owned = await Market.find({ owner: user._id }).select('_id').lean();
    if (owned.length === 0) return { _id: null };
    return { market: { $in: owned.map((m) => m._id) } };
  }

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
    const stall = await Stall.findOne({ owner: user._id, isActive: true, status: 'approved' })
      .select('_id market')
      .lean();

    /**
     * `{ market: null, shop: null }` is the legacy pool: orders placed before a
     * customer could name a seller. It stays shared by every shopkeeper because
     * that is what the original single-shop flow depends on, and `{ shop: null }`
     * matches documents written before the field existed, so nothing needs a
     * backfill.
     *
     * Narrowing it from a bare `{ market: null }` is what stops one independent
     * shop reading another's orders: without the extra clause, every order
     * addressed to a specific shop would also land in every other stall-less
     * shopkeeper's list.
     *
     * This clause can be dropped entirely once every client path sends either a
     * marketId or a shopId and any remaining legacy orders are closed out.
     */
    const legacyPool = { market: null, shop: null };

    // No stall: their own shop's orders, plus the legacy pool.
    if (!stall) return { $or: [{ shop: user._id }, legacyPool] };

    return {
      $or: [
        /**
         * Live sourcing in my market — but only what is actually addressed to
         * me, or has fallen through to the market-wide pool.
         *
         * This used to be every sourcing order in the market. Narrowing it is
         * what makes the ranked cascade real rather than advisory: a stall that
         * can see an order can also claim from it, so an unscoped clause here
         * would let any stall take lines that were offered to a better-ranked
         * one, and the ranking would decide nothing.
         */
        {
          market: stall.market,
          'fulfillment.status': 'sourcing',
          $or: [
            { 'items.offer.stall': stall._id },
            { 'fulfillment.stallOffer.openPool': true },
          ],
        },
        { 'items.claim.stall': stall._id },
        legacyPool,
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
        /**
         * Legacy marketless orders keep the original unclaimed-pool behaviour.
         *
         * Deliberately NOT narrowed by `shop`, unlike the shopkeeper branch
         * above: an independent shop has no market, so the dispatch cascade —
         * which picks the rider nearest a market — has no origin to work from.
         * The open pool is how a shop order reaches a rider at all.
         */
        { assignedTo: null, market: null, status: { $in: ['Preparing', 'Out for Delivery'] } },
      ],
    };
  }

  return { customer: user._id };
}

/**
 * Strip the customer's identity from an order before a shopkeeper sees it.
 *
 * `visibilityFilter` above decides WHICH orders each role may read; this decides
 * which FIELDS. A shopkeeper passed the filter and then received the whole
 * document — name, phone, delivery address, and the delivery coordinates.
 *
 * The market stall side never had this problem, because routes/stalls.js
 * projects a narrow shape by hand and deliberately never includes the customer:
 * a stall is being asked "can you supply 2kg of tomatoes", and the name, phone
 * and address belong to the rider's job. An independent shop is in exactly the
 * same position — it packs, and a rider carries — so the same rule applies. It
 * simply reached the customer through a different route, which is why it was
 * missed.
 *
 * Only `shopkeeper` is redacted. A delivery agent needs all of it to find the
 * door; a customer is reading their own order; `market_owner` and `developer`
 * are operator roles already scoped by the filter above.
 */
function redactForViewer(order, user) {
  if (user.role !== 'shopkeeper') return order;

  const {
    customerName: _name,
    phone: _phone,
    address: _address,
    // The customer's home as a coordinate pair — identifying on its own, and a
    // shopkeeper has no use for it.
    deliveryLocation: _location,
    ...rest
  } = order;

  return rest;
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
    return res.json({ data: orders.map((o) => redactForViewer(o.toJSON(), req.user)) });
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
    return res.json({ data: redactForViewer(order.toJSON(), req.user) });
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

        /**
         * Which independent shop to buy from — a shopkeeper's own user id, since
         * a shop outside any market cannot be a stall.
         *
         * Mutually exclusive with marketId: an order has one seller. Omit both
         * and this is still the legacy marketless order, unchanged.
         */
        shopId: fields.objectId.optional(),

        // Where it is going. Used to find the next nearest market if the first
        // one cannot fill the order. The customer app has had these in local
        // storage all along and simply never sent them.
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    /**
     * The whole of this handler lives in services/checkout.js — including the
     * independent-shop resolution, the market price-sheet lookup, the stock
     * claims, and the first round of stall offers.
     *
     * Recurring deliveries place the same order without a request to carry
     * it, and a second implementation of pricing, stock claiming, delivery
     * fees and wallet debiting would drift from this one the first time
     * either changed. One path, two callers.
     */
    const order = await checkout.placeOrder({ user: req.user, ...req.valid.body });
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
  const now = new Date();

  /**
   * The state change comes FIRST, and its guard decides everything after it.
   *
   * This used to refund before the update, reasoning that a lost race would be
   * replayed by whoever won. That holds only when the update is certain to
   * match something. It is not: `allowedStates` stops at `sourcing` for a
   * customer, so cancelling an order that has already locked — or been
   * delivered — matched nothing and threw 409 with the credit already written.
   * The customer kept the money and the groceries, on every attempt, for the
   * price of tapping cancel late.
   *
   * Refunding only once this update has actually matched makes the 409 path
   * cost nothing, and leaves a crash between the two as the sole failure mode —
   * see refundToWallet, and sweepPendingRefunds which cleans up after it.
   */
  const cancelled = await Order.findOneAndUpdate(
    { _id: order._id, 'fulfillment.status': { $in: allowedStates } },
    {
      $set: transitionTo('cancelled'),
      $push: {
        statusHistory: { status: 'Cancelled', at: now, by: req.user._id },
        'fulfillment.events': {
          $each: [{ at: now, type: 'cancelled', note: isCustomer ? 'by customer' : 'by staff' }],
          $slice: -50,
        },
      },
    },
    { returnDocument: 'after' }
  );

  if (!cancelled) {
    throw new ApiError(
      409,
      'This order is already being packed and can no longer be cancelled.',
      'ORDER_LOCKED'
    );
  }

  await sourcing.refundToWallet(cancelled);

  // Hand the produce back: stall queues shrink, and the catalog is restocked.
  await sourcing.releaseClaims(cancelled);
  await Promise.all(
    cancelled.items.map((item) =>
      Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }).catch(() => {})
    )
  );

  return res.json({ data: redactForViewer(cancelled.toJSON(), req.user) });
}

// ---------------------------------------------------------------------------
// "Only some of your items are available"
// ---------------------------------------------------------------------------

/**
 * Resolve an order parked in `partial_review` for the customer who placed it.
 *
 * Staff are deliberately excluded. This is a question about whether a smaller
 * basket is still worth buying, and only the person paying can answer it — a
 * market owner tapping "continue" on someone else's behalf would be committing
 * them to a purchase they did not agree to.
 */
async function loadPartialOrder(req) {
  const order = await Order.findOne({
    _id: req.valid.params.id,
    customer: req.user._id,
  }).select('_id fulfillment.status');

  if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

  if (order.fulfillment?.status !== 'partial_review') {
    throw new ApiError(
      409,
      'This order is no longer waiting on your decision.',
      'NOT_PARTIAL'
    );
  }

  return order;
}

/**
 * Send what is available. The rest is dropped and refunded.
 *
 * The same call the sweeper makes when the customer never answers, so there is
 * exactly one implementation of "settle a partial order" and no chance of the
 * timeout path and the button path disagreeing about the money.
 */
router.post(
  '/:id/partial/accept',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await loadPartialOrder(req);
    const result = await sourcing.acceptPartial(order._id, req.user._id);

    if (!result.accepted) {
      throw new ApiError(409, 'This order is no longer waiting on your decision.', result.reason);
    }

    return res.json({
      data: {
        ...result.order.toJSON(),
        refundPaise: result.refundPaise,
        droppedCount: result.dropped,
      },
    });
  }
);

/**
 * Look somewhere else instead.
 *
 * Everything claimed here is handed back, so the stalls holding produce for
 * this order are released rather than left waiting on a customer who has moved
 * on. Fails cleanly when there is no other market to try — the honest answer at
 * that point is that continuing or cancelling are the only options left.
 */
router.post(
  '/:id/partial/retry',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await loadPartialOrder(req);
    const result = await sourcing.retryPartial(order._id);

    if (!result.retried) {
      const message =
        result.reason === 'NO_MARKET' || result.reason === 'NO_ATTEMPTS_LEFT'
          ? 'No other market nearby can fill the rest of this order.'
          : 'This order is no longer waiting on your decision.';
      throw new ApiError(409, message, result.reason);
    }

    return res.json({ data: result.order.toJSON() });
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
     * A shopkeeper may only drive an order addressed to their own shop.
     *
     * Same shape and same reasoning as the delivery check below: the visibility
     * filter already hides a competitor's order, but the consequence of getting
     * it wrong is one shopkeeper running another's order and, for a COD one,
     * flipping it to paid. Orders with no shop are the legacy pool, which every
     * shopkeeper is still allowed to work.
     */
    if (req.user.role === 'shopkeeper' && order.shop) {
      if (order.shop.toString() !== req.user._id.toHexString()) {
        throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
      }
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

    /**
     * The customer has the goods, so the shop has earned its money.
     *
     * The market equivalent lives in services/dispatch.js, on the rider's
     * completion. This branch had no equivalent at all, so an independent shop
     * was paid for nothing it sold through the app — the customer's wallet was
     * debited and no obligation was ever written.
     *
     * Same shape as the dispatch call deliberately: awaited because it is
     * money, but never allowed to fail a delivery that genuinely happened. The
     * sweeper's backfill picks up anything left with `settledAt` unset.
     */
    if (status === 'Delivered' && order.shop) {
      try {
        await settlement.recordDelivery(order._id);
      } catch (err) {
        console.warn(`[orders] settlement for ${order.orderNumber} deferred: ${err.message}`);
      }
    }

    /**
     * The shopkeeper just confirmed a real order, so it is worth a rider's
     * time to go get it. Without this it sat in the open pool, visible to
     * every on-duty agent at once, with nothing telling any of them it was
     * worth checking until one happened to look — see dispatch.js for why
     * the nearest one is handed the job directly rather than asked.
     *
     * Same shape as the settlement call above: awaited because the whole
     * point is that this happens now, but never allowed to fail the
     * confirmation itself. The sweeper's retry picks up anything this missed.
     */
    if (status === 'Preparing' && order.shop) {
      try {
        await dispatch.offerShopOrderToNearestRider(order._id);
      } catch (err) {
        console.warn(`[orders] shop dispatch for ${order.orderNumber} deferred: ${err.message}`);
      }
    }

    return res.json({ data: redactForViewer(order.toJSON(), req.user) });
  }
);

/**
 * Where the assigned rider is right now, for the shop (or market office) that
 * is waiting on them — while the order is still on `visibilityFilter`'s list
 * for this caller, same as every other read here.
 *
 * Rider-only, not customer-facing: a shop packing an order has a legitimate
 * reason to know whether the pickup is two minutes away, the same reason
 * `redactForViewer` draws the opposite line for the customer's own address —
 * an operational agent's position is not the private fact a stranger's home is.
 *
 * `null` covers three unremarkable states alike — no rider assigned yet, one
 * assigned but no GPS fix yet, or a fix old enough that dispatch itself would
 * treat the rider as gone (`riderStaleLocationSeconds`, the same cutoff
 * services/dispatch.js uses to decide who is even offered a job) — so a
 * shopkeeper never reads a stale pin as a live one.
 */
router.get(
  '/:id/rider-location',
  requireAuth,
  requireRole('shopkeeper', 'market_owner', 'developer'),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await Order.findOne({ _id: req.valid.params.id, ...(await visibilityFilter(req.user)) })
      .select('assignedTo')
      .lean();
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
    if (!order.assignedTo) return res.json({ data: null });

    const rider = await User.findById(order.assignedTo)
      .select('rider.lastLocation rider.lastLocationAt')
      .lean();
    const point = rider?.rider?.lastLocation;
    const seenAt = rider?.rider?.lastLocationAt;
    const stale = !seenAt || seenAt.getTime() < Date.now() - config.marketplace.riderStaleLocationSeconds * 1000;
    if (!point?.coordinates || stale) return res.json({ data: null });

    return res.json({
      data: { lat: point.coordinates[1], lng: point.coordinates[0], updatedAt: seenAt },
    });
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
     * Scoped to `market: null` — legacy and independent-shop orders. A market
     * order is offered to one rider at a time, nearest first, and letting anyone
     * grab it here would undercut that cascade and hand the job to a rider who
     * happened to be watching the list rather than the one standing closest to
     * the market. Riders take those through POST /api/rider/orders/:id/accept.
     *
     * An independent shop belongs on this side on purpose: it has no market, so
     * there is no origin for the cascade to measure from.
     */
    const order = await Order.findOneAndUpdate(
      {
        _id: req.valid.params.id,
        assignedTo: null,
        market: null,
        status: { $in: ['Preparing', 'Out for Delivery'] },
      },
      { $set: { assignedTo: req.user._id } },
      { returnDocument: 'after' }
    );
    if (!order) throw new ApiError(409, 'That order is no longer available to claim.', 'ALREADY_CLAIMED');
    return res.json({ data: order.toJSON() });
  }
);

module.exports = router;
