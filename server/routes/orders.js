'use strict';

const express = require('express');
const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTransaction } = require('../db/connect');
const wallet = require('../services/wallet');

const router = express.Router();

const STAFF_ROLES = ['shopkeeper', 'market_owner', 'developer'];

/**
 * Which roles may drive which status transition. Enforced in addition to the
 * transition graph on the model, so a delivery agent cannot mark an order
 * Preparing and a customer cannot mark their own order Delivered.
 */
const TRANSITION_PERMISSIONS = {
  Preparing: ['shopkeeper', 'market_owner', 'developer'],
  'Out for Delivery': ['shopkeeper', 'market_owner', 'developer'],
  Delivered: ['delivery', 'market_owner', 'developer'],
  Cancelled: ['customer', 'shopkeeper', 'market_owner', 'developer'],
};

const DELIVERY_FEE_PAISE = 2500; // ₹25
const FREE_DELIVERY_THRESHOLD_PAISE = 30000; // ₹300

/** Restrict the query to what this caller is allowed to see. */
function visibilityFilter(user) {
  if (STAFF_ROLES.includes(user.role)) return {};
  if (user.role === 'delivery') {
    return { $or: [{ assignedTo: user._id }, { status: { $in: ['Out for Delivery', 'Preparing'] } }] };
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

    const filter = visibilityFilter(req.user);
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
    const order = await Order.findOne({ _id: req.valid.params.id, ...visibilityFilter(req.user) });
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
      })
      .strict(),
  }),
  async (req, res) => {
    const { items, address, paymentMethod } = req.valid.body;

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

          const lineTotalPaise = product.pricePaise * quantity;
          subtotalPaise += lineTotalPaise;
          lines.push({
            product: product._id,
            name: product.name,
            unitPricePaise: product.pricePaise,
            quantity,
            lineTotalPaise,
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
            phone: req.user.phone,
            address,
            items: lines,
            subtotalPaise,
            deliveryFeePaise,
            totalAmountPaise,
            paymentMethod,
            paymentStatus: paymentMethod === 'cod' ? 'pending' : 'pending',
            status: 'Pending',
            statusHistory: [{ status: 'Pending', at: new Date(), by: req.user._id }],
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

    return res.status(201).json({ data: order.toJSON() });
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
      { _id: req.valid.params.id, assignedTo: null, status: { $in: ['Preparing', 'Out for Delivery'] } },
      { $set: { assignedTo: req.user._id } },
      { new: true }
    );
    if (!order) throw new ApiError(409, 'That order is no longer available to claim.', 'ALREADY_CLAIMED');
    return res.json({ data: order.toJSON() });
  }
);

module.exports = router;
