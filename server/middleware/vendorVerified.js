'use strict';

const VendorKyc = require('../models/VendorKyc');
const { ApiError } = require('./errors');

/**
 * Blocks catalog writes until the vendor's settlement account is verified.
 *
 * A shopkeeper account can now be created by self-registration, so holding the
 * role no longer implies anyone vetted the person behind it. This is the check
 * that makes that safe: the role gets you the panel, the penny drop gets you the
 * ability to list stock and take money.
 *
 * Read on every request rather than cached in the JWT. A revoked or rejected KYC
 * has to take effect immediately, and a claim baked into a 15-minute access
 * token would keep a de-verified vendor trading until it expired — the same
 * reasoning behind re-reading `role` in middleware/auth.js.
 *
 * `developer` and `market_owner` bypass this. Neither sells anything: the former
 * is a local testing role, the latter administers stalls on behalf of vendors who
 * have their own KYC records.
 */
function requireVerifiedVendor(req, _res, next) {
  const user = req.user;

  if (!user) {
    return next(new ApiError(401, 'Authentication required.', 'UNAUTHENTICATED'));
  }

  if (user.role !== 'shopkeeper') return next();

  VendorKyc.findOne({ user: user._id })
    .select('status')
    .lean()
    .then((kyc) => {
      if (kyc?.status === 'verified') return next();

      // 403 with a specific code: the client needs to distinguish "you cannot do
      // this" from "you have not finished setting up", because only the second
      // one has a useful next action.
      return next(
        new ApiError(
          403,
          kyc
            ? 'Finish verifying your bank account before updating stock.'
            : 'Add your PAN and bank details, then verify your UPI account, before updating stock.',
          'KYC_REQUIRED',
          { kycStatus: kyc?.status || 'missing' }
        )
      );
    })
    .catch(next);
}

module.exports = { requireVerifiedVendor };
