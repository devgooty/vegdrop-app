'use strict';

/**
 * NoSQL operator injection guard.
 *
 * Mongo treats keys beginning with `$` as operators and `.` as path traversal.
 * A body like {"identifier": {"$ne": null}} turns an equality lookup into a
 * match-anything query. Zod's type checks already reject non-strings on
 * validated routes; this is defence in depth for anything that slips past.
 */

/** Body and params: both hazards apply, and neither is legitimate input. */
const FORBIDDEN_KEY = /^\$|\./;

/**
 * Query strings: operators only.
 *
 * A dot in a query key is ordinary — Meta's webhook handshake sends `hub.mode`,
 * `hub.verify_token` and `hub.challenge`, and OAuth-style callbacks do the same.
 * Rejecting those broke nothing only because the stripping did not work (see
 * below); making it work while still banning dots would have started rejecting
 * them for real. Path traversal needs a key to be used as a Mongo field path,
 * which no route does with a raw query key, so `$` is the rule that earns its
 * place here.
 */
const OPERATOR_KEY = /^\$/;

const MAX_DEPTH = 12;

function scrub(value, depth, onStrip, forbidden) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const entry of value) scrub(entry, depth + 1, onStrip, forbidden);
    return;
  }

  for (const key of Object.keys(value)) {
    if (forbidden.test(key)) {
      delete value[key];
      onStrip(key);
      continue;
    }
    scrub(value[key], depth + 1, onStrip, forbidden);
  }
}

/**
 * Scrub the query string and make the result stick.
 *
 * WHY THIS IS NOT JUST `scrub(req.query)`
 *
 * Express 5 exposes `req.query` as a getter that re-parses the URL on *every*
 * access and returns a fresh object each time. Mutating what it returns
 * therefore edits a throwaway: the next read re-parses and the deleted key is
 * back. This middleware previously did exactly that, and reported keys as
 * stripped that the route then went on to read — visible in production logs as a
 * `[sanitize] stripped ... hub.mode ...` line immediately followed by
 * `[whatsapp] webhook verified.`, which can only happen if the key survived.
 *
 * Reading once and installing the result as an own property shadows the
 * prototype getter, so subsequent reads see the scrubbed object.
 */
function sanitizeQuery(req, onStrip) {
  let query;
  try {
    query = req.query;
  } catch {
    return;
  }

  if (query === null || typeof query !== 'object') return;

  scrub(query, 0, onStrip, OPERATOR_KEY);

  try {
    Object.defineProperty(req, 'query', {
      value: query,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    /* Non-configurable on some versions; validation still guards these routes. */
  }
}

function sanitizeRequest(req, _res, next) {
  const stripped = [];
  const record = (key) => stripped.push(key);

  scrub(req.body, 0, record, FORBIDDEN_KEY);
  scrub(req.params, 0, record, FORBIDDEN_KEY);
  sanitizeQuery(req, record);

  if (stripped.length > 0) {
    console.warn('[sanitize] stripped Mongo operator keys', {
      method: req.method,
      path: req.path,
      keys: stripped.slice(0, 10),
    });
  }

  next();
}

module.exports = { sanitizeRequest };
