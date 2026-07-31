'use strict';

/**
 * Email over HTTPS, for any of several providers.
 *
 * WHY HTTP AND NOT SMTP
 *
 * Railway blocks outbound SMTP (25, 465, 587, 2525) on its Hobby and Trial
 * plans to protect its IP reputation, so nodemailer fails there with ESOCKET
 * before it ever reaches a credential. Every provider below is reached over
 * ordinary HTTPS, which is not blocked.
 *
 * WHY ONE MODULE AND NOT SIX
 *
 * These APIs differ only in four things: the URL, the auth header, the shape of
 * the body, and which 2xx they answer with. Everything that actually matters —
 * not logging the code, masking the destination, retrying transient failures
 * only, refusing to let the provider's HTTP status become the caller's, and
 * reporting one indistinguishable error for every cause — is identical, and is
 * the part worth having exactly one copy of. Adding a provider is a table entry.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *  - It never logs the code. The code is in the request body and nowhere else.
 *  - It never reuses the provider's status. A 422 means our `from` address is
 *    wrong, not that the caller's request was — the mistake middleware/errors.js
 *    calls out for the Razorpay client.
 *  - It reports one generic failure for every cause, so "no such mailbox" cannot
 *    become an account-enumeration oracle.
 */

const { ApiError } = require('../../middleware/errors');

/** Worth one retry: the provider is up but momentarily unwilling. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Statuses that mean "this provider is done for now" rather than "this message
 * is bad". The failover chain moves on rather than retrying in place — a quota
 * does not refill in the second between two attempts.
 */
const EXHAUSTED_STATUS = new Set([402, 429]);

/**
 * Split "VegBazzar <no-reply@example.com>" into its parts.
 *
 * Providers disagree about the shape of a sender — some take the whole string,
 * others require name and address separately — so it is parsed once here rather
 * than configured twice.
 */
function parseSender(from) {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(String(from ?? ''));
  if (match) return { name: match[1] || undefined, email: match[2] };
  return { name: undefined, email: String(from ?? '').trim() };
}

/**
 * How to talk to each provider.
 *
 * `free` records the published free allowance at the time of writing. It is
 * documentation, not a limit this code enforces — the chain reacts to a real
 * quota response, never to a counter it keeps itself, because a counter would
 * drift from the provider's own accounting the moment anything restarts.
 */
const PROVIDERS = Object.freeze({
  brevo: {
    label: 'Brevo',
    free: '300/day',
    endpoint: 'https://api.brevo.com/v3/smtp/email',
    headers: (key) => ({ 'api-key': key }),
    body: ({ sender, to, subject, text }) => ({
      sender: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  },

  sendgrid: {
    label: 'SendGrid',
    free: '100/day',
    endpoint: 'https://api.sendgrid.com/v3/mail/send',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ sender, to, subject, text }) => ({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  },

  mailersend: {
    label: 'MailerSend',
    free: '3000/month',
    endpoint: 'https://api.mailersend.com/v1/email',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ sender, to, subject, text }) => ({
      from: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) },
      to: [{ email: to }],
      subject,
      text,
    }),
  },

  mailtrap: {
    label: 'Mailtrap',
    free: '1000/month',
    endpoint: 'https://send.api.mailtrap.io/api/send',
    headers: (key) => ({ 'Api-Token': key }),
    body: ({ sender, to, subject, text }) => ({
      from: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) },
      to: [{ email: to }],
      subject,
      text,
    }),
  },

  plunk: {
    label: 'Plunk',
    free: '1000/month',
    endpoint: 'https://api.useplunk.com/v1/send',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ sender, to, subject, text }) => ({
      to,
      subject,
      body: text,
      // Plunk sends HTML by default; a verification code has no markup and
      // should not acquire any.
      type: 'text',
      ...(sender.name ? { name: sender.name } : {}),
      from: sender.email,
    }),
  },

  resend: {
    label: 'Resend',
    free: '3000/month',
    endpoint: 'https://api.resend.com/emails',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ from, to, subject, text }) => ({ from, to: [to], subject, text }),
  },
});

const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

/** j***@example.com — enough to correlate a log line, not enough to enumerate. */
function maskEmail(value) {
  const raw = String(value ?? '');
  const at = raw.indexOf('@');
  if (at <= 0) return '***';
  return `${raw.slice(0, 1)}${'*'.repeat(Math.max(1, at - 1))}${raw.slice(at)}`;
}

/** A short, code-free description of a failure, for logs only. */
function describeFailure(status, body) {
  const detail =
    body?.message ||
    body?.error?.message ||
    body?.errors?.[0]?.message ||
    (Array.isArray(body?.message) ? body.message[0] : null) ||
    null;

  return [`status=${status}`, detail ? `detail=${String(detail).slice(0, 200)}` : null]
    .filter(Boolean)
    .join(' ');
}

/**
 * Raised when a provider reports it is out of quota or rate limited, so the
 * chain can move on instead of treating it as a dead end.
 */
class ProviderExhaustedError extends Error {
  constructor(provider, detail) {
    super(`${provider} is out of quota: ${detail}`);
    this.name = 'ProviderExhaustedError';
    this.provider = provider;
  }
}

/**
 * @param {object} options
 * @param {keyof PROVIDERS} options.provider
 * @param {typeof fetch} [options.fetchImpl] injection seam for tests
 * @returns {{ name: string, provider: string, send: (msg: object) => Promise<void> }}
 */
function createHttpEmailTransport({ provider, apiKey, from, timeoutMs = 10000, fetchImpl = null }) {
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw new Error(`Unknown email provider "${provider}". Known: ${PROVIDER_NAMES.join(', ')}.`);
  }

  const doFetch = fetchImpl || globalThis.fetch;
  const sender = parseSender(from);

  async function post(payload) {
    // An explicit abort rather than a default: a hung request would otherwise
    // hold a sign-in open until the platform's own timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(spec.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...spec.headers(apiKey) },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let body = null;
      try {
        body = await response.json();
      } catch {
        /* Several of these answer 202 with an empty body; that is a success. */
      }

      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: `email:${provider}`,
    provider,

    async send({ to, subject, text }) {
      const payload = spec.body({ sender, from, to, subject, text });
      let last = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await post(payload);
          if (result.ok) return;
          last = result;

          if (EXHAUSTED_STATUS.has(result.status)) break;
          if (attempt === 1 || !RETRYABLE_STATUS.has(result.status)) break;
        } catch (err) {
          last = {
            status: 0,
            body: { message: err?.name === 'AbortError' ? 'timed out' : err?.message },
          };
          if (attempt === 1) break;
        }
      }

      const detail = describeFailure(last?.status ?? 0, last?.body);
      // `text` holds the code, so it is never included here.
      console.error(`[notify] ${spec.label} delivery failed`, { to: maskEmail(to), detail });

      if (EXHAUSTED_STATUS.has(last?.status)) {
        throw new ProviderExhaustedError(provider, detail);
      }

      throw new ApiError(
        503,
        'Could not deliver the verification code. Please try again shortly.',
        'OTP_DELIVERY_FAILED'
      );
    },
  };
}

module.exports = {
  createHttpEmailTransport,
  ProviderExhaustedError,
  PROVIDERS,
  PROVIDER_NAMES,
  parseSender,
  maskEmail,
};
