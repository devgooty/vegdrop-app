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
 * @typedef {object} Transport
 * @property {string} name
 * @property {(msg: { channel: 'sms'|'email', to: string, subject?: string, text: string }) => Promise<void>} send
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

function resolveTransport() {
  if (config.isTest) return nullTransport;
  if (config.isProduction) {
    // Deliberate hard failure. Shipping with the dev stub would mean OTP codes
    // are written to server logs instead of being delivered to the user.
    throw new Error(
      'No production notification transport is configured. Implement an SMS/email transport in server/services/notify.js before deploying.'
    );
  }
  return consoleTransport;
}

let transport = null;
function getTransport() {
  if (!transport) transport = resolveTransport();
  return transport;
}

/** Test seam: swap the transport (e.g. to capture messages in assertions). */
function setTransport(next) {
  transport = next;
}

async function sendOtp({ channel, to, code, purpose, ttlSeconds }) {
  const minutes = Math.round(ttlSeconds / 60);
  const purposeText = {
    login: 'sign in to',
    register: 'create your',
    profile_update: 'update your',
    password_reset: 'reset the password for',
  }[purpose] || 'verify';

  await getTransport().send({
    channel,
    to,
    subject: 'Your VegBazzar verification code',
    text:
      `${code} is your VegBazzar verification code to ${purposeText} your account.\n` +
      `It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Do not share it with anyone.`,
  });
}

module.exports = { sendOtp, setTransport, consoleTransport, nullTransport };
