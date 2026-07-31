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
  : optional('MONGODB_URI', 'mongodb://127.0.0.1:27017/vegbazzar');

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

const whatsappBotBridgeToken = optional('WHATSAPP_BOT_BRIDGE_TOKEN', '');

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
      ? `EMAIL_FROM does not contain an email address (got "${emailFrom}"). Use either "no-reply@example.com" or "VegBazzar <no-reply@example.com>".`
      : 'An email provider API key is set but EMAIL_FROM is empty. Set it to a sender the provider has verified, e.g. "VegBazzar <no-reply@example.com>". A dashboard that strips quotes can leave this blank — check the stored value, not just that the variable exists.'
  );
}

if (smtpHost && !smtpFrom && emailProviders.length === 0) {
  fatal.push('SMTP_HOST is set but SMTP_FROM is not. Most relays reject a message with no envelope sender.');
}

/**
 * console      — dev stub, prints codes to stdout
 * whatsapp     — official WhatsApp Cloud API (approved template, paid per message)
 * whatsapp_bot — UNOFFICIAL WhatsApp Web client via server/bot (free, against
 *                WhatsApp's Terms of Service, the number can be banned)
 */
const VALID_TRANSPORTS = ['console', 'whatsapp', 'whatsapp_bot'];

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

if (notifyTransport === 'whatsapp_bot' && whatsappBotBridgeToken.length < 16) {
  fatal.push(
    'NOTIFY_TRANSPORT=whatsapp_bot requires WHATSAPP_BOT_BRIDGE_TOKEN (at least 16 characters). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'
  );
}

// Shipping the console stub to production means verification codes are written
// to server logs instead of being delivered. Fail at boot, not at first send.
if (isProduction && notifyTransport === 'console') {
  fatal.push(
    'A real notification transport is required in production. Configure WhatsApp (WHATSAPP_*) or implement another transport in server/services/notify.js.'
  );
}

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const razorpayConfigured = Boolean(razorpayKeyId && razorpayKeySecret);

// A real key id starts with rzp_live_ / rzp_test_. Refuse obvious placeholders in prod.
if (isProduction && (!razorpayConfigured || !/^rzp_(live|test)_/.test(razorpayKeyId))) {
  fatal.push('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET must be real credentials in production. Payments cannot run in mock mode.');
}

const config = Object.freeze({
  NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: !isProduction && !isTest,

  port: int('PORT', 5000),
  trustProxy: optional('TRUST_PROXY', isProduction ? '1' : ''),

  mongoUri,

  corsOrigins,

  jwt: Object.freeze({
    accessSecret: secret('JWT_ACCESS_SECRET'),
    refreshSecret: secret('JWT_REFRESH_SECRET'),
    accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 15 * 60), // 15 minutes
    refreshTtlSeconds: int('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60), // 30 days
    issuer: optional('JWT_ISSUER', 'vegbazzar'),
    audience: optional('JWT_AUDIENCE', 'vegbazzar-app'),
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
   * Unofficial WhatsApp bot (server/bot). Free, and against WhatsApp's Terms of
   * Service — the number can be banned without warning.
   */
  whatsappBot: Object.freeze({
    bridgeHost: optional('WHATSAPP_BOT_BRIDGE_HOST', '127.0.0.1'),
    bridgePort: int('WHATSAPP_BOT_BRIDGE_PORT', 5055),
    bridgeUrl: optional('WHATSAPP_BOT_BRIDGE_URL', `http://127.0.0.1:${int('WHATSAPP_BOT_BRIDGE_PORT', 5055)}`),
    bridgeToken: whatsappBotBridgeToken,
    // Generous: the bot paces sends on purpose, so a queued message waits.
    bridgeTimeoutMs: int('WHATSAPP_BOT_BRIDGE_TIMEOUT_MS', 30000),

    authDir: optional('WHATSAPP_BOT_AUTH_DIR', '.auth'),
    countryCode: optional('WHATSAPP_BOT_COUNTRY_CODE', '91').replace(/\D/g, ''),

    // Ban-avoidance pacing. Raising these raises the risk.
    minIntervalMs: int('WHATSAPP_BOT_MIN_INTERVAL_MS', 3000),
    jitterMs: int('WHATSAPP_BOT_JITTER_MS', 2000),
    dailyCap: int('WHATSAPP_BOT_DAILY_CAP', 200),
    perRecipientCooldownMs: int('WHATSAPP_BOT_RECIPIENT_COOLDOWN_MS', 60000),

    verbose: optional('WHATSAPP_BOT_VERBOSE', 'false') === 'true',
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
    configured: razorpayConfigured,
    // Mock order creation is a development affordance only; prod is blocked above.
    allowMock: !isProduction && !razorpayConfigured,
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

module.exports = config;
