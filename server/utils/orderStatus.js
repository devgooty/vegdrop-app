'use strict';

/**
 * The bridge between the two status fields on an Order.
 *
 * `fulfillment.status` is authoritative and fine-grained — it knows the
 * difference between "stalls are still deciding" and "everything is bagged and
 * waiting for a rider". `status` is the original coarse enum that the customer,
 * shopkeeper and delivery apps already render, and it stays exactly as it was.
 *
 * WHY A PLAIN FUNCTION AND NOT A MONGOOSE HOOK
 *
 * Nearly every transition in the sourcing engine is a conditional
 * `findOneAndUpdate` — that is what makes the claim race safe. A `pre('save')`
 * hook would never fire for any of them, and a `pre('findOneAndUpdate')` hook
 * would have to reverse-engineer the caller's intent out of a raw update object
 * that may be shaped `$set['fulfillment.status']`, `$set.fulfillment`, or a
 * whole replacement document.
 *
 * So instead: every call site that moves `fulfillment.status` writes
 * `status: deriveCoarseStatus(next)` into the SAME `$set`. One atomic document
 * update carries both, so the two fields cannot drift — not by convention, but
 * because there is no moment in between where they could.
 */

const FULFILLMENT_STATUSES = Object.freeze([
  'sourcing',       // offered to the market's stalls, nobody committed yet
  'partial_review', // some lines taken, market exhausted, waiting on the customer
  'packing',        // every line claimed; locked; stalls are bagging
  'awaiting_rider', // everything packed, nobody to carry it yet
  'collecting',     // rider at the market walking stall to stall
  'dispatched',     // rider has everything and has left
  'delivered',
  'failed',         // no market could source it
  'cancelled',
]);

/**
 * Fine-grained state → the coarse enum on Order.status.
 *
 * Note that `failed` and `cancelled` both roll up to `Cancelled`. They are
 * distinct underneath because one is the customer's choice and the other is our
 * failure, and the refund note and the message the customer sees differ.
 */
const FULFILLMENT_TO_STATUS = Object.freeze({
  sourcing: 'Pending',
  /**
   * Still Pending, deliberately.
   *
   * Nothing has been committed to the customer yet — they are being asked
   * whether a smaller order is acceptable, and may still cancel outright. The
   * coarse status is what the delivery app filters on, and a rider must not see
   * an order whose contents are not yet settled.
   */
  partial_review: 'Pending',
  packing: 'Preparing',
  ready: 'Preparing',
  awaiting_rider: 'Preparing',
  collecting: 'Preparing',
  dispatched: 'Out for Delivery',
  delivered: 'Delivered',
  failed: 'Cancelled',
  cancelled: 'Cancelled',
});

/**
 * States a customer may still walk away from. Beyond these, stalls have committed.
 *
 * `partial_review` is cancellable precisely because it is the moment we admit we
 * cannot supply what was ordered. Offering "continue with 3 of 5" without also
 * offering "forget it" would be trapping someone in a purchase they did not
 * make. The claimed lines are released and refunded in full, as with any other
 * cancellation from `sourcing`.
 */
const CANCELLABLE_BY_CUSTOMER = Object.freeze(['sourcing', 'partial_review']);

/** States staff may still call off, refunding the customer. */
const CANCELLABLE_BY_STAFF = Object.freeze([
  'sourcing',
  'partial_review',
  'packing',
  'ready',
  'awaiting_rider',
  'collecting',
]);

/**
 * @param {string} fulfillmentStatus
 * @returns {'Pending'|'Preparing'|'Out for Delivery'|'Delivered'|'Cancelled'}
 * @throws {Error} on an unknown state — a typo must fail loudly here rather than
 *   writing an empty `status` that every downstream filter silently misses.
 */
function deriveCoarseStatus(fulfillmentStatus) {
  const coarse = FULFILLMENT_TO_STATUS[fulfillmentStatus];
  if (!coarse) {
    throw new Error(`Unknown fulfillment status: ${fulfillmentStatus}`);
  }
  return coarse;
}

/**
 * Build the `$set` fragment for a fulfillment transition, with the coarse mirror
 * already included. Call sites spread this so they cannot forget the mirror.
 *
 * @param {string} next
 * @param {object} [extra] additional `$set` keys to merge
 */
function transitionTo(next, extra = {}) {
  return {
    'fulfillment.status': next,
    status: deriveCoarseStatus(next),
    ...extra,
  };
}

module.exports = {
  FULFILLMENT_STATUSES,
  FULFILLMENT_TO_STATUS,
  CANCELLABLE_BY_CUSTOMER,
  CANCELLABLE_BY_STAFF,
  deriveCoarseStatus,
  transitionTo,
};
