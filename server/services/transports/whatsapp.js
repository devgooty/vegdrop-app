'use strict';

/**
 * WhatsApp Cloud API transport for one-time codes.
 *
 * WHY A TEMPLATE AND NOT A TEXT MESSAGE
 *
 * WhatsApp does not let a business send free-form text to a user who has not
 * messaged first (outside the 24-hour customer-service window). Every
 * business-initiated message must use a template that Meta has approved in
 * advance. For codes specifically the template must be category AUTHENTICATION:
 * Meta rejects codes sent through UTILITY or MARKETING templates, and an
 * authentication template's body may contain exactly one variable — the code.
 *
 * A naive `type: "text"` send returns 200-looking success in some tooling and
 * then silently fails to deliver, so this transport only ever sends templates.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *  - It never logs the code. The console transport prints codes because it is a
 *    development stub; this one talks to a real provider, so the code appears in
 *    the request body and nowhere else. Error paths redact it explicitly.
 *  - It never lets Meta's HTTP status become the caller's HTTP status. A failure
 *    here is our integration failing, not the user's request being malformed —
 *    see the note in middleware/errors.js about the Razorpay client doing this.
 *  - It reports one generic failure message for every cause. "This number is not
 *    on WhatsApp" would otherwise be an account-enumeration oracle.
 */

const { ApiError } = require('../../middleware/errors');

/** Meta retries these itself; so do we, once. Everything else is permanent. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Meta error codes worth naming in server logs, because each has a distinct fix.
 * Not exhaustive — anything unlisted is logged with its raw code.
 */
const ERROR_HINTS = Object.freeze({
  132001: 'Template not found. Check WHATSAPP_OTP_TEMPLATE_NAME and WHATSAPP_TEMPLATE_LOCALE match an APPROVED template in WhatsApp Manager.',
  132000: 'Template parameter count mismatch. An authentication template takes exactly one body variable (the code); set WHATSAPP_OTP_INCLUDE_BUTTON=false if your template has no OTP button.',
  132005: 'Template parameter too long.',
  131026: 'Message undeliverable — the destination is very likely not a WhatsApp user.',
  131047: 'Re-engagement required. This indicates a non-template send; authentication templates are exempt, so the payload shape is wrong.',
  131056: 'Pair rate limit hit for this sender/recipient pair.',
  133010: 'Phone number not registered on the WhatsApp Business Account.',
  190: 'Access token is invalid or expired. A short-lived token was probably used instead of a permanent System User token.',
  2: 'Transient Graph API problem on Meta\'s side.',
  368: 'Sender temporarily blocked for policy violations.',
});

/**
 * Convert a stored phone number to the digits-only international form the Cloud
 * API expects (no `+`, no separators).
 *
 * `fields.phone` in middleware/validate.js normalises every number to exactly 10
 * digits starting 6-9 and strips any +91/91/0 prefix, so a 10-digit value here is
 * unambiguously a local number that needs the country code prepended.
 */
function toWhatsappNumber(raw, defaultCountryCode) {
  const digits = String(raw ?? '').replace(/\D/g, '');

  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  // Already carries a country code.
  if (digits.length >= 11 && digits.length <= 15) return digits;

  throw new Error(`Cannot build a WhatsApp destination from a ${digits.length}-digit number.`);
}

/** ******3210 — enough to correlate a log line, not enough to enumerate. */
function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/**
 * Build the Cloud API payload for an authentication template.
 *
 * The button component is included by default because Meta's authentication
 * templates carry a copy-code / one-tap button, and the code must be supplied
 * again as that button's parameter. Templates created without a button reject the
 * extra component with error 132000 — set includeOtpButton to false for those.
 *
 * Note the button sub_type: Meta documents `url` for authentication-template OTP
 * buttons even when the button renders as "copy code". It is configurable
 * because that detail has changed before.
 */
function buildTemplatePayload({ to, code, templateName, templateLocale, includeOtpButton, buttonSubType }) {
  const components = [
    { type: 'body', parameters: [{ type: 'text', text: code }] },
  ];

  if (includeOtpButton) {
    components.push({
      type: 'button',
      sub_type: buttonSubType,
      index: '0',
      parameters: [{ type: 'text', text: code }],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLocale },
      components,
    },
  };
}

function describeMetaError(body, status) {
  const error = body?.error;
  if (!error) return { summary: `HTTP ${status} with no error envelope`, code: null };

  const code = error.code ?? null;
  const hint = ERROR_HINTS[code];
  return {
    summary: [
      `code=${code}`,
      error.error_subcode ? `subcode=${error.error_subcode}` : null,
      error.message ? `message=${error.message}` : null,
      error.fbtrace_id ? `fbtrace_id=${error.fbtrace_id}` : null,
      hint ? `hint=${hint}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    code,
  };
}

/**
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] injection seam for tests
 * @returns {{ name: string, send: (msg: object) => Promise<void> }}
 */
function createWhatsappTransport({
  phoneNumberId,
  accessToken,
  apiVersion,
  templateName,
  templateLocale,
  includeOtpButton = true,
  buttonSubType = 'url',
  defaultCountryCode = '91',
  timeoutMs = 10000,
  maxAttempts = 2,
  fetchImpl = globalThis.fetch,
}) {
  if (!phoneNumberId || !accessToken || !templateName) {
    throw new Error('createWhatsappTransport requires phoneNumberId, accessToken and templateName.');
  }

  const endpoint = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;

  /** Single HTTP attempt. Returns { ok, status, body }. */
  async function attempt(payload) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON body from a JSON API means something intercepted the request.
      body = null;
    }

    return { ok: response.ok, status: response.status, body };
  }

  return {
    name: 'whatsapp',

    async send(message) {
      const { channel, to, otp } = message || {};

      if (channel === 'email') {
        // This transport can only send its one approved template. Routing email
        // here is a wiring mistake, and failing loudly beats dropping the code.
        throw new Error('The WhatsApp transport cannot deliver email. Configure an email transport.');
      }

      if (!otp || typeof otp.code !== 'string') {
        throw new Error(
          'The WhatsApp transport requires a structured `otp` field. WhatsApp business-initiated ' +
          'messages must use an approved template, so the code cannot be taken from prose.'
        );
      }

      const destination = toWhatsappNumber(to, defaultCountryCode);
      const payload = buildTemplatePayload({
        to: destination,
        code: otp.code,
        templateName,
        templateLocale,
        includeOtpButton,
        buttonSubType,
      });

      // One generic client-facing failure for every cause below.
      const genericFailure = () =>
        new ApiError(
          503,
          'Could not send your verification code right now. Please try again in a moment.',
          'OTP_DELIVERY_FAILED'
        );

      let lastDetail = 'no attempt was made';

      for (let n = 1; n <= maxAttempts; n += 1) {
        let result;
        try {
          result = await attempt(payload);
        } catch (err) {
          // Network failure, DNS, or the AbortSignal timeout firing.
          lastDetail = `${err?.name || 'Error'}: ${err?.message || 'request failed'}`;
          if (n < maxAttempts) continue;
          console.error('[whatsapp] send failed', { to: maskPhone(destination), attempt: n, detail: lastDetail });
          throw genericFailure();
        }

        if (result.ok) {
          const messageId = result.body?.messages?.[0]?.id ?? null;
          // The code is never included here.
          console.info('[whatsapp] code dispatched', {
            to: maskPhone(destination),
            template: templateName,
            messageId,
            attempt: n,
          });
          return;
        }

        const { summary, code } = describeMetaError(result.body, result.status);
        lastDetail = `HTTP ${result.status} ${summary}`;

        const retryable = RETRYABLE_STATUS.has(result.status);
        if (retryable && n < maxAttempts) continue;

        console.error('[whatsapp] send rejected', {
          to: maskPhone(destination),
          template: templateName,
          attempt: n,
          status: result.status,
          metaCode: code,
          detail: summary,
        });
        throw genericFailure();
      }

      // Unreachable: the loop either returns or throws.
      console.error('[whatsapp] send exhausted attempts', { to: maskPhone(destination), detail: lastDetail });
      throw genericFailure();
    },
  };
}

module.exports = {
  createWhatsappTransport,
  // Exported for tests.
  toWhatsappNumber,
  buildTemplatePayload,
  maskPhone,
};
