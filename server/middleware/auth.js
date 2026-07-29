'use strict';

const User = require('../models/User');
const { verifyAccessToken } = require('../services/tokens');
const { ApiError } = require('./errors');

/**
 * Authentication and role authorization.
 *
 * The only source of identity is a verified access token. Nothing about the
 * request body, query string, or a client-supplied header influences who the
 * caller is or what role they hold.
 */

function extractBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/**
 * Resolve the caller from the Authorization header.
 * @param {boolean} required when false, an absent/invalid token yields req.user = null
 */
function authenticate({ required = true } = {}) {
  return async function authenticateMiddleware(req, _res, next) {
    const token = extractBearer(req);

    if (!token) {
      if (required) return next(new ApiError(401, 'Authentication required.', 'UNAUTHENTICATED'));
      req.user = null;
      return next();
    }

    const claims = verifyAccessToken(token);
    if (!claims) {
      if (required) return next(new ApiError(401, 'Invalid or expired session.', 'INVALID_TOKEN'));
      req.user = null;
      return next();
    }

    const user = await User.findById(claims.sub);

    if (!user || user.status !== 'active') {
      if (required) return next(new ApiError(401, 'Account is not active.', 'ACCOUNT_INACTIVE'));
      req.user = null;
      return next();
    }

    // Stateless tokens are revoked by bumping tokenVersion on the user record.
    if (claims.tv !== user.tokenVersion) {
      if (required) return next(new ApiError(401, 'Session has been revoked. Please sign in again.', 'TOKEN_REVOKED'));
      req.user = null;
      return next();
    }

    // The role is re-read from the database rather than trusted from the token,
    // so a mid-session demotion applies to the very next request.
    req.user = user;
    req.auth = { tokenId: claims.jti, role: user.role };
    return next();
  };
}

const requireAuth = authenticate({ required: true });
const optionalAuth = authenticate({ required: false });

/**
 * Restrict a route to the given roles. Must run after requireAuth.
 * `developer` is intentionally NOT an implicit superuser — grant it explicitly
 * per route so privileged access is always visible at the call site.
 */
function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles.flat());
  return function requireRoleMiddleware(req, _res, next) {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required.', 'UNAUTHENTICATED'));
    }
    if (!allowed.has(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN'));
    }
    return next();
  };
}

/**
 * Allow access when the caller owns the resource, or holds one of the given
 * override roles. `getOwnerId` receives the request and returns an id (or null).
 */
function requireSelfOrRole(getOwnerId, ...overrideRoles) {
  const overrides = new Set(overrideRoles.flat());
  return async function requireSelfOrRoleMiddleware(req, _res, next) {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required.', 'UNAUTHENTICATED'));
    }
    if (overrides.has(req.user.role)) return next();

    const ownerId = await getOwnerId(req);
    if (ownerId && ownerId.toString() === req.user._id.toHexString()) return next();

    // 404 rather than 403: do not confirm that someone else's resource exists.
    return next(new ApiError(404, 'Resource not found.', 'NOT_FOUND'));
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, requireSelfOrRole };
