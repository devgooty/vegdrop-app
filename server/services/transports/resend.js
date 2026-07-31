'use strict';

/**
 * Resend transport for one-time codes.
 *
 * WHY THIS EXISTS ALONGSIDE THE SMTP ONE
 *
 * Railway blocks outbound SMTP (25, 465, 587, 2525) on its Hobby and Trial
 * plans to protect its IP reputation, so nodemailer fails there with ESOCKET no
 * matter how it is configured — the credentials are never even reached. This
 * sends over ordinary HTTPS, which is not blocked. On a host that permits SMTP
 * either transport works; this one works everywhere.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *  - It never logs the code. The code is in the request body and nowhere else,
 *    and error paths redact.
 *  - It never lets Resend's HTTP status become the caller's. A 422 from Resend
 *    means our `from` address is wrong, not that the caller's request was — the
 *    mistake middleware/errors.js calls out for the Razorpay client.
 *  - It reports one generic failure for every cause, so "mailbox does not exist"
 *    cannot become an account-enumeration oracle.
 */

const { ApiError } = require('../../middleware/errors');

const ENDPOINT = 'https://api.resend.com/emails';

/** Resend retries these itself; so do we, once. Everything else is permanent. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Failures worth naming in logs, because each has a distinct fix. Resend returns
 * a machine-readable `name` alongside the message.
 */
const ERROR_HINTS = Object.freeze({
  validation_error:
    'Rejected the request. Usually the `from` address: Resend only accepts a domain you have verified, or onboarding@resend.dev.',
  missing_api_key: 'RESEND_API_KEY is not set.',
  invalid_api_key: 'RESEND_API_KEY is wrong or has been revoked.',
  restricted_api_key: 'This key lacks sending permission. Create one with Full Access or Sending Access.',
  not_found: 'Endpoint or resource not found — check the API version.',
  rate_limit_exceeded: 'Sending too fast for the current plan.',
  daily_quota_exceeded: 'Daily send quota reached.',
});

/** j***@example.com — enough to correlate a log line, not enough to enumerate. */
function maskEmail(value) {
  const raw = String(value ?? '');
  const at = raw.indexOf('@');
  if (at <= 0) return '***';
  return `${raw.slice(0, 1)}${'*'.repeat(Math.max(1, at - 1))}${raw.slice(at)}`;
}

function describeResendError(body, status) {
  const name = body?.name ?? null;
  const hint = ERROR_HINTS[name];
  return {
    summary: [
      `status=${status}`,
      name ? `name=${name}` : null,
      body?.message ? `message=${body.message}` : null,
      hint ? `hint=${hint}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    name,
  };
}

/**
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] injection seam for tests
 * @returns {{ name: string, send: (msg: object) => Promise<void> }}
 */
function createResendTransport({ apiKey, from, timeoutMs = 10000, fetchImpl = null }) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function post(payload) {
    // AbortController rather than relying on a default: a hung request would
    // otherwise hold a sign-in open until the platform's own timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let body = null;
      try {
        body = await response.json();
      } catch {
        /* A non-JSON body is still a failure; describeResendError copes. */
      }

      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'resend',

    async send({ to, subject, text }) {
      const payload = { from, to: [to], subject, text };

      let last = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await post(payload);
          if (result.ok) return;

          last = result;
          if (attempt === 1 || !RETRYABLE_STATUS.has(result.status)) break;
        } catch (err) {
          // Network error or the abort above.
          last = { status: 0, body: { message: err?.name === 'AbortError' ? 'timed out' : err?.message } };
          if (attempt === 1) break;
        }
      }

      const { summary } = describeResendError(last?.body, last?.status ?? 0);
      // `text` holds the code, so it is never included here.
      console.error('[notify] resend delivery failed', {
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

module.exports = { createResendTransport, maskEmail };
