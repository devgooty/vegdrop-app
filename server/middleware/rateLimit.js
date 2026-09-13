'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('../config/env');

/**
 * Rate limiting.
 *
 * The previous configuration was commented out entirely, leaving credential
 * stuffing and OTP brute force unbounded. Limits are tiered: cheap read traffic
 * gets a generous global budget, while anything that guesses a secret is
 * throttled hard and keyed on the target as well as the source IP (so one
 * attacker rotating IPs still cannot hammer a single account).
 */

function jsonLimitHandler(message, code) {
  return (req, res) => {
    res.status(429).json({
      error: {
        code,
        message,
        retryAfterSeconds: Math.ceil(req.rateLimit.resetTime ? (req.rateLimit.resetTime - Date.now()) / 1000 : 60),
      },
    });
  };
}

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Tests would otherwise trip limits across cases and fail nondeterministically.
  skip: () => config.isTest,
};

/**
 * Paths that carry their own, more appropriate budget and must not also draw on
 * the shared one.
 *
 * Only the reverse-OTP status poll qualifies. It is called every few seconds for
 * up to ten minutes, so a single verification would spend a third of the global
 * allowance — and on a shared connection (one market, one wifi, several people
 * signing in) it would lock everyone else out of the API entirely. It is metered
 * per token by `reverseOtpStatusLimiter` below, which bounds it far more
 * precisely than an IP count ever could.
 */
const GLOBAL_LIMIT_EXEMPT = new Set([
  '/auth/reverse/status',
  '/auth/reverse/handover/status',
  '/auth/reverse/handover/phone-status',
]);

/** Broad protection for the whole API surface. */
const globalLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 600,
  // Mounted at /api, so req.path here is already relative to that prefix.
  skip: (req) => config.isTest || GLOBAL_LIMIT_EXEMPT.has(req.path),
  handler: jsonLimitHandler('Too many requests. Please slow down.', 'RATE_LIMITED'),
});

/**
 * Requesting a code costs a message and is the whole credential, so keep it
 * tight. Keyed on the destination number rather than the caller: an attacker
 * rotating IPs still cannot flood one person's WhatsApp.
 */
const otpRequestLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => {
    // Runs before validation, so read defensively. Either key may carry the
    // destination: `identifier` is the single sign-in box, `phone` the original
    // narrower form. An email is keyed whole; a number is reduced to its last
    // ten digits so +91/0 prefixed spellings share one budget.
    const raw = req.body?.identifier ?? req.body?.phone;
    if (typeof raw !== 'string' || raw.length === 0) {
      return `otp:${ipKeyGenerator(req.ip)}`;
    }
    const dest = raw.includes('@')
      ? raw.trim().toLowerCase().slice(0, 254)
      : raw.replace(/\D/g, '').slice(-10);
    return `otp:${dest}`;
  },
  handler: jsonLimitHandler(
    'Too many verification codes requested. Please wait before requesting another.',
    'OTP_RATE_LIMITED'
  ),
});

/**
 * The per-destination limit above says nothing about someone walking a list of
 * numbers, one code each — which is unsolicited messaging, and the fastest way
 * to get the WhatsApp number banned. This bounds that per source.
 */
const otpStartIpLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 20,
  handler: jsonLimitHandler(
    'Too many verification codes requested from this network. Try again later.',
    'OTP_RATE_LIMITED'
  ),
});

/** Guessing a 6-digit code must be far slower than the keyspace allows. */
const otpVerifyLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 12,
  keyGenerator: (req) => {
    const challenge = typeof req.body?.challengeId === 'string'
      ? req.body.challengeId.slice(0, 80)
      : ipKeyGenerator(req.ip);
    return `otpv:${challenge}`;
  },
  handler: jsonLimitHandler('Too many verification attempts. Request a new code.', 'OTP_RATE_LIMITED'),
});

/**
 * Starting a reverse-OTP challenge sends nothing, so it cannot be turned into
 * unsolicited messaging the way /otp/start can — there is no per-source twin of
 * this limiter for that reason. What it does cost is a row, so it is still
 * bounded per number to stop one phone accumulating thousands of open
 * challenges. Looser than `otpRequestLimiter` because a free retry is a
 * reasonable thing for a confused user to do several times.
 */
const reverseOtpStartLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 15,
  keyGenerator: (req) => {
    const raw = req.body?.phone;
    if (typeof raw !== 'string' || raw.length === 0) {
      return `rotps:${ipKeyGenerator(req.ip)}`;
    }
    return `rotps:${raw.replace(/\D/g, '').slice(-10)}`;
  },
  handler: jsonLimitHandler('Too many verification attempts. Please wait a moment.', 'OTP_RATE_LIMITED'),
});

/**
 * The status poll. Generous on purpose — this is a client waiting politely, not
 * an attacker guessing.
 *
 * Keyed on the token rather than the IP, which is the only key that works here.
 * The token is 32 random bytes handed to one device, so it cannot be guessed or
 * shared, and metering by it bounds each verification independently instead of
 * making everyone behind one router compete. 300 covers a full ten minutes at
 * the client's fastest polling rate with room to spare.
 */
const reverseOtpStatusLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 300,
  keyGenerator: (req) => {
    const header = typeof req.get?.('x-reverse-otp-token') === 'string' ? req.get('x-reverse-otp-token') : '';
    const fromHeader = header.trim().slice(0, 80);
    const fromQuery = typeof req.query?.token === 'string' ? req.query.token.slice(0, 80) : '';
    const token = fromHeader || fromQuery;
    return token ? `rotstat:${token}` : `rotstat:${ipKeyGenerator(req.ip)}`;
  },
  handler: jsonLimitHandler('Checking too often. Please wait a moment.', 'RATE_LIMITED'),
});

/** Opening the phone helper / scanning a QR — bound per IP. */
const handoverScanLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 40,
  handler: jsonLimitHandler('Too many scans. Try again in a few minutes.', 'RATE_LIMITED'),
});

/** Pairing attempts — claim token first on the route; this bounds volume. */
const handoverPairLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  handler: jsonLimitHandler('Too many attempts. Please wait a moment.', 'RATE_LIMITED'),
});

/**
 * Handover status polls. Keyed on claim/phone token headers so two customers
 * on one office Wi-Fi do not share one poll budget (same CGNAT bug as reverse
 * OTP status).
 */
const handoverPollLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 300,
  keyGenerator: (req) => {
    const claim = String(req.get?.('x-handover-claim-token') || '').trim().slice(0, 80);
    const phoneTok = String(req.get?.('x-handover-phone-token') || '').trim().slice(0, 80);
    return `hopoll:${claim || phoneTok || ipKeyGenerator(req.ip)}`;
  },
  handler: jsonLimitHandler('Checking too often. Please wait a moment.', 'RATE_LIMITED'),
});

/**
 * The inbound SMS relay. One authenticated device forwarding messages, so the
 * budget suits a busy handset rather than a browser — but it is still bounded,
 * because a leaked gateway secret should cost the attacker something.
 */
const smsGatewayLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 120,
  handler: jsonLimitHandler('Too many messages. Slow down.', 'RATE_LIMITED'),
});

/**
 * POST /auth/lookup answers whether an identifier has an account, which is an
 * account-enumeration oracle by construction — the sign-in flow was built to
 * avoid exactly this, and the UX now requires it.
 *
 * Since the leak cannot be closed, it is priced instead: this is the tightest
 * budget in the app. 20/hour per source makes a targeted check of one person
 * trivial and a sweep of a number range useless — walking Indian mobile prefixes
 * at this rate would take millennia. Keyed on the caller, because the whole
 * point is bounding how many DIFFERENT identifiers one source can test.
 */
const lookupLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 20,
  handler: jsonLimitHandler(
    'Too many lookups from this network. Try again later.',
    'LOOKUP_RATE_LIMITED'
  ),
});

const paymentLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  handler: jsonLimitHandler('Too many payment requests. Please wait a moment.', 'RATE_LIMITED'),
});

/** KYC submission and penny-drop initiation both cost real money downstream. */
const kycLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `kyc:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler(
    'Too many verification attempts. Please wait before trying again.',
    'KYC_RATE_LIMITED'
  ),
});

/**
 * A rider's position heartbeat.
 *
 * Generous by design: this is the highest-frequency authenticated call in the
 * system, and the whole dispatch engine is only as good as how fresh these are.
 * Keyed per rider rather than per IP so a depot full of agents on one office
 * Wi-Fi does not share — and exhaust — a single budget.
 */
const riderLocationLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => `rloc:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Location updates are coming in too fast.', 'RATE_LIMITED'),
});

/**
 * Accepting and packing, keyed per shopkeeper.
 *
 * Not a security boundary — the claim itself is atomic and a losing claim costs
 * one indexed write. This is a backstop against a wedged client retry loop
 * turning one shop's bad network into database load for the whole market.
 */
const stallActionLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: (req) => `stall:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Too many actions. Please slow down.', 'RATE_LIMITED'),
});

/**
 * Guessing a six-digit handover code, keyed on the handover rather than the
 * caller - the point is bounding how many guesses ONE code can take, the same
 * reasoning as `otpVerifyLimiter` keying on the challenge.
 *
 * These sit ALONGSIDE the per-code attempt cap in services/handover.js, not
 * instead of it. `base.skip` switches every limiter off under test, so the cap
 * is the bound a test can actually drive; these add a time window on top.
 *
 * One bucket per stage (and per stall), never shared: fumbled pickup guesses
 * must not spend the budget a rider needs while standing at the customer's
 * door. Each only keys correctly as ROUTE-level middleware, where `req.params`
 * is populated - mounted at router level the key collapses to the IP fallback.
 */
const pickupVerifyLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `pickupv:${req.params?.id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Too many attempts. Ask the shop to read the code again.', 'PICKUP_CODE_RATE_LIMITED'),
});

/** A market stall's pickup code: one bucket per stall on the order. */
const collectVerifyLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) =>
    `collectv:${req.params?.id || ipKeyGenerator(req.ip)}:${String(req.body?.stallId || '-').slice(0, 32)}`,
  handler: jsonLimitHandler('Too many attempts. Ask the stall to read the code again.', 'PICKUP_CODE_RATE_LIMITED'),
});

/** The customer's delivery code. */
const deliveryVerifyLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `deliverv:${req.params?.id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler(
    'Too many attempts. Ask the customer to read the code again.',
    'DELIVERY_CODE_RATE_LIMITED'
  ),
});

/**
 * A holder asking for a fresh code. Keyed on the caller: rotating is harmless
 * in itself, but each one is a write and nobody needs more than a few.
 */
const handoverReissueLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => `handoverre:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Too many new codes. Please wait a few minutes.', 'RATE_LIMITED'),
});

/**
 * "Is stall A-12 free?", keyed per shopkeeper.
 *
 * This one IS close to a security boundary, unlike `stallActionLimiter`. The
 * endpoint answers a yes/no question about another trader's pitch, so left
 * unbounded it is an enumerator: walk A-1 … A-99 and you have mapped a
 * competitor's market — which stalls are let, how many, and therefore roughly
 * what the place is worth. The limit is set to comfortably cover a person
 * typing a number and correcting it, and nothing like a sweep.
 *
 * Generous window rather than a tight burst limit because the client checks as
 * the applicant types: a debounced field legitimately produces a handful of
 * calls for one number.
 */
const stallNumberCheckLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 40,
  keyGenerator: (req) => `stallnum:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler(
    'Too many stall number checks. Wait a moment and try again.',
    'RATE_LIMITED'
  ),
});

/**
 * Walking a boundary and applying to a market, keyed per user.
 *
 * Both write geometry after running it through an O(n²) self-intersection scan,
 * and both are things a person does a handful of times in their life. A tight
 * limit here costs nothing real and stops a scripted client from turning that
 * scan into CPU load.
 */
const geoWriteLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => `geowrite:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Too many attempts. Wait a moment and try again.', 'RATE_LIMITED'),
});

/** A rider's own settlement details are rarely edited; this only guards retries. */
const riderBankDetailsLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `riderbank:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Too many attempts. Please wait before trying again.', 'RATE_LIMITED'),
});

/** Cooking assistant chat — per user, keeps LLM/tool spend bounded. */
const agentChatLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 40,
  keyGenerator: (req) => `agent:${req.user?._id || ipKeyGenerator(req.ip)}`,
  handler: jsonLimitHandler('Too many assistant messages. Please wait a few minutes.', 'AGENT_RATE_LIMITED'),
});

module.exports = {
  globalLimiter,
  otpRequestLimiter,
  otpStartIpLimiter,
  otpVerifyLimiter,
  reverseOtpStartLimiter,
  reverseOtpStatusLimiter,
  handoverScanLimiter,
  handoverPairLimiter,
  handoverPollLimiter,
  smsGatewayLimiter,
  lookupLimiter,
  paymentLimiter,
  kycLimiter,
  riderLocationLimiter,
  stallActionLimiter,
  stallNumberCheckLimiter,
  geoWriteLimiter,
  riderBankDetailsLimiter,
  pickupVerifyLimiter,
  collectVerifyLimiter,
  deliveryVerifyLimiter,
  handoverReissueLimiter,
  agentChatLimiter,
};
