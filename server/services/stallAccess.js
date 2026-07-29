'use strict';

const Stall = require('../models/Stall');
const { ApiError } = require('../middleware/errors');

/**
 * Resolves "which stall is this caller acting as?" from the authenticated user
 * alone.
 *
 * The stall id is deliberately never read from the request. If a route accepted
 * a `stallId` body field, a shopkeeper could pass someone else's id and write to
 * their catalog — which is exactly the hole this replaces, where any shopkeeper
 * could edit any product because products had no owner at all.
 *
 * `developer` may act as an explicit stall for local testing, because it has no
 * stall of its own; that override is the one place an id is accepted, and it is
 * gated on the role.
 */
async function resolveOwnedStall(user, { stallIdForDeveloper = null } = {}) {
  if (user.role === 'developer' && stallIdForDeveloper) {
    const stall = await Stall.findById(stallIdForDeveloper);
    if (!stall) throw new ApiError(404, 'Stall not found.', 'NOT_FOUND');
    return stall;
  }

  const stall = await Stall.findOne({ owner: user._id, isActive: true });
  if (!stall) {
    throw new ApiError(
      404,
      'No stall is assigned to this account. Ask the market owner to create one.',
      'NO_STALL'
    );
  }
  return stall;
}

/**
 * Assert the caller owns this stall. Throws 404 rather than 403 so stall ids
 * belonging to other vendors are not probeable.
 */
function assertOwnsStall(user, stall) {
  if (user.role === 'developer') return;
  if (!stall?.owner || stall.owner.toString() !== user._id.toHexString()) {
    throw new ApiError(404, 'Stall not found.', 'NOT_FOUND');
  }
}

module.exports = { resolveOwnedStall, assertOwnsStall };
