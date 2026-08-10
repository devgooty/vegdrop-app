'use strict';

const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const wallet = require('../services/wallet');
const sourcing = require('../services/sourcing');
const checkout = require('../services/checkout');
const settlement = require('../services/settlement');
const pickupCode = require('../services/pickupCode');
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
 * A customer is reading their own order; `market_owner` and `developer` are
 * operator roles already scoped by the filter above. The two roles that get
 * reshaped here are `shopkeeper`, which never sees the customer, and
 * `delivery`, which sees them only after proving it turned up.
 */
function redactForViewer(order, user) {
  if (user.role === 'shopkeeper') {
    const {
      customerName: _name,
      phone: _phone,
      address: _address,
      // The customer's home as a coordinate pair — identifying on its own, and a
      // shopkeeper has no use for it.
      deliveryLocation: _location,
      ...rest
    } = order;

    /**
     * The handover code, for the shopkeeper to read out to the rider.
     *
     * Market orders are not shaped here at all — a stall gets its code from
     * routes/stalls.js, per stall, because a market order is collected from
     * several. This is the single-seller equivalent.
     *
     * Dropped once the rider has proved pickup: a spent code left on screen is
     * a number waiting to be overheard.
     */
    if (!rest.market && !rest.handover?.pickedUpAt) {
      rest.pickupCode = pickupCode.codeFor(rest.id || rest._id, pickupCode.sellerKeyFor(rest));
      rest.pickupAttemptsRemaining = Math.max(
        0,
        pickupCode.MAX_ATTEMPTS - (rest.handover?.attempts || 0)
      );
    }

    return rest;
  }

  if (user.role === 'delivery') {
    /**
     * A delivery agent used to receive the customer's name, phone and door on
     * every order the filter let through — which, for a shop order, is the
     * whole unclaimed pool. Any agent on duty could read the addresses of
     * orders they had not claimed and were never going to carry.
     *
     * Now it takes the same proof the market side takes: the handover code from
     * the shop. Until that is entered, an agent gets everything they need to
     * decide and find the shop, and nothing that identifies the customer.
     *
     * Market orders pass through untouched — they are shaped by routes/rider.js,
     * which applies its own equivalent gate, and this list view is not where a
     * rider works one.
     */
    /**
     * Deliberately NOT unlocked by `status === 'Delivered'`.
     *
     * That would have been a way straight through the gate rather than a
     * sensible allowance for history: an agent can reach an unclaimed order in
     * the pool, and the Delivered branch of PATCH /:id/status claims it for
     * whoever closes it. So "mark it delivered, then read the address" would
     * have worked, and it is exactly the move this gate exists to stop.
     *
     * History still reads correctly, because an order that was genuinely
     * carried has `pickedUpAt` set — the rider proved it at the shop door. One
     * that does not was never picked up by this agent, and there is nothing to
     * show them.
     */
    const unlocked = Boolean(order.market) || Boolean(order.handover?.pickedUpAt);

    if (unlocked) return order;

    const {
      customerName: _name,
      phone: _phone,
      address: _address,
      deliveryLocation: _location,
      ...rest
    } = order;

    // Named so the screen can tell "withheld" from "never recorded". Those are
    // the same blank otherwise, and one of them looks like a broken app.
    rest.customerLocked = true;
    return rest;
  }

  return order;
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
      /**
       * You cannot deliver what you never picked up.
       *
       * Without this the pickup code would be skippable rather than required:
       * an agent could reach an unclaimed order in the pool and close it
       * outright, which both falsifies the record and — before the gate in
       * `redactForViewer` above stopped honouring `Delivered` — was a way to
       * unlock the customer's address without ever visiting the shop.
       *
       * Market orders are exempt because they do not come through here at all:
       * their status is derived, PATCH refuses to touch them, and their
       * equivalent proof is the per-stall code in POST /rider/orders/:id/collect.
       */
      if (status === 'Delivered' && !order.market && !order.handover?.pickedUpAt) {
        throw new ApiError(
          409,
          'Enter the shop’s handover code before marking this delivered.',
          'PICKUP_NOT_VERIFIED'
        );
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

    return res.json({ data: redactForViewer(order.toJSON(), req.user) });
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
    return res.json({ data: redactForViewer(order.toJSON(), req.user) });
  }
);

/**
 * Picked up from the shop, proved by the code on the shopkeeper's screen.
 *
 * The single-seller counterpart to `POST /api/rider/orders/:id/collect`. Same
 * bargain: the code is only visible to the shop holding the bags, so entering
 * it is evidence the rider is standing there, and it is what unlocks the
 * customer's name, phone and door.
 *
 * It also moves the order to `Out for Delivery`, which is a small correction on
 * its own. That transition was the shopkeeper's to make, so the record said the
 * order had left when the shop said so rather than when it actually left. The
 * shopkeeper keeps the permission — this does not take it away — but the rider
 * pushing it is the truer signal, and now the two agree.
 */
router.post(
  '/:id/pickup',
  requireAuth,
  requireRole('delivery'),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        code: z
          .string()
          .trim()
          .regex(
            new RegExp(`^\\d{${pickupCode.CODE_LENGTH}}$`),
            `Enter the ${pickupCode.CODE_LENGTH}-digit code from the shop.`
          ),
      })
      .strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;

    /**
     * Establish this rider owns the pickup BEFORE spending an attempt, exactly
     * as `dispatch.collectStall` does. Otherwise any agent could burn another's
     * allowance on an order they have nothing to do with and lock the handover.
     */
    const held = await Order.findOne({
      _id: id,
      assignedTo: req.user._id,
      market: null,
      status: { $in: ['Preparing', 'Out for Delivery'] },
    });

    if (!held) {
      throw new ApiError(404, 'That order is not yours to pick up.', 'NOT_YOURS');
    }

    if (held.handover?.pickedUpAt) {
      return res.json({ data: redactForViewer(held.toJSON(), req.user) });
    }

    // Counted before the comparison: a crash in between must cost the guesser
    // an attempt, not hand them a free one.
    const bumped = await Order.findOneAndUpdate(
      { _id: held._id, 'handover.attempts': { $lt: pickupCode.MAX_ATTEMPTS } },
      { $inc: { 'handover.attempts': 1 } },
      { returnDocument: 'after' }
    );

    if (!bumped) {
      throw new ApiError(
        429,
        'Too many incorrect codes. Ask the shop to reset the handover.',
        'PICKUP_ATTEMPTS_EXCEEDED'
      );
    }

    if (!pickupCode.matches(held._id, pickupCode.sellerKeyFor(held), req.valid.body.code)) {
      const remaining = Math.max(0, pickupCode.MAX_ATTEMPTS - bumped.handover.attempts);
      throw new ApiError(
        400,
        remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'Incorrect code. Ask the shop to reset it.',
        'PICKUP_CODE_INVALID'
      );
    }

    const now = new Date();
    const picked = await Order.findOneAndUpdate(
      { _id: held._id, assignedTo: req.user._id, 'handover.pickedUpAt': null },
      {
        $set: {
          'handover.pickedUpAt': now,
          'handover.attempts': 0,
          status: 'Out for Delivery',
        },
        $push: { statusHistory: { status: 'Out for Delivery', at: now, by: req.user._id } },
      },
      { returnDocument: 'after' }
    );

    if (!picked) {
      throw new ApiError(409, 'That pickup was already recorded.', 'ALREADY_PICKED_UP');
    }

    return res.json({ data: redactForViewer(picked.toJSON(), req.user) });
  }
);

/**
 * Clear a handover the rider has locked with wrong codes.
 *
 * Given to the shop rather than the rider for the reason the code exists at
 * all: if the person being checked could clear their own failures, the check
 * would be unlimited guesses wearing a hat. The shopkeeper is already face to
 * face with them and can read the number out again.
 *
 * Scoped through `visibilityFilter`, so a shopkeeper can only reset a handover
 * on an order they can see.
 */
router.post(
  '/:id/handover/reset',
  requireAuth,
  requireRole('shopkeeper', 'market_owner', 'developer'),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await Order.findOne({
      _id: req.valid.params.id,
      market: null,
      ...(await visibilityFilter(req.user)),
    });

    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    await Order.updateOne({ _id: order._id }, { $set: { 'handover.attempts': 0 } });

    return res.json({
      data: {
        reset: true,
        attemptsRemaining: pickupCode.MAX_ATTEMPTS,
        // Re-sent so the shopkeeper can read it out without hunting for it.
        pickupCode: pickupCode.codeFor(order._id, pickupCode.sellerKeyFor(order)),
      },
    });
  }
);

module.exports = router;
