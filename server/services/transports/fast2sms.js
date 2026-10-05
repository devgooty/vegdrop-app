'use strict';

/**
 * Fast2SMS transport for one-time codes (India, plain SMS).
 *
 * WHY THIS EXISTS
 *
 * WhatsApp Cloud API needs a Meta-approved AUTHENTICATION template and is billed
 * per message. Fast2SMS is the cheap alternative the notify layer was left room
 * for ("add an SMS provider"). It uses their `otp` route, which works without
 * DLT registration: Fast2SMS fixes the message wording ("Your OTP: <code>"), so
 * there is no template to get approved and no sender id to register. Once the
 * business has DLT sender and template ids a `dlt` route would allow branded
 * text; that is a separate route with different parameters and is not done here.
 *
 * TWO ROUTES
 *
 * Without `otpTemplateId` this uses `POST /dev/bulkV2` with `route=otp`. That
 * route is gated: until the account's website is verified Fast2SMS answers
 * `status_code 996`.
 *
 * With `otpTemplateId` (FAST2SMS_OTP_ID) it uses `POST /dev/otp/send`, which
 * sends through an OTP template created in the Fast2SMS dashboard. We still pass
 * OUR OWN code in `otp`, so generation, hashing, expiry and attempt limits stay
 * in services/otp.js — Fast2SMS's own Verify/Resend endpoints are not used, and
 * must not be: a second source of truth for "is this code right" is how a code
 * ends up valid in one place and not the other.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *  - It never logs the code. Fast2SMS error messages are redacted of it too, in
 *    case a provider ever echoes the request back.
 *  - It never lets Fast2SMS's HTTP status become the caller's HTTP status. A
 *    failure here is our integration (key, wallet balance, account state), not
 *    the user's request — see the note in middleware/errors.js.
 *  - It reports one generic failure for every cause, so "this number is not
 *    reachable" is not an account-enumeration oracle.
 *
 * `POST /dev/bulkV2` can answer HTTP 200 with `{ return: false }`, so success is
 * judged on the body, not on the status line alone.
 */

const { ApiError } = require('../../middleware/errors');

/** The `otp` route: Fast2SMS fixes the wording, and needs website verification first. */
const ENDPOINT = 'https://www.fast2sms.com/dev/bulkV2';

/** The OTP API: sends through an OTP template (`otp_id`) the account has set up. */
const TEMPLATE_ENDPOINT = 'https://www.fast2sms.com/dev/otp/send';

/** Retried once; everything else (bad key, no balance, bad number) is permanent. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Reduce a stored phone number to the 10-digit Indian mobile Fast2SMS expects.
 *
 * `fields.phone` in middleware/validate.js already normalises every stored number
 * to exactly 10 digits starting 6-9, so this is a defensive second look at a
 * value that arrives from the OTP service, not a first parse.
 */
function toFast2smsNumber(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(-10);

  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new Error(`Cannot build a Fast2SMS destination from a ${digits.length}-digit number.`);
  }
  return digits;
}

/** ******3210 — enough to correlate a log line, not enough to enumerate. */
function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Provider text for the server log, with the code scrubbed. */
function describeFailure(body, status, code) {
  if (!body || typeof body !== 'object') return `HTTP ${status} with no JSON body`;

  const message = Array.isArray(body.message) ? body.message.join('; ') : String(body.message ?? '');
  return [`HTTP ${status}`, body.status_code != null ? `status_code=${body.status_code}` : null, message ? `message=${message}` : null]
    .filter(Boolean)
    .join(' ')
    .split(code)
    .join('******');
}

/**
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] injection seam for tests
 * @returns {{ name: string, send: (msg: object) => Promise<void> }}
 */
function createFast2smsTransport({
  apiKey,
  otpTemplateId = '',
  timeoutMs = 10000,
  maxAttempts = 2,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) {
    throw new Error('createFast2smsTransport requires an apiKey.');
  }

  /** Single HTTP attempt. Returns { ok, status, body }. */
  async function attempt(endpoint, payload) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    // Judged on the body too: Fast2SMS reports some rejections with a 200.
    return { ok: response.ok && body?.return === true, status: response.status, body };
  }

  return {
    name: 'fast2sms',

    async send(message) {
      const { channel, to, otp } = message || {};

      if (channel === 'email') {
        throw new Error('The Fast2SMS transport cannot deliver email. Configure an email transport.');
      }

      if (!otp || typeof otp.code !== 'string') {
        throw new Error(
          'The Fast2SMS transport requires a structured `otp` field. The `otp` route takes only the ' +
          'code, so it cannot be taken from prose.'
        );
      }

      const destination = toFast2smsNumber(to);
      let endpoint = ENDPOINT;
      // `variables_values` is the code alone: Fast2SMS wraps it in its own text.
      let payload = { route: 'otp', variables_values: otp.code, numbers: destination };

      if (otpTemplateId) {
        endpoint = TEMPLATE_ENDPOINT;
        payload = {
          mobile: destination,
          otp_id: otpTemplateId,
          otp: otp.code,
          otp_length: otp.code.length,
          // The OTP API takes minutes (1-10080); round UP so a 5 minute code is
          // never shortened, and never ask for less than one.
          otp_expiry: Math.max(1, Math.ceil((otp.ttlSeconds || 300) / 60)),
        };
      }

      const genericFailure = () =>
        new ApiError(
          503,
          'Could not send your verification code right now. Please try again in a moment.',
          'OTP_DELIVERY_FAILED'
        );

      for (let n = 1; n <= maxAttempts; n += 1) {
        let result;
        try {
          result = await attempt(endpoint, payload);
        } catch (err) {
          // Network failure, DNS, or the AbortSignal timeout firing.
          if (n < maxAttempts) continue;
          console.error('[fast2sms] send failed', {
            to: maskPhone(destination),
            attempt: n,
            detail: `${err?.name || 'Error'}: ${err?.message || 'request failed'}`,
          });
          throw genericFailure();
        }

        if (result.ok) {
          // The code is never included here.
          console.info('[fast2sms] code dispatched', {
            to: maskPhone(destination),
            requestId: result.body?.request_id ?? null,
            route: otpTemplateId ? 'otp_template' : 'otp',
            attempt: n,
          });
          return;
        }

        if (RETRYABLE_STATUS.has(result.status) && n < maxAttempts) continue;

        console.error('[fast2sms] send rejected', {
          to: maskPhone(destination),
          attempt: n,
          detail: describeFailure(result.body, result.status, otp.code),
        });
        throw genericFailure();
      }

      // Unreachable: the loop either returns or throws.
      throw genericFailure();
    },
  };
}

module.exports = {
  createFast2smsTransport,
  // Exported for tests.
  toFast2smsNumber,
  maskPhone,
};
