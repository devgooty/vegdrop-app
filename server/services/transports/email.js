'use strict';

/**
 * SMTP transport for one-time codes.
 *
 * WHY SMTP AND NOT A PROVIDER API
 *
 * Every hosted provider (SES, SendGrid, Resend, Brevo) speaks SMTP as well as its
 * own HTTP API, so SMTP is the one shape that works everywhere without picking a
 * vendor — including a plain Gmail account with an app password, which is what a
 * small operation actually starts with. The WhatsApp transport uses `fetch`
 * because Meta has no SMTP equivalent; hand-rolling SMTP would mean implementing
 * AUTH, TLS upgrade and MIME encoding, which is what nodemailer is for.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *  - It never logs the code. Only the console stub prints codes, and only because
 *    production refuses to boot on it. Error paths here redact.
 *  - It never lets the SMTP server's failure become the caller's HTTP status. A
 *    refused relay is our integration failing, not the caller's request being
 *    malformed — the same rule middleware/errors.js states for the Razorpay
 *    client.
 *  - It reports one generic failure for every cause. "No such mailbox" would
 *    otherwise confirm whether an address is registered.
 */

const { ApiError } = require('../../middleware/errors');

/** Transient at the SMTP layer; worth one retry. Everything else is permanent. */
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'EENVELOPE',
]);

/**
 * SMTP reply codes worth naming in logs, because each has a distinct fix.
 * Anything unlisted is logged with its raw code.
 */
const ERROR_HINTS = Object.freeze({
  EAUTH: 'SMTP authentication failed. For Gmail this means an App Password is required — a normal account password is rejected once 2FA is on.',
  ESOCKET: 'Could not open a socket. Check SMTP_HOST/SMTP_PORT, and that SMTP_SECURE matches the port (true for 465, false for 587).',
  EENVELOPE: 'The server rejected the sender or recipient. SMTP_FROM usually has to be an address the account is authorised to send as.',
  ETIMEDOUT: 'The SMTP server did not answer in time.',
});

/** j***@example.com — enough to correlate a log line, not enough to enumerate. */
function maskEmail(value) {
  const raw = String(value ?? '');
  const at = raw.indexOf('@');
  if (at <= 0) return '***';
  return `${raw.slice(0, 1)}${'*'.repeat(Math.max(1, at - 1))}${raw.slice(at)}`;
}

function describeSmtpError(err) {
  const code = err?.code || err?.responseCode || null;
  const hint = ERROR_HINTS[code];
  return {
    summary: [
      `code=${code}`,
      err?.responseCode ? `smtp=${err.responseCode}` : null,
      hint ? `hint=${hint}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    code,
  };
}

/**
 * @param {object} options
 * @param {object} [options.transporterImpl] injection seam for tests
 * @returns {{ name: string, send: (msg: object) => Promise<void> }}
 */
function createEmailTransport({
  host,
  port,
  secure,
  user,
  pass,
  from,
  timeoutMs = 10000,
  transporterImpl = null,
}) {
  const transporter =
    transporterImpl ||
    require('nodemailer').createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });

  async function deliver(message) {
    return transporter.sendMail(message);
  }

  return {
    name: 'email',

    async send({ to, subject, text, html }) {
      // Both parts when there is markup: nodemailer builds a multipart/alternative
      // so a client that refuses HTML falls back to the text rather than to an
      // empty body.
      const message = {
        from,
        to,
        subject,
        text,
        ...(html ? { html } : {}),
      };

      let lastError = null;

      // One retry, matching the WhatsApp transport: a transient socket problem is
      // common enough that failing a sign-in over it is worse than a second try.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await deliver(message);
          return;
        } catch (err) {
          lastError = err;
          const { code } = describeSmtpError(err);
          if (attempt === 1 || !RETRYABLE_CODES.has(code)) break;
        }
      }

      const { summary } = describeSmtpError(lastError);
      // The code is in `text` and must not reach a log line, so the message body
      // is never included here.
      console.error('[notify] email delivery failed', {
        to: maskEmail(to),
        detail: summary,
      });

      throw new ApiError(
        503,
        'Could not deliver the verification code. Please try again shortly.',
        'OTP_DELIVERY_FAILED'
      );
    },
  };
}

module.exports = { createEmailTransport, maskEmail };
