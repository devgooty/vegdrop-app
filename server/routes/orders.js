'use strict';

const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const VendorKyc = require('../models/VendorKyc');
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
    const { items, address, paymentMethod, marketId, shopId, lat, lng } = req.valid.body;

    if (marketId && shopId) {
      throw new ApiError(
        400,
        'An order is placed with one seller: a market or a shop, not both.',
        'VALIDATION_ERROR'
      );
    }

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
     * Resolve the independent shop, and re-check everything that made it
     * listable.
     *
     * The customer's list could be minutes old, and each of these can change in
     * that window: the shopkeeper can pull the shutter down, be suspended, or —
     * the interesting one — be approved into a market, at which point they are
     * reached through that market and must stop taking direct orders. Trusting
     * the client's shopId without re-checking would let a stale card keep
     * selling.
     */
    let shopkeeper = null;
    if (shopId) {
      shopkeeper = await User.findOne({
        _id: shopId,
        role: 'shopkeeper',
        status: 'active',
        'shop.isOpen': true,
        'shop.location': { $exists: true },
      });
      if (!shopkeeper) {
        throw new ApiError(400, 'That shop is not open right now.', 'SHOP_UNAVAILABLE');
      }

      const kyc = await VendorKyc.findOne({ user: shopkeeper._id }).select('status').lean();
      if (kyc?.status !== 'verified') {
        throw new ApiError(400, 'That shop is not open right now.', 'SHOP_UNAVAILABLE');
      }

      if (await Stall.exists({ owner: shopkeeper._id, status: 'approved' })) {
        throw new ApiError(
          409,
          'That shop now trades at a market. Pick the market instead.',
          'SHOP_JOINED_MARKET'
        );
      }

      /**
       * Every line must belong to this shop. The shared platform catalog
       * (`owner: null`) is not theirs to sell, and a cart spanning two shops has
       * no single seller — the same reasoning as the mixed-market guard.
       */
      const foreign = products.find((p) => String(p.owner) !== String(shopkeeper._id));
      if (foreign) {
        throw new ApiError(
          400,
          'Your basket has items this shop does not sell.',
          'MIXED_SELLERS',
          [{ field: 'items', message: `${foreign.name} is not sold by this shop.` }]
        );
      }
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
            // explicitly-empty claim and offer so `claim.stall: null` and
            // `offer.stall: null` unambiguously mean unclaimed and unoffered.
            // Legacy orders leave them null and nothing reads them.
            ...(market
              ? {
                  lineId: new mongoose.Types.ObjectId(),
                  sourcePricePaise: unitPricePaise,
                  claim: sourcing.emptyClaim(),
                  offer: sourcing.emptyOffer(),
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

            /**
             * Stored for every order that supplies coordinates, not only market
             * ones. Market orders behaved this way already; a marketless or shop
             * order simply gains it, which is strictly more for the rider to go
             * on and costs nothing when absent.
             */
            ...(lat !== undefined && lng !== undefined
              ? { deliveryLocation: { type: 'Point', coordinates: [lng, lat] } }
              : {}),

            /**
             * An independent shop order stays marketless: no sourcing window, no
             * stall broadcast, no sweeper. It is the legacy single-shop path with
             * a named seller, so `status` stays Pending until that shopkeeper
             * accepts it by hand.
             */
            ...(shopkeeper ? { shop: shopkeeper._id, shopName: shopkeeper.shop.name } : {}),

            ...(market
              ? {
                  market: market._id,
                  marketName: market.name,
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
     * Open the first round of stall offers.
     *
     * Deliberately AFTER the transaction commits: a stall must never be shown,
     * or be able to claim, an order that could still be rolled back. Awaited so
     * the customer's own response already reflects any instant acceptance — an
     * order every stall auto-accepts comes back locked, with nothing to wait for.
     */
    if (order.market) {
      await sourcing.offerRound(order._id, req.user._id).catch((err) => {
        // A failure here costs nothing: the sweeper still owns the deadline and
        // opens the round on its next tick. Never fail a paid checkout for it.
        console.warn(`[orders] first stall round failed for ${order.orderNumber}: ${err.message}`);
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
      { new: true }
    );
    if (!order) throw new ApiError(409, 'That order is no longer available to claim.', 'ALREADY_CLAIMED');
    return res.json({ data: order.toJSON() });
  }
);

module.exports = router;
