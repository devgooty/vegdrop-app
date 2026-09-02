'use strict';

/**
 * Environment configuration with fail-fast validation.
 *
 * Design rule: there are NO hardcoded secret fallbacks. In production a missing
 * secret aborts boot. In development/test a random ephemeral secret is generated
 * per process (so tokens simply don't survive a restart) and a loud warning is
 * printed. A committed literal would mean anyone with the source can forge tokens.
 */

const crypto = require('crypto');

// Under test, never read the developer's real .env — it holds live payment
// credentials, and a test run must not be able to reach a payment provider.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const fatal = [];
const ephemeral = [];

/** Secret that must be strong in production, ephemeral-random elsewhere. */
function secret(name, minLength = 32) {
  const value = process.env[name];

  if (value) {
    if (value.length < minLength) {
      fatal.push(`${name} must be at least ${minLength} characters (got ${value.length}).`);
    }
    return value;
  }

  if (isProduction) {
    fatal.push(`${name} is required in production but is not set.`);
    return undefined;
  }

  ephemeral.push(name);
  return crypto.randomBytes(48).toString('base64url');
}

/** Non-secret value with a safe default. */
function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    fatal.push(`${name} must be an integer (got "${raw}").`);
    return fallback;
  }
  return parsed;
}

// ---------------------------------------------------------------------------

const mongoUri = isProduction
  ? process.env.MONGODB_URI
  : optional('MONGODB_URI', 'mongodb://127.0.0.1:27017/vegdrop');

if (isProduction && !mongoUri) {
  fatal.push('MONGODB_URI is required in production but is not set.');
}

const corsOrigins = list('CORS_ALLOWED_ORIGINS', isProduction ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']);
if (isProduction && corsOrigins.length === 0) {
  fatal.push('CORS_ALLOWED_ORIGINS is required in production (comma-separated absolute origins).');
}

// --- Outbound notifications --------------------------------------------------

const whatsappPhoneNumberId = optional('WHATSAPP_PHONE_NUMBER_ID', '');
const whatsappAccessToken = optional('WHATSAPP_ACCESS_TOKEN', '');
const whatsappTemplateName = optional('WHATSAPP_OTP_TEMPLATE_NAME', '');
const whatsappConfigured = Boolean(whatsappPhoneNumberId && whatsappAccessToken && whatsappTemplateName);

// --- Inbound verification (reverse OTP) --------------------------------------

/**
 * Reverse OTP verifies a number by RECEIVING a message rather than sending one:
 * the user messages our inbox from their own phone, quoting a code we showed
 * them. Each channel is configured independently, because each is a different
 * way for a message to reach us.
 *
 * WhatsApp needs the inbox number to build the wa.me link, plus the app secret
 * — without the secret the inbound webhook cannot prove a call came from Meta,
 * and an unverified webhook would let anyone assert that any number sent us
 * anything. That is the whole security boundary, so an inbox number without an
 * app secret is not a usable channel and is deliberately reported as off.
 *
 * SMS needs a relay: an Android app holding a SIM, forwarding what it receives
 * to us. Its shared secret is what separates it from the open internet.
 *
 * Neither is fatal in production. Reverse OTP is an alternative to the outbound
 * code, never the only way in, so an unconfigured channel means one fewer button
 * on the sign-in screen — not a service that cannot start. The routes fail closed
 * with a 503 instead.
 */
const whatsappInboxNumber = optional('WHATSAPP_INBOX_NUMBER', '').replace(/\D/g, '');
const whatsappInboundConfigured = Boolean(whatsappInboxNumber && optional('WHATSAPP_APP_SECRET', ''));

const smsGatewayInboxNumber = optional('SMS_GATEWAY_INBOX_NUMBER', '').replace(/\D/g, '');
const smsGatewaySecret = optional('SMS_GATEWAY_SECRET', '');
const smsGatewayConfigured = Boolean(smsGatewayInboxNumber && smsGatewaySecret);

/**
 * SMTP, for copying a login code to a verified email address.
 *
 * Configured is the switch — there is no separate "enable fan-out" flag, matching
 * NOTIFY_TRANSPORT below, which selects WhatsApp as soon as its credentials
 * exist. A second flag is a second thing to forget.
 *
 * Note what this does NOT change: the phone stays the credential. Email only ever
 * receives a copy of a code already addressed to a phone, and only when that
 * address has been verified through /auth/email/verify — an address a stolen
 * session could set would otherwise be a way to receive every future code.
 */
const smtpHost = optional('SMTP_HOST', '');
const smtpFrom = optional('SMTP_FROM', '');

/**
 * HTTP email providers, tried in order until one delivers.
 *
 * Every one of these is reached over HTTPS rather than SMTP, which is what makes
 * them usable here at all: Railway blocks outbound SMTP on its Hobby and Trial
 * plans, so nodemailer fails with ESOCKET before reaching a credential.
 *
 * The default order puts the daily-resetting allowances first, so the pools that
 * only refill monthly are held back for a day that actually needs them.
 * EMAIL_PROVIDER_ORDER overrides it.
 */
const EMAIL_PROVIDER_KEYS = Object.freeze({
  brevo: 'BREVO_API_KEY',
  sendgrid: 'SENDGRID_API_KEY',
  mailersend: 'MAILERSEND_API_KEY',
  mailtrap: 'MAILTRAP_API_TOKEN',
  plunk: 'PLUNK_API_KEY',
  resend: 'RESEND_API_KEY',
});

const DEFAULT_EMAIL_ORDER = ['brevo', 'sendgrid', 'mailersend', 'mailtrap', 'plunk', 'resend'];

const emailOrder = list('EMAIL_PROVIDER_ORDER', DEFAULT_EMAIL_ORDER)
  .map((name) => name.toLowerCase())
  .filter((name) => {
    if (EMAIL_PROVIDER_KEYS[name]) return true;
    fatal.push(
      `EMAIL_PROVIDER_ORDER contains unknown provider "${name}". Known: ${Object.keys(EMAIL_PROVIDER_KEYS).join(', ')}.`
    );
    return false;
  });

/** Only providers that actually carry a key, in the resolved order. */
const emailProviders = emailOrder
  .map((name) => ({ name, apiKey: optional(EMAIL_PROVIDER_KEYS[name], '') }))
  .filter((p) => p.apiKey.length > 0);

/**
 * Falls back through the older single-provider names so an existing deployment
 * does not need its sender re-entered.
 *
 * Trimmed, and checked for an `@` rather than merely for being set. A value of
 * whitespace is truthy, passes a presence check, and then arrives at the
 * provider as an empty sender — which surfaces four layers away as a generic
 * "could not deliver", with the actual cause only visible in a provider's own
 * error text. Whitespace is exactly what a dashboard that mangles quotes around
 * `Name <addr@host>` leaves behind, so it is worth naming here.
 */
const emailFrom = (optional('EMAIL_FROM', '') || optional('RESEND_FROM', '') || smtpFrom).trim();

const emailConfigured = Boolean(emailFrom && (emailProviders.length > 0 || smtpHost));

if (emailProviders.length > 0 && !emailFrom.includes('@')) {
  fatal.push(
    emailFrom
      ? `EMAIL_FROM does not contain an email address (got "${emailFrom}"). Use either "no-reply@example.com" or "VegDrop <no-reply@example.com>".`
      : 'An email provider API key is set but EMAIL_FROM is empty. Set it to a sender the provider has verified, e.g. "VegDrop <no-reply@example.com>". A dashboard that strips quotes can leave this blank — check the stored value, not just that the variable exists.'
  );
}

if (smtpHost && !smtpFrom && emailProviders.length === 0) {
  fatal.push('SMTP_HOST is set but SMTP_FROM is not. Most relays reject a message with no envelope sender.');
}

/**
 * console  — dev stub, prints codes to stdout
 * whatsapp — official WhatsApp Cloud API (approved template, paid per message)
 *
 * An unofficial WhatsApp Web client used to be a third option. It was removed:
 * sign-in here is passwordless, so the OTP transport IS the authentication
 * system, and resting that on a client that violates WhatsApp's Terms of
 * Service means a ban locks every user out at once with no way back in. That
 * is not a risk a payments app gets to take to save on message fees.
 */
const VALID_TRANSPORTS = ['console', 'whatsapp'];

/**
 * Which transport delivers codes to phone numbers.
 *
 * Defaults to whatsapp once credentials exist, so configuring the provider is
 * enough to switch over — no second flag to remember. `console` is a development
 * stub that prints codes to stdout and is refused in production below.
 */
const notifyTransport = optional('NOTIFY_TRANSPORT', whatsappConfigured ? 'whatsapp' : 'console');

if (!VALID_TRANSPORTS.includes(notifyTransport)) {
  fatal.push(`NOTIFY_TRANSPORT must be one of ${VALID_TRANSPORTS.join(', ')} (got "${notifyTransport}").`);
}

if (notifyTransport === 'whatsapp' && !whatsappConfigured) {
  fatal.push(
    'NOTIFY_TRANSPORT=whatsapp requires WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN and WHATSAPP_OTP_TEMPLATE_NAME.'
  );
}


// Shipping the console stub to production means verification codes are written
// to server logs instead of being delivered. Fail at boot, not at first send.
if (isProduction && notifyTransport === 'console') {
  fatal.push(
    'A real notification transport is required in production. Configure WhatsApp (WHATSAPP_*) or implement another transport in server/services/notify.js.'
  );
}

/**
 * Dev-only sign-in that skips the OTP entirely.
 *
 * `GET /api/auth/dev/login?phone=...` mints a session for a seeded account with
 * nothing proved. That is account takeover by URL, so it is guarded twice rather
 * than once: it is opt-in per process via DEV_LOGIN, and setting DEV_LOGIN in
 * production is a boot-time FATAL rather than a warning that scrolls past.
 * Anyone who ships it gets a dead deploy instead of an open door.
 *
 * The second guard is the one that matters. `!isProduction` alone would be a
 * single missing NODE_ENV away from serving the endpoint for real, and this
 * codebase has already removed one auth bypass that needed nothing but the
 * client being offline (see the apiClient.js note in CLAUDE.md). A flag that has
 * to be set on purpose, plus a refusal to boot where it would do damage, is what
 * keeps "convenient locally" from becoming "reachable in production".
 *
 * Set by server/scripts/dev-with-memory-db.js, a throwaway in-memory demo
 * harness that is never a deployment target. `npm run server` does NOT set it.
 */
const devLoginRequested = process.env.DEV_LOGIN === '1';

/**
 * Markers every one of these platforms injects into a deployed process.
 *
 * `isProduction` alone is NOT a sufficient guard. NODE_ENV is set by whoever
 * configured the host, which makes it a claim about the environment rather than
 * a fact about it: a service can be serving real traffic with it unset or wrong,
 * and every check keyed on it is then silently inert — including the one right
 * below, which is the last thing that should fail quietly.
 *
 * These markers are injected by the platform itself, so they cannot be
 * forgotten. Being deployed at all is what makes a sign-in bypass dangerous, and
 * that is what they detect. They cost nothing when absent and they do not care
 * what NODE_ENV claims.
 *
 * Exported as `isDeployed` because DEV_LOGIN is not the only thing that must not
 * happen on a real host. `utils/seed.js` keyed its demo accounts, markets and
 * fabricated orders on `isProduction` alone, and this project's own Railway
 * deployment was running without NODE_ENV set — so the guard was inert and the
 * demo seed ran against the live database. Anything whose danger comes from
 * *being deployed* should ask this, not NODE_ENV.
 */
const DEPLOY_MARKERS = ['RAILWAY_ENVIRONMENT', 'RAILWAY_SERVICE_ID', 'VERCEL', 'RENDER', 'FLY_APP_NAME', 'DYNO'];
const deployedMarker = DEPLOY_MARKERS.find((name) => process.env[name]);

if (devLoginRequested && (isProduction || deployedMarker)) {
  fatal.push(
    `DEV_LOGIN must never be set on a deployed host (${isProduction ? 'NODE_ENV=production' : `${deployedMarker} is set`}). ` +
      'It serves an endpoint that mints a session for any account without verification.'
  );
}

const devLoginEnabled = devLoginRequested && !isProduction && !deployedMarker;

/**
 * Scheduled ("standing") orders, locked off at the owner's request.
 *
 * Locked by DEFAULT and opened by setting SCHEDULED_ORDERS_UNLOCK=1, rather than
 * the other way round: a feature that is off until someone deliberately turns it
 * on cannot be re-enabled by a config file going missing.
 *
 * This is the ONLY switch. The customer UI hides the tab, but hiding a tab is
 * not a lock — `services/scheduler.js` places standing orders from the sweeper
 * with no UI involved at all, so a client-only lock would keep charging people
 * on a schedule while removing the only screen that can pause or cancel it.
 * Server-side, the lock therefore does two things: refuses to create new
 * schedules, and stops due ones from running.
 *
 * It does NOT delete or pause the stored ScheduledOrder rows. Unlocking restores
 * exactly what was there, and a paused-then-resumed schedule recomputes its own
 * nextRunAt (see the PATCH handler), so nothing fires retroactively for the
 * period it was locked.
 */
const scheduledOrdersLocked = process.env.SCHEDULED_ORDERS_UNLOCK !== '1';

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const razorpayConfigured = Boolean(razorpayKeyId && razorpayKeySecret);

// A real key id starts with rzp_live_ / rzp_test_. Refuse obvious placeholders in prod.
if (isProduction && (!razorpayConfigured || !/^rzp_(live|test)_/.test(razorpayKeyId))) {
  fatal.push('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET must be real credentials in production. Payments cannot run in mock mode.');
}

/**
 * The webhook secret, which is a THIRD credential — not the key secret above.
 * Razorpay signs webhook bodies with a value you choose in their dashboard when
 * you register the endpoint, and verifying with the key secret simply never
 * matches.
 *
 * WARNED ABOUT, NOT FATAL — and the distinction is the same one RAZORPAYX_*
 * settled earlier in this file's history.
 *
 * Every boot-time failure above gates something that is actively WRONG without
 * it: no CORS origins and the client cannot reach the API, no JWT secret and
 * auth is broken, mock Razorpay and payments are theatre. Missing this one
 * leaves the app behaving exactly as it did before the webhook existed —
 * `/topup/verify` still credits, and routes/wallet.js answers the webhook with
 * a 503 and a loud log rather than trusting an unverifiable body. That is a
 * missing recovery path, not a broken system, and refusing to start the whole
 * app over it would take checkout down to protect a fallback.
 *
 * It still matters: without it, a tab closed in the seconds after paying means
 * the money was captured and never credited, with nothing to reconcile it. The
 * warning below is deliberately blunt about that.
 */
const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

/**
 * Vendor KYC.
 *
 * Bank account numbers are encrypted at rest. The key is separate from the JWT
 * secrets on purpose: rotating a signing secret should not force a re-encrypt
 * of every KYC record, and a leaked token secret must not also decrypt them.
 */
const kycEncryptionKey = secret('KYC_ENCRYPTION_KEY');

/**
 * Payouts (RazorpayX) are a DIFFERENT product from Razorpay Payments above and
 * carry their own credentials. Payments-only credentials cannot move money out,
 * so the vendor penny drop needs these before it can run for real.
 *
 * Deliberately NOT a boot-time fatal check, unlike RAZORPAY_* above. Customer
 * checkout needs Payments on every boot; vendor KYC payouts are a narrower
 * feature that only matters once a shopkeeper actually applies. Refusing to
 * start the whole app — checkout included — over a product a customer will
 * never touch was too broad a blast radius for one feature's dependency.
 * services/payouts.js refuses the request at the point of use instead: it
 * still never runs the mock provider in production, it just fails on the one
 * call that needs it rather than on every boot.
 */
const payoutKeyId = process.env.RAZORPAYX_KEY_ID || '';
const payoutKeySecret = process.env.RAZORPAYX_KEY_SECRET || '';
const payoutAccountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER || '';
const payoutConfigured = Boolean(payoutKeyId && payoutKeySecret && payoutAccountNumber);

/**
 * The stall cascade's clocks, resolved before the config object so the ceiling
 * can be derived from the rounds it has to contain.
 *
 * `sourcingWindowSeconds` used to BE the sourcing clock. It is now only a
 * backstop, and a backstop shorter than one round would fire mid-cascade and
 * hop an order that nobody had finished considering — so the configured value
 * is a floor, not the answer. The `+1` round is the open pool, which gets a
 * window of its own after the ranked rounds are spent.
 */
const stallOfferWindowSeconds = int('MARKET_STALL_OFFER_WINDOW_SECONDS', 120);
const maxStallRounds = int('MARKET_MAX_STALL_ROUNDS', 3);
const sourcingCeilingSeconds = Math.max(
  int('MARKET_SOURCING_WINDOW_SECONDS', 90),
  (maxStallRounds + 1) * stallOfferWindowSeconds + 60
);

const config = Object.freeze({
  NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: !isProduction && !isTest,
  isDeployed: Boolean(deployedMarker),
  deployedMarker: deployedMarker || null,
  devLoginEnabled,
  scheduledOrdersLocked,

  port: int('PORT', 5000),
  trustProxy: optional('TRUST_PROXY', isProduction ? '1' : ''),

  mongoUri,

  corsOrigins,

  jwt: Object.freeze({
    accessSecret: secret('JWT_ACCESS_SECRET'),
    refreshSecret: secret('JWT_REFRESH_SECRET'),
    accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 15 * 60), // 15 minutes
    refreshTtlSeconds: int('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60), // 30 days
    issuer: optional('JWT_ISSUER', 'vegdrop'),
    audience: optional('JWT_AUDIENCE', 'vegdrop-app'),
  }),

  // Pepper is mixed into OTP hashes so a database leak alone does not reveal codes.
  // There is no `channel` setting: a code is the only credential, so it always
  // goes to the phone. Addressing it to an email would be a second way in.
  otp: Object.freeze({
    pepper: secret('OTP_PEPPER'),
    length: 6,
    ttlSeconds: int('OTP_TTL_SECONDS', 5 * 60),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 30),
  }),

  // No `auth` block: there are no passwords, so there is no password policy and
  // no failed-login lockout. A code is guessable only within one challenge,
  // which caps its own attempts — see services/otp.js and middleware/rateLimit.js.

  notifyTransport,

  whatsapp: Object.freeze({
    configured: whatsappConfigured,
    phoneNumberId: whatsappPhoneNumberId,
    accessToken: whatsappAccessToken,
    // Pinned rather than "latest": Graph API versions are deprecated on a
    // schedule, and an unannounced bump changes payload validation under you.
    apiVersion: optional('WHATSAPP_API_VERSION', 'v21.0'),
    templateName: whatsappTemplateName,
    templateLocale: optional('WHATSAPP_TEMPLATE_LOCALE', 'en'),
    // Authentication templates normally carry a copy-code button that needs the
    // code repeated as its parameter. Templates without one reject the extra
    // component, so this is switchable.
    includeOtpButton: optional('WHATSAPP_OTP_INCLUDE_BUTTON', 'true') !== 'false',
    buttonSubType: optional('WHATSAPP_OTP_BUTTON_SUBTYPE', 'url'),
    // Numbers are stored as 10 local digits; this is prepended when dialling out.
    defaultCountryCode: optional('WHATSAPP_DEFAULT_COUNTRY_CODE', '91').replace(/\D/g, ''),
    timeoutMs: int('WHATSAPP_TIMEOUT_MS', 10000),
    // Verifies inbound webhook calls actually came from Meta.
    appSecret: optional('WHATSAPP_APP_SECRET', ''),
    webhookVerifyToken: optional('WHATSAPP_WEBHOOK_VERIFY_TOKEN', ''),
  }),

  /**
   * Reverse OTP: the user sends US the code, from the number they are claiming.
   *
   * The TTL is longer than the outbound one (10 min vs 5) because the user has
   * more to do — switch app, send, switch back — and a code that dies mid-hop is
   * a dead end rather than a retry.
   */
  reverseOtp: Object.freeze({
    ttlSeconds: int('REVERSE_OTP_TTL_SECONDS', 10 * 60),
    codeLength: 6,
    /**
     * No 0/O/1/I/L. The user reads this off a screen and it travels through a
     * messaging app, so every ambiguous glyph is a support ticket.
     */
    alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
    whatsapp: Object.freeze({
      configured: whatsappInboundConfigured,
      inboxNumber: whatsappInboxNumber,
    }),
    sms: Object.freeze({
      configured: smsGatewayConfigured,
      inboxNumber: smsGatewayInboxNumber,
      gatewaySecret: smsGatewaySecret,
    }),
  }),

  email: Object.freeze({
    configured: emailConfigured,
    from: emailFrom,
    // In preference order; the chain walks it until one delivers.
    providers: Object.freeze(emailProviders.map((p) => Object.freeze(p))),
    timeoutMs: int('EMAIL_TIMEOUT_MS', 10000),

    /**
     * SMTP settings, nested rather than flattened alongside the fields above.
     *
     * They used to sit in this object directly, which put a second `from` and a
     * second `timeoutMs` in the same literal — and a duplicate key in an object
     * literal is not an error, it silently wins. `from` therefore resolved to
     * SMTP_FROM no matter what EMAIL_FROM said, so deleting SMTP_FROM (correct,
     * once SMTP was replaced) emptied the sender and every provider rejected the
     * message with "sender email is missing". Nesting makes the collision
     * impossible rather than merely fixed.
     */
    smtp: Object.freeze({
      host: smtpHost,
      // 587 is STARTTLS (secure=false, upgraded after greeting); 465 is implicit
      // TLS (secure=true). Mismatching the two is the usual cause of a hang.
      port: int('SMTP_PORT', 587),
      secure: optional('SMTP_SECURE', 'false') === 'true',
      user: optional('SMTP_USER', ''),
      pass: optional('SMTP_PASS', ''),
      from: smtpFrom,
      timeoutMs: int('SMTP_TIMEOUT_MS', 10000),
    }),
  }),

  razorpay: Object.freeze({
    keyId: razorpayKeyId,
    keySecret: razorpayKeySecret,
    webhookSecret: razorpayWebhookSecret,
    configured: razorpayConfigured,
    // Mock order creation is a development affordance only; prod is blocked above.
    allowMock: !isProduction && !razorpayConfigured,
  }),

  kyc: Object.freeze({
    encryptionKey: kycEncryptionKey,
    // Penny drop lands a random sub-rupee amount so the vendor must read their
    // own statement to pass. A fixed ₹1 would let anyone click "yes I got it".
    minPennyPaise: int('KYC_PENNY_MIN_PAISE', 1),
    maxPennyPaise: int('KYC_PENNY_MAX_PAISE', 100),
    pennyMaxAttempts: int('KYC_PENNY_MAX_ATTEMPTS', 5),
    pennyTtlSeconds: int('KYC_PENNY_TTL_SECONDS', 7 * 24 * 60 * 60),
  }),

  payouts: Object.freeze({
    keyId: payoutKeyId,
    keySecret: payoutKeySecret,
    accountNumber: payoutAccountNumber,
    configured: payoutConfigured,
    // Simulated transfers are a development affordance only; prod is blocked above.
    allowMock: !isProduction && !payoutConfigured,
  }),

  /**
   * Market sourcing and rider dispatch.
   *
   * An order placed against a market is offered to every open stall in it, and
   * only becomes real once every line has a taker. These knobs govern how long
   * that takes and how far it is allowed to travel looking for one.
   */
  marketplace: Object.freeze({
    /**
     * How long ONE round of stall offers stays live. This is the real sourcing
     * clock — the window a shopkeeper actually has to look at their phone and
     * answer. Stalls with auto-accept answer in milliseconds and never use it.
     */
    stallOfferWindowSeconds,
    /**
     * Rounds of ranked offers before a market falls back to its open pool.
     *
     * Each round costs a full window, so this bounds how long one market can
     * hold an order: rounds x window, then one more window in the pool.
     */
    maxStallRounds,
    /**
     * Most stalls one order may be split across.
     *
     * Not a correctness limit — a cap on the rider's walk. Six stalls for one
     * order is a long collection round and a lot of ways for it to go wrong.
     */
    maxStallsPerOrder: int('MARKET_MAX_STALLS_PER_ORDER', 4),
    /**
     * How long the customer has to answer "3 of your 5 items are available".
     *
     * Silence is taken as "send what you have" — they have already waited
     * through a full sourcing attempt, and cancelling on them would turn a
     * mostly-successful order into nothing at all.
     */
    partialDecisionWindowSeconds: int('MARKET_PARTIAL_DECISION_WINDOW_SECONDS', 300),
    /**
     * Absolute ceiling on one market, as a backstop only.
     *
     * `stallOffer.expiresAt` drives the cascade; this exists so an order can
     * never be stranded if round bookkeeping goes wrong, and because the
     * sweeper already indexes it. Derived from the round budget above and
     * floored by MARKET_SOURCING_WINDOW_SECONDS, so it can never be shorter
     * than the cascade it is supposed to outlive.
     */
    sourcingWindowSeconds: sourcingCeilingSeconds,
    // Total markets an order may be offered to, including the first. Each hop
    // costs the customer another full window, so this is deliberately small.
    maxSourcingAttempts: int('MARKET_MAX_SOURCING_ATTEMPTS', 3),
    // How far from the customer we will look for a market to hop to.
    searchRadiusMeters: int('MARKET_SEARCH_RADIUS_METERS', 15000),
    /**
     * Ceiling on what a hop may cost us, in basis points of the locked subtotal.
     *
     * The customer's total is fixed at checkout, so a more expensive second
     * market comes out of margin. 10000 bps = 100% = "same price or cheaper
     * only", which is the safe default. Raise it to let an order travel to a
     * dearer market at a known, bounded loss.
     */
    hopPriceToleranceBps: int('MARKET_HOP_PRICE_TOLERANCE_BPS', 10000),

    // How often the background job expires sourcing windows and rider offers.
    sweeperIntervalSeconds: int('MARKET_SWEEPER_INTERVAL_SECONDS', 5),

    /**
     * When the rider is called.
     *
     * `packing` sends them while the stalls are still bagging, so they arrive as
     * the last bag is tied. `ready` waits until everything is packed — slower,
     * but it never has a rider standing around.
     */
    riderDispatchOn: optional('RIDER_DISPATCH_ON', 'packing') === 'ready' ? 'ready' : 'packing',
    // How long one rider has to answer before the offer moves to the next nearest.
    riderOfferTimeoutSeconds: int('RIDER_OFFER_TIMEOUT_SECONDS', 25),
    // After this many refused or expired offers the order goes to an open pool
    // any rider can claim, rather than cascading for ever.
    riderMaxOffers: int('RIDER_MAX_OFFERS', 4),
    riderSearchRadiusMeters: int('RIDER_SEARCH_RADIUS_METERS', 8000),
    // A rider whose last ping is older than this is treated as gone, whatever
    // their duty status says — a killed app never gets to say goodbye.
    riderStaleLocationSeconds: int('RIDER_STALE_LOCATION_SECONDS', 120),

    /**
     * An independent shop order has no accept/decline screen — the nearest
     * rider is handed the job directly rather than asked. This is how long
     * they have to actually show up before it moves to the next nearest, so
     * it needs to be long enough to walk or ride to a shop, not just glance at
     * a phone — a lot longer than `riderOfferTimeoutSeconds`, which only times
     * a tap.
     */
    shopRiderAssignTimeoutSeconds: int('SHOP_RIDER_ASSIGN_TIMEOUT_SECONDS', 300),

    /**
     * How far counts as "nearby" for the shopkeeper dashboard's ambient rider
     * indicator — a courtesy heads-up, not a dispatch decision, so it is a
     * shorter radius than `riderSearchRadiusMeters`.
     */
    nearbyRiderRadiusMeters: int('NEARBY_RIDER_RADIUS_METERS', 5000),
  }),

  /**
   * Paying the stalls.
   *
   * Nothing reaches a shopkeeper until the customer has the goods. What they
   * are owed is recorded at delivery and held, then released into their wallet
   * automatically. The hold is the window in which a delivery can still go
   * wrong — a complaint, a refund, a chargeback — and money already paid out is
   * far harder to claw back than money not yet released.
   */
  settlement: Object.freeze({
    holdHours: int('STALL_SETTLEMENT_HOLD_HOURS', 24),

    /**
     * The floor for taking the money early, before the hold expires.
     *
     * Each payout is a ledger write and, eventually, a bank transfer that costs
     * something to make. A floor stops a stall draining ₹20 at a time all day.
     * Default ₹200.
     */
    minEarlyPayoutPaise: int('STALL_MIN_EARLY_PAYOUT_PAISE', 20000),

    /**
     * Platform commission, in basis points of the stall's gross.
     *
     * Zero by default: the customer pays the market price and the stall is owed
     * the market price, so introducing a cut is a business decision, not
     * something that should arrive silently with a deploy. 250 = 2.5%.
     */
    commissionBps: int('STALL_COMMISSION_BPS', 0),
  }),

  /**
   * Photographs of the actual produce, taken by the stall holding it.
   *
   * Stored inline rather than in object storage, so the cap is doing real work:
   * it bounds a Mongo document, an API response, and a customer's mobile data
   * all at once. The client downscales before uploading, but the client cannot
   * be trusted, so the same limit is enforced at the route.
   */
  freshPhoto: Object.freeze({
    /** Decoded bytes. ~120 KB is a legible 800px photo at JPEG quality 0.6. */
    maxBytes: int('MARKET_FRESH_PHOTO_MAX_BYTES', 120_000),

    /**
     * How long a photo counts as "today's".
     *
     * Deliberately shorter than the retention below: a stale photo stops being
     * shown to customers long before it is deleted, so a shopkeeper who
     * re-photographs on day three overwrites their row rather than creating a
     * second one. Showing a four-day-old photograph as evidence of freshness
     * would be worse than showing the stock image.
     */
    freshForHours: int('MARKET_FRESH_PHOTO_FRESH_HOURS', 24),

    /** When the TTL index removes it. See models/StallPhoto.js. */
    retentionDays: int('MARKET_FRESH_PHOTO_RETENTION_DAYS', 7),
  }),

  cookies: Object.freeze({
    refreshName: 'vb_rt',
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/auth',
  }),
});

if (fatal.length > 0) {
  const message = ['Invalid environment configuration:', ...fatal.map((e) => `  - ${e}`)].join('\n');
  throw new Error(message);
}

if (ephemeral.length > 0 && !isTest) {
  console.warn(
    `[config] ${ephemeral.join(', ')} not set — generated ephemeral secret(s) for this process.\n` +
    '[config] Sessions will not survive a restart. Set real values in .env before deploying.'
  );
}

/**
 * Collecting money with no way to recover a payment the browser never confirmed.
 *
 * Only worth saying when Razorpay is actually live — in development there is
 * nothing to reconcile, and a warning printed on every local boot is a warning
 * nobody reads.
 */
if (razorpayConfigured && !razorpayWebhookSecret && !isTest) {
  console.warn(
    '[config] RAZORPAY_WEBHOOK_SECRET is not set, so POST /api/wallet/webhook answers 503.\n' +
    '[config] Payments still work, but a customer whose browser closes between paying and\n' +
    '[config] returning will have been charged without being credited, and nothing will fix it.\n' +
    '[config] Register the endpoint in the Razorpay dashboard and set the secret it gives you.'
  );
}

/**
 * An inbox number with no app secret.
 *
 * This looks configured and cannot work. The number is real, the wa.me link
 * opens, the user sends the message — and the webhook rejects every delivery
 * because the signature is the only thing establishing a request came from Meta.
 * Nothing is logged at the point of failure that mentions the missing secret, so
 * the symptom is codes that sit at "waiting for your message" forever with a
 * webhook returning 503 to Meta, which eventually disables the subscription.
 *
 * `whatsappInboundConfigured` already treats this combination as off, so the
 * channel is correctly hidden from the sign-in screen. The warning exists
 * because "I set the inbox number and the button never appeared" is otherwise a
 * silent dead end.
 */
if (whatsappInboxNumber && !whatsappInboundConfigured && !isTest) {
  console.warn(
    '[config] WHATSAPP_INBOX_NUMBER is set but WHATSAPP_APP_SECRET is not, so reverse OTP over\n' +
    '[config] WhatsApp is switched OFF and its button will not appear on the sign-in screen.\n' +
    '[config] Inbound webhooks cannot be authenticated without the secret. Copy it from\n' +
    '[config] App Settings -> Basic -> App Secret in the Meta dashboard.'
  );
}

/**
 * The mirror of the above for the SMS relay, where either half alone is useless:
 * a number nothing forwards from, or a secret guarding an endpoint no number
 * points at.
 */
if (!smsGatewayConfigured && (smsGatewayInboxNumber || smsGatewaySecret) && !isTest) {
  console.warn(
    `[config] Reverse OTP over SMS is switched OFF: ${smsGatewayInboxNumber ? 'SMS_GATEWAY_SECRET' : 'SMS_GATEWAY_INBOX_NUMBER'} is not set.\n` +
    '[config] Both are required — one names the number users message, the other authenticates\n' +
    '[config] the relay that forwards what it receives to POST /api/gateway/reverse-otp-sms.'
  );
}

module.exports = config;
