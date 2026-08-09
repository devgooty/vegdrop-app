'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const VendorKyc = require('../models/VendorKyc');
const { ApiError } = require('../middleware/errors');
const { withTransaction } = require('../db/connect');
const wallet = require('./wallet');
const sourcing = require('./sourcing');

/**
 * Placing an order, in one place.
 *
 * This was the body of `POST /api/orders` and nothing else could reach it.
 * Recurring deliveries need to place exactly the same order, at a moment when
 * the customer is not present to send a request — and the one thing a scheduler
 * must not do is re-derive prices, fees, stock rules or wallet handling from a
 * second implementation that drifts from the first. So the whole path lives
 * here and both callers go through it.
 *
 * Everything the caller supplies is an intent: which products, how many, where
 * to, and from whom. Every amount is computed here from the catalog or the
 * seller's own price sheet, exactly as before — a caller cannot influence a
 * total.
 */

const DELIVERY_FEE_PAISE = 2500; // ₹25
const FREE_DELIVERY_THRESHOLD_PAISE = 30000; // ₹300

/**
 * @param {object} params
 * @param {object} params.user        the customer, as a User document
 * @param {Array<{productId: string, quantity: number}>} params.items
 * @param {string} params.address
 * @param {'wallet'|'cod'} params.paymentMethod
 * @param {string} [params.marketId]  buy from this market's sheet
 * @param {string} [params.shopId]    buy from this independent shop — mutually
 *   exclusive with marketId; an order has one seller
 * @param {number} [params.lat]
 * @param {number} [params.lng]
 * @returns {Promise<object>} the created Order document
 */
async function placeOrder({ user, items, address, paymentMethod, marketId, shopId, lat, lng }) {
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
    quantities.set(String(productId), (quantities.get(String(productId)) || 0) + quantity);
  }
  for (const [productId, quantity] of quantities) {
    if (quantity > 99) {
      throw new ApiError(400, 'Quantity for a single product may not exceed 99.', 'VALIDATION_ERROR', [
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
   * the caller's shopId without re-checking would let a stale card keep
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
   * only the fallback for a marketless or shop order.
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
          { returnDocument: 'after', ...(session ? { session } : {}) }
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
          // Legacy and shop orders leave them null and nothing reads them.
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
          customer: user._id,
          customerName: user.name,
          // Falls back to an unverified number: a courier needs someone to
          // ring, and an account may hold a claimed-but-unproven one.
          phone: user.contactPhone(),
          address,
          items: lines,
          subtotalPaise,
          deliveryFeePaise,
          totalAmountPaise,
          paymentMethod,
          paymentStatus: 'pending',
          status: 'Pending',
          statusHistory: [{ status: 'Pending', at: new Date(), by: user._id }],

          /**
           * Stored for every order that supplies coordinates, not only market
           * ones. A marketless or shop order simply gains it, which is strictly
           * more for the rider to go on and costs nothing when absent.
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
          userId: user._id,
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
   * the caller's own response already reflects any instant acceptance — an
   * order every stall auto-accepts comes back locked, with nothing to wait for.
   */
  if (order.market) {
    await sourcing.offerRound(order._id, user._id).catch((err) => {
      // A failure here costs nothing: the sweeper still owns the deadline and
      // opens the round on its next tick. Never fail a paid checkout for it.
      console.warn(`[checkout] first stall round failed for ${order.orderNumber}: ${err.message}`);
    });
    return Order.findById(order._id);
  }

  return order;
}

module.exports = {
  placeOrder,
  DELIVERY_FEE_PAISE,
  FREE_DELIVERY_THRESHOLD_PAISE,
};
