'use strict';

/**
 * NoSQL operator injection guard.
 *
 * Mongo treats keys beginning with `$` as operators and `.` as path traversal.
 * A body like {"identifier": {"$ne": null}} turns an equality lookup into a
 * match-anything query. Zod's type checks already reject non-strings on
 * validated routes; this is defence in depth for anything that slips past.
 *
 * Written to mutate objects in place: Express 5 defines req.query as a getter,
 * so the usual `req.query = clean(req.query)` approach throws.
 */

const FORBIDDEN_KEY = /^\$|\./;
const MAX_DEPTH = 12;

// Known-safe keys that legitimately contain a `.` but are not Mongo path
// traversal attempts. The WhatsApp webhook verification handshake sends
// these as query params (e.g. GET /webhook?hub.mode=subscribe&...) and they
// must reach the route handler untouched.
const WHITELISTED_KEYS = new Set(['hub.mode', 'hub.challenge', 'hub.verify_token']);

function scrub(value, depth, onStrip) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const entry of value) scrub(entry, depth + 1, onStrip);
    return;
  }

  for (const key of Object.keys(value)) {
    if (WHITELISTED_KEYS.has(key)) continue;
    if (FORBIDDEN_KEY.test(key)) {
      delete value[key];
      onStrip(key);
      continue;
    }
    scrub(value[key], depth + 1, onStrip);
  }
}

function sanitizeRequest(req, _res, next) {
  const stripped = [];
  const record = (key) => stripped.push(key);

  scrub(req.body, 0, record);
  scrub(req.params, 0, record);
  // req.query is getter-backed in Express 5 but the object it returns is mutable.
  try {
    scrub(req.query, 0, record);
  } catch {
    /* Some Express versions freeze query; the validation layer still guards it. */
  }

  if (stripped.length > 0) {
    console.debug('[sanitize] stripped Mongo operator keys', {
      method: req.method,
      path: req.path,
      keys: stripped.slice(0, 10),
    });
  }

  next();
}

module.exports = { sanitizeRequest };
