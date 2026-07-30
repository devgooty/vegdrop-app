'use strict';

const config = require('../config/env');

/**
 * Outbound message delivery.
 *
 * A single narrow interface with a development stub. Wiring a real provider
 * (Twilio/MSG91 for SMS, SES/SendGrid/SMTP for email) means implementing
 * `send` in a new transport and selecting it here — no caller changes.
 */

/**
 * @typedef {object} OtpDetails
 * @property {string} code      the plaintext code
 * @property {string} purpose   login (sign-up shares it) | phone_change
 * @property {number} ttlSeconds
 */

/**
 * @typedef {object} Transport
 * @property {string} name
 * @property {(msg: { channel: 'sms'|'email', to: string, subject?: string, text: string, otp?: OtpDetails }) => Promise<void>} send
 *
 * `text` is a fully composed human-readable message, which is all a plain SMS or
 * email transport needs. `otp` carries the same information structured, because
 * WhatsApp business-initiated messages must go through a pre-approved template
 * whose only variable is the code — that transport cannot parse it back out of
 * the prose. Transports that do not need it ignore it.
 */

/** @type {Transport} */
const consoleTransport = {
  name: 'console',
  async send({ channel, to, subject, text }) {
    // Codes are printed only outside production, and production refuses to boot
    // on this transport (see resolveTransport), so this cannot leak live secrets.
    console.info(
      `\n──────── ${channel.toUpperCase()} (dev stub) ────────\n` +
        `to:      ${to}\n` +
        (subject ? `subject: ${subject}\n` : '') +
        `${text}\n` +
        '───────────────────────────────────────\n'
    );
  },
};

/** @type {Transport} */
const nullTransport = {
  name: 'null',
  async send() {
    /* Swallowed: used under test so suites do not spam stdout. */
  },
};

/**
 * Build the transport that delivers to PHONE destinations.
 *
 * Kept separate from the email transport because every real provider handles one
 * or the other, never both. Routing an email address into a phone transport used
 * to be possible and threw at send time — see resolveRegistry below.
 */
function resolvePhoneTransport() {
  if (config.notifyTransport === 'whatsapp_bot') {
    const { createWhatsappBridgeTransport } = require('./transports/whatsappBridge');
    const bot = config.whatsappBot;

    console.warn(
      '[notify] transport=whatsapp_bot — UNOFFICIAL WhatsApp client.\n' +
      '[notify] This violates WhatsApp\'s Terms of Service and the number may be banned.\n' +
      `[notify] Requires \`npm run bot\` running and paired at ${bot.bridgeUrl}.`
    );

    return createWhatsappBridgeTransport({
      bridgeUrl: bot.bridgeUrl,
      bridgeToken: bot.bridgeToken,
      timeoutMs: bot.bridgeTimeoutMs,
    });
  }

  if (config.notifyTransport === 'whatsapp') {
    // Required config is validated at boot in config/env.js, so reaching here
    // with incomplete credentials is impossible.
    const { createWhatsappTransport } = require('./transports/whatsapp');
    const wa = config.whatsapp;

    console.info(
      `[notify] transport=whatsapp template=${wa.templateName} locale=${wa.templateLocale} api=${wa.apiVersion}`
    );

    return createWhatsappTransport({
      phoneNumberId: wa.phoneNumberId,
      accessToken: wa.accessToken,
      apiVersion: wa.apiVersion,
      templateName: wa.templateName,
      templateLocale: wa.templateLocale,
      includeOtpButton: wa.includeOtpButton,
      buttonSubType: wa.buttonSubType,
      defaultCountryCode: wa.defaultCountryCode,
      timeoutMs: wa.timeoutMs,
    });
  }

  if (config.isProduction) {
    // Backstop only: config/env.js already refuses to boot production on the
    // console stub, because that writes verification codes to server logs
    // instead of delivering them.
    throw new Error(
      'No production notification transport is configured. Set WHATSAPP_* credentials or implement another transport in server/services/notify.js before deploying.'
    );
  }

  return consoleTransport;
}

/**
 * Build the email transport.
 *
 * There is no real one, and no code is addressed to an email any more —
 * routes/auth.js always sends to the phone, because possession of the number is
 * the entire credential. This exists so that adding an email-addressed
 * notification later fails loudly in production rather than printing to a log.
 */
function resolveEmailTransport() {
  if (config.isProduction) {
    throw new Error(
      'No email transport is implemented. Verification codes are addressed to the phone; if you are adding an email-addressed notification, implement a transport in server/services/notify.js first.'
    );
  }
  return consoleTransport;
}

/**
 * Transport per channel.
 *
 * WHY THIS IS KEYED BY CHANNEL
 *
 * Resolution is per channel and lazy, so an unconfigured channel only fails if
 * something actually addresses it. A single global transport used to mean that
 * configuring a phone provider (WhatsApp) broke sign-in for every user who had
 * an email address: the phone transport correctly refused the email, and the
 * refusal surfaced as a failed login.
 */
const registry = new Map();

function transportFor(channel) {
  if (config.isTest) return nullTransport;

  if (!registry.has(channel)) {
    registry.set(channel, channel === 'email' ? resolveEmailTransport() : resolvePhoneTransport());
  }
  return registry.get(channel);
}

/** Test seam: swap the transport for every channel. */
function setTransport(next) {
  registry.set('email', next);
  registry.set('sms', next);
}

async function sendOtp({ channel, to, code, purpose, ttlSeconds }) {
  const minutes = Math.round(ttlSeconds / 60);
  const purposeText = {
    login: 'sign in to',
    phone_change: 'move',
  }[purpose] || 'verify';

  await transportFor(channel).send({
    channel,
    to,
    subject: 'Your VegBazzar verification code',
    text:
      `${code} is your VegBazzar verification code to ${purposeText} your account.\n` +
      `It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Do not share it with anyone.`,
    // Structured form for template-based transports; see the Transport typedef.
    otp: { code, purpose, ttlSeconds },
  });
}

module.exports = { sendOtp, setTransport, consoleTransport, nullTransport };
