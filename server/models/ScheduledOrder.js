'use strict';

const mongoose = require('mongoose');

/**
 * A standing order: this basket, from this market, on these days.
 *
 * WHY THIS EXISTS
 *
 * The customer app has had a full scheduling interface since it was written —
 * a calendar, daily/weekly/monthly frequencies, a list of "Active" schedules —
 * and it was held entirely in React state. Nothing was sent anywhere, no model
 * existed, and a reload cleared it. The screen said "schedule created
 * successfully" and then nothing was ever delivered.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 *
 * Only the INTENT: which products, how many, where to, and when. No prices, no
 * totals, no delivery fee. Those are computed by services/checkout.js at the
 * moment each order is actually placed, from the market's price sheet as it
 * stands that morning — which is the only correct answer for a basket ordered
 * weeks in advance. Storing a total at creation time would promise a price the
 * market never agreed to.
 */
const scheduledLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
  },
  { _id: false }
);

const scheduledOrderSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * The market to buy from. Optional for the same reason it is optional on an
     * order: omitted, the schedule places a marketless order priced from the
     * platform catalog, exactly as the legacy flow does.
     */
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', default: null },

    items: {
      type: [scheduledLineSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0 && items.length <= 50,
        message: 'A schedule must contain between 1 and 50 items.',
      },
    },

    address: { type: String, required: true, trim: true, maxlength: 500 },
    deliveryLocation: { type: require('./geoPoint'), default: undefined },

    /**
     * How the order will be paid when it runs.
     *
     * Deliberately not `razorpay`: that flow needs the customer present to
     * complete a payment, and the entire point of a schedule is that they are
     * not. COD needs nothing; wallet is charged from the ledger balance at run
     * time and simply fails the run if it is short (see services/scheduler.js).
     */
    paymentMethod: { type: String, required: true, enum: ['wallet', 'cod'], default: 'cod' },

    frequency: { type: String, required: true, enum: ['daily', 'weekly', 'monthly'] },

    /**
     * Which days of the week this runs on, 0=Sunday..6=Saturday.
     *
     * Used by `weekly`. `daily` ignores it and `monthly` uses `daysOfMonth`.
     * Held as a set of weekdays rather than a list of absolute dates because a
     * standing order recurs — a fixed list would silently expire.
     */
    daysOfWeek: { type: [Number], default: [] },

    /** Which days of the month, 1..31. Used by `monthly`. */
    daysOfMonth: { type: [Number], default: [] },

    /** Local hour of day the order should be placed. */
    hour: { type: Number, default: 8, min: 0, max: 23 },

    status: {
      type: String,
      required: true,
      enum: ['active', 'paused', 'cancelled'],
      default: 'active',
      index: true,
    },

    /**
     * When this next becomes due. THE field the scheduler queries and advances.
     *
     * Advancing it is what makes a run idempotent: the sweeper's conditional
     * update matches on the exact value it read, so two instances ticking at the
     * same instant resolve to one winner and the loser places nothing. Same
     * pattern as the rider offer in services/dispatch.js.
     */
    nextRunAt: { type: Date, required: true, index: true },

    lastRunAt: { type: Date, default: null },
    /** The most recent order this produced, so the customer can follow it. */
    lastOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    runCount: { type: Number, default: 0, min: 0 },

    /**
     * Why the last run did not produce an order.
     *
     * Kept and shown rather than swallowed: a schedule that silently stops is
     * the worst outcome here, because the customer is relying on vegetables
     * arriving and finds out by them not arriving. "Your wallet was short" is
     * something they can act on.
     */
    lastFailure: {
      at: { type: Date, default: null },
      code: { type: String, default: null, maxlength: 60 },
      message: { type: String, default: null, maxlength: 300 },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/** The scheduler's query: everything active and due, oldest first. */
scheduledOrderSchema.index({ status: 1, nextRunAt: 1 });

scheduledOrderSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/**
 * The next moment this schedule should run, strictly after `from`.
 *
 * Walks forward a day at a time rather than doing modular arithmetic. A month
 * is not a fixed number of days, "the 31st" does not exist in February, and
 * daylight-saving shifts move the hour — walking the calendar gets all three
 * right for the cost of at most 366 cheap iterations, and is obviously correct
 * on inspection, which matters more here than the microseconds.
 */
scheduledOrderSchema.methods.computeNextRun = function computeNextRun(from = new Date()) {
  return computeNextRunFor(this, from);
};

function computeNextRunFor(schedule, from = new Date()) {
  const { frequency, hour } = schedule;
  const daysOfWeek = schedule.daysOfWeek || [];
  const daysOfMonth = schedule.daysOfMonth || [];

  const matches = (date) => {
    if (frequency === 'daily') return true;
    if (frequency === 'weekly') return daysOfWeek.includes(date.getDay());
    if (frequency === 'monthly') return daysOfMonth.includes(date.getDate());
    return false;
  };

  const candidate = new Date(from);
  candidate.setHours(hour, 0, 0, 0);
  // Strictly after `from`: a schedule that has just run must not match the
  // moment it ran and fire again immediately.
  if (candidate <= from) candidate.setDate(candidate.getDate() + 1);

  // A full year of lookahead. A weekly schedule with no weekdays selected, or a
  // monthly one asking only for the 31st, could otherwise loop for ever.
  for (let i = 0; i < 366; i += 1) {
    if (matches(candidate)) return candidate;
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, 0, 0, 0);
  }

  return null;
}

module.exports = mongoose.model('ScheduledOrder', scheduledOrderSchema);
module.exports.computeNextRunFor = computeNextRunFor;
