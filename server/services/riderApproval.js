'use strict';

const User = require('../models/User');

/**
 * Is this rider cleared to take on NEW work?
 *
 * Read from the database rather than the session, for the reason
 * middleware/auth.js re-reads role and status on every request: a rider whose
 * approval is withdrawn mid-shift must stop being able to pick up the next job
 * immediately, not when their token expires.
 *
 * `developer` passes, as everywhere else, so the flow can be exercised without
 * clearing a real person.
 *
 * Shared by routes/rider.js (duty switch, order pool, accept) and
 * routes/orders.js (the shop/legacy pool in `visibilityFilter`, and /claim).
 * The two routers are parallel paths to the same thing — becoming the rider on
 * a real order — so the approval gate must exist on both or it exists on
 * neither: the market pool was closed first while the shop/legacy pool stayed
 * open, and an unapproved account could still read customer addresses from,
 * and claim, any unassigned shop order.
 */
async function mayTakeWork(user) {
  if (user.role === 'developer') return true;
  const me = await User.findById(user._id).select('rider.approvalStatus').lean();
  return me?.rider?.approvalStatus === 'approved';
}

module.exports = { mayTakeWork };
