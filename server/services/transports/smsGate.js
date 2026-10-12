'use strict';

/**
 * "SMS Gateway for Android" transport: codes are sent as ordinary SMS from a SIM
 * in an Android phone running the open-source SMS Gateway app
 * (github.com/capcom6/android-sms-gateway, sms-gate.app).
 *
 * HOW IT WORKS
 *
 * The app keeps a connection to a relay server (the project's free cloud at
 * api.sms-gate.app, or a self-hosted one). We POST the message there with the
 * username/password the app shows under "Cloud Server"; the relay pushes it to
 * the phone, and the phone sends it from its own SIM.
 *
 * WHAT IT COSTS, STATED PLAINLY
 *
 *  - It is a person's SIM doing a business's job. Indian operators cap how many
 *    SMS one SIM may send a day, and flag SIMs that send machine-like traffic;
 *    a blocked SIM means no code reaches anyone. That is the same failure that
 *    got the unofficial WhatsApp client removed (see CLAUDE.md), so this is a
 *    stopgap until a DLT-registered provider is live — keep reverse OTP
 *    configured beside it so "didn't get the code?" still has somewhere to go.
 *  - A 2xx here means the relay ACCEPTED the message, not that it was sent. The
 *    phone may be offline, out of balance, or blocked; the code then never
 *    arrives and nothing on our side can tell. The fallback is the user tapping
 *    "verify by sending us a message" on the code screen.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (same rules as the other transports)
 *
 *  - It never logs the message text, which contains the code, nor the
 *    credentials. Provider error text is scrubbed of the code as well.
 *  - It never lets the relay's HTTP status become the caller's HTTP status; every
 *    failure is one generic 503 OTP_DELIVERY_FAILED.
 */

const { ApiError } = require('../../middleware/errors');

const DEFAULT_BASE_URL = 'https://api.sms-gate.app/3rdparty/v1';

/** Retried once; everything else (bad credentials, bad request) is permanent. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Stored numbers are 10 local digits (see `fields.phone` in middleware/validate.js);
 * the app dials what it is given, so send the full international form.
 */
function toE164India(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(-10);

  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new Error(`Cannot build an SMS destination from a ${digits.length}-digit number.`);
  }
  return `+91${digits}`;
}

/** ******3210 — enough to correlate a log line, not enough to enumerate. */
function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function describeFailure(body, status, code) {
  let detail = `HTTP ${status}`;
  if (body && typeof body === 'object') {
    const message = body.message ?? body.error ?? '';
    if (message) detail += ` message=${typeof message === 'string' ? message : JSON.stringify(message)}`;
  }
  return code ? detail.split(code).join('******') : detail;
}

/**
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] injection seam for tests
 * @returns {{ name: string, send: (msg: object) => Promise<void> }}
 */
function createSmsGateTransport({
  username,
  password,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 10000,
  maxAttempts = 2,
  fetchImpl = globalThis.fetch,
}) {
  if (!username || !password) {
    throw new Error('createSmsGateTransport requires username and password.');
  }

  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/message`;
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  async function attempt(payload) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }

  return {
    name: 'smsgate',

    async send(message) {
      const { channel, to, text, otp } = message || {};

      if (channel === 'email') {
        throw new Error('The SMS Gateway transport cannot deliver email. Configure an email transport.');
      }
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('The SMS Gateway transport sends the composed `text`, and none was given.');
      }

      const destination = toE164India(to);
      const payload = { textMessage: { text }, phoneNumbers: [destination] };
      const code = otp?.code;

      const genericFailure = () =>
        new ApiError(
          503,
          'Could not send your verification code right now. Please try again in a moment.',
          'OTP_DELIVERY_FAILED'
        );

      for (let n = 1; n <= maxAttempts; n += 1) {
        let result;
        try {
          result = await attempt(payload);
        } catch (err) {
          if (n < maxAttempts) continue;
          console.error('[smsgate] send failed', {
            to: maskPhone(destination),
            attempt: n,
            detail: `${err?.name || 'Error'}: ${err?.message || 'request failed'}`,
          });
          throw genericFailure();
        }

        if (result.ok) {
          // Accepted by the relay — not proof the phone has sent it yet.
          console.info('[smsgate] code queued on the phone', {
            to: maskPhone(destination),
            messageId: result.body?.id ?? null,
            state: result.body?.state ?? null,
            attempt: n,
          });
          return;
        }

        if (RETRYABLE_STATUS.has(result.status) && n < maxAttempts) continue;

        console.error('[smsgate] send rejected', {
          to: maskPhone(destination),
          attempt: n,
          detail: describeFailure(result.body, result.status, code),
        });
        throw genericFailure();
      }

      throw genericFailure();
    },
  };
}

module.exports = {
  createSmsGateTransport,
  // Exported for tests.
  toE164India,
  maskPhone,
  DEFAULT_BASE_URL,
};
