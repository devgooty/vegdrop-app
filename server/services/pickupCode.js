'use strict';

const crypto = require('crypto');
const config = require('../config/env');

/**
 * The handover code a rider reads off the shopkeeper's screen.
 *
 * WHAT IT PROVES
 *
 * Ticking a stall off used to be self-attested: the rider tapped "collected"
 * and the server believed it. That is fine as a checklist and worthless as
 * evidence — a rider could mark an entire round collected from the far side of
 * the city, and the customer's address unlocked on acceptance regardless. The
 * code closes both: it can only be read off a screen that only the claiming
 * stall can see, so entering it is evidence the rider is standing at that
 * stall.
 *
 * WHY IT IS DERIVED RATHER THAN STORED
 *
 * Unlike a login code this one is *displayed*, repeatedly, for as long as the
 * order is live — the shopkeeper may look at it twenty minutes and one page
 * refresh after claiming. So it cannot be stored as an HMAC the way
 * `services/otp.js` stores a login code; something has to be able to produce it
 * again.
 *
 * Storing the plaintext would work and is what most of this industry does. The
 * alternative taken here is to store nothing at all: the code IS an HMAC, of
 * the order and stall ids under the same server-side pepper, truncated to four
 * digits. Both sides recompute it. A database dump therefore yields no codes,
 * which is the same property `otp.js` and the KYC penny drop are written for.
 *
 * The cost of that choice, stated plainly: the code is FIXED for the life of an
 * (order, stall) pair. It cannot be rotated without rotating the pepper, and
 * anyone who ever learns it can present it again for that same pickup. That is
 * acceptable because the pair is single-use in practice — once the bags are
 * collected the lines carry `collectedAt` and the same code buys nothing — but
 * it is why the attempt cap below is not optional. Four digits is 10,000
 * guesses, which is nothing at all to a script and quite a lot to a person
 * reading numbers aloud in a market.
 */

/** Four, because it is spoken across a stall counter, not typed from a screen. */
const CODE_LENGTH = 4;

/**
 * Wrong guesses tolerated per stall before the handover locks.
 *
 * Generous, because the failure mode is a rider who misheard a number over
 * market noise, and stingy enough that 5/10000 is not a search. A lock is not a
 * dead end — the shopkeeper standing right there can clear it (see
 * `POST /stalls/orders/:id/pickup/reset`), which is the only place in this
 * system where the person who can vouch for someone is already face to face
 * with them.
 */
const MAX_ATTEMPTS = 5;

/**
 * The code for one stall's part of one order.
 *
 * Keyed on both ids: a stall's code differs per order, and an order's code
 * differs per stall, so learning one tells you nothing about the next. The
 * `pickup:` prefix keeps this HMAC in a different domain from the one
 * `services/otp.js` computes over `challengeId:code`, so the two can never
 * collide even though they share a pepper.
 *
 * @param {string|object} orderId
 * @param {string|object} stallId
 * @returns {string} zero-padded decimal digits
 */
function codeFor(orderId, stallId) {
  const digest = crypto
    .createHmac('sha256', config.otp.pepper)
    .update(`pickup:${String(orderId)}:${String(stallId)}`)
    .digest();

  // Modulo bias over a 32-bit read is ~4e-6 of a digit — far below anything
  // that helps a guesser who gets five tries.
  const value = digest.readUInt32BE(0) % 10 ** CODE_LENGTH;
  return String(value).padStart(CODE_LENGTH, '0');
}

/**
 * Constant-time comparison, for the same reason `otp.js` uses one: a timing
 * signal on a four-digit space is a real shortcut.
 *
 * @returns {boolean}
 */
function matches(orderId, stallId, submitted) {
  const expected = Buffer.from(codeFor(orderId, stallId), 'utf8');
  const actual = Buffer.from(String(submitted ?? '').trim(), 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * The second id to key on for an order with no market — an independent shop, or
 * one of the legacy marketless orders that predate sellers entirely.
 *
 * A shop order carries the shopkeeper's user id, so its code is scoped to the
 * one shopkeeper who can see the order. A legacy order has no seller at all and
 * falls back to a constant, which means its code is effectively keyed on the
 * order alone.
 *
 * That is weaker, and it is worth being explicit about why it is not worth
 * fixing here: every shopkeeper can already see every legacy order — that is
 * what the shared `legacyPool` clause in `visibilityFilter` does, and the
 * single-shop flow depends on it. Deriving a per-shopkeeper code would hand out
 * a different number to each of them for the same bags, so the rider would be
 * told one code and the shop reading it out might be looking at another.
 * The exposure is the shared pool, not the key.
 *
 * @param {{shop: any}} order
 */
function sellerKeyFor(order) {
  return order?.shop ? String(order.shop) : 'legacy';
}

module.exports = { codeFor, matches, sellerKeyFor, CODE_LENGTH, MAX_ATTEMPTS };
