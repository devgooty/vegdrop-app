'use strict';

const express = require('express');
const config = require('../config/env');
const ScheduledOrder = require('../models/ScheduledOrder');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Order = require('../models/Order');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeNextRunFor } = require('../models/ScheduledOrder');

const router = express.Router();

/**
 * Standing orders.
 *
 * Every route here is scoped to `customer: req.user._id` in the FILTER, never
 * checked after loading — the same rule the rest of the API follows, so quoting
 * somebody else's schedule id reaches nothing rather than reaching it and then
 * being refused.
 */
const customerGate = [requireAuth, requireRole('customer', 'developer')];

/**
 * What a schedule looks like to the person who owns it.
 *
 * `names` maps product id → name, so the card can say "2x Tomato" instead of an
 * ObjectId. Names are identity and safe to denormalise; PRICES deliberately are
 * not sent, because a schedule does not have one — each run is priced from the
 * market's sheet on the morning it ships.
 */
function asSchedule(schedule, names = new Map()) {
  return {
    id: String(schedule._id),
    marketId: schedule.market ? String(schedule.market) : null,
    items: (schedule.items || []).map((line) => ({
      productId: String(line.product),
      quantity: line.quantity,
      name: names.get(String(line.product)) || null,
    })),
    address: schedule.address,
    paymentMethod: schedule.paymentMethod,
    frequency: schedule.frequency,
    daysOfWeek: schedule.daysOfWeek || [],
    daysOfMonth: schedule.daysOfMonth || [],
    hour: schedule.hour,
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastOrder: schedule.lastOrder ? String(schedule.lastOrder) : null,
    runCount: schedule.runCount,
    // Reported rather than swallowed: a schedule that quietly stopped is
    // discovered by the vegetables not arriving.
    lastFailure: schedule.lastFailure?.at
      ? {
          at: schedule.lastFailure.at,
          code: schedule.lastFailure.code,
          message: schedule.lastFailure.message,
        }
      : null,
  };
}

/** Product names for a set of schedules, in one query. */
async function namesFor(schedules) {
  const ids = schedules.flatMap((s) => (s.items || []).map((line) => line.product));
  if (ids.length === 0) return new Map();
  const products = await Product.find({ _id: { $in: ids } }).select('name').lean();
  return new Map(products.map((p) => [String(p._id), p.name]));
}

const scheduleBody = z
  .object({
    items: z
      .array(z.object({ productId: fields.objectId, quantity: z.number().int().min(1).max(99) }).strict())
      .min(1)
      .max(50),
    address: fields.nonEmptyString(500),
    paymentMethod: z.enum(['wallet', 'cod']),
    marketId: fields.objectId.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    daysOfMonth: z.array(z.number().int().min(1).max(31)).max(31).optional(),
    hour: z.number().int().min(0).max(23).optional(),
  })
  .strict();

router.get('/', ...customerGate, async (req, res) => {
  const schedules = await ScheduledOrder.find({
    customer: req.user._id,
    status: { $ne: 'cancelled' },
  })
    .sort({ nextRunAt: 1 })
    .lean();

  const names = await namesFor(schedules);
  return res.json({ data: schedules.map((s) => asSchedule(s, names)) });
});

/**
 * Create a standing order.
 *
 * Validated against the catalog and the market NOW, so an impossible schedule
 * is refused while the customer is still looking at it rather than failing
 * silently at six in the morning three weeks later.
 */
router.post(
  '/',
  ...customerGate,
  validate({ body: scheduleBody }),
  async (req, res) => {
    /**
     * Checked before anything is validated or written. GET, PATCH and DELETE
     * stay open on purpose: locking must never strand someone with a standing
     * order they cannot look at or cancel. Only *new* ones are refused.
     */
    if (config.scheduledOrdersLocked) {
      throw new ApiError(403, 'Scheduled deliveries are not available right now.', 'SCHEDULES_LOCKED');
    }

    const { items, address, paymentMethod, marketId, lat, lng, frequency, hour } = req.valid.body;
    const daysOfWeek = req.valid.body.daysOfWeek || [];
    const daysOfMonth = req.valid.body.daysOfMonth || [];

    if (frequency === 'weekly' && daysOfWeek.length === 0) {
      throw new ApiError(400, 'Pick at least one day of the week.', 'VALIDATION_ERROR');
    }
    if (frequency === 'monthly' && daysOfMonth.length === 0) {
      throw new ApiError(400, 'Pick at least one day of the month.', 'VALIDATION_ERROR');
    }

    const productIds = [...new Set(items.map((i) => String(i.productId)))];
    const known = await Product.countDocuments({ _id: { $in: productIds }, isActive: true });
    if (known !== productIds.length) {
      throw new ApiError(400, 'One or more products are unavailable.', 'PRODUCT_UNAVAILABLE');
    }

    if (marketId) {
      const market = await Market.findOne({ _id: marketId, isActive: true }).select('_id').lean();
      if (!market) throw new ApiError(400, 'That market is not available.', 'MARKET_UNAVAILABLE');
    }

    const draft = { frequency, hour: hour ?? 8, daysOfWeek, daysOfMonth };
    const nextRunAt = computeNextRunFor(draft, new Date());
    if (!nextRunAt) {
      throw new ApiError(400, 'Those days never come round. Pick different ones.', 'VALIDATION_ERROR');
    }

    const schedule = await ScheduledOrder.create({
      customer: req.user._id,
      market: marketId || null,
      items: items.map((i) => ({ product: i.productId, quantity: i.quantity })),
      address,
      ...(lat !== undefined && lng !== undefined
        ? { deliveryLocation: { type: 'Point', coordinates: [lng, lat] } }
        : {}),
      paymentMethod,
      frequency,
      daysOfWeek,
      daysOfMonth,
      hour: hour ?? 8,
      nextRunAt,
    });

    return res.status(201).json({ data: asSchedule(schedule, await namesFor([schedule])) });
  }
);

/**
 * Pause or resume.
 *
 * Resuming recomputes `nextRunAt` from now rather than restoring the old one:
 * a schedule paused for a fortnight would otherwise come back already overdue
 * and immediately place an order the customer did not expect.
 */
router.patch(
  '/:id',
  ...customerGate,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ status: z.enum(['active', 'paused']) }).strict(),
  }),
  async (req, res) => {
    const schedule = await ScheduledOrder.findOne({
      _id: req.valid.params.id,
      customer: req.user._id,
      status: { $ne: 'cancelled' },
    });
    if (!schedule) throw new ApiError(404, 'No such schedule.', 'NOT_FOUND');

    schedule.status = req.valid.body.status;
    if (schedule.status === 'active') {
      schedule.nextRunAt = computeNextRunFor(schedule, new Date());
    }
    await schedule.save();

    return res.json({ data: asSchedule(schedule, await namesFor([schedule])) });
  }
);

/**
 * Cancel.
 *
 * Marked rather than deleted: `lastOrder` links the orders it already placed,
 * and destroying the row would orphan that history for a customer asking why a
 * delivery arrived.
 */
router.delete(
  '/:id',
  ...customerGate,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const cancelled = await ScheduledOrder.findOneAndUpdate(
      { _id: req.valid.params.id, customer: req.user._id, status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled' } }
    );
    if (!cancelled) throw new ApiError(404, 'No such schedule.', 'NOT_FOUND');

    return res.status(204).end();
  }
);

/** The orders one schedule has actually produced. */
router.get(
  '/:id/orders',
  ...customerGate,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const schedule = await ScheduledOrder.findOne({
      _id: req.valid.params.id,
      customer: req.user._id,
    })
      .select('_id')
      .lean();
    if (!schedule) throw new ApiError(404, 'No such schedule.', 'NOT_FOUND');

    const orders = await Order.find({ schedule: schedule._id, customer: req.user._id })
      .sort({ createdAt: -1 })
      .limit(30);

    return res.json({ data: orders.map((o) => o.toJSON()) });
  }
);

module.exports = router;
