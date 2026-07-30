'use strict';

/**
 * Transport that delivers through the unofficial WhatsApp bot (server/bot).
 *
 * Unlike the Cloud API transport, this sends plain text — the WhatsApp Web
 * protocol has no template concept, which is exactly why it is both easier and
 * against WhatsApp's Terms of Service.
 *
 * The bot is a separate process, so this is an HTTP call to its loopback bridge.
 * A failure here means the bot is down, unpaired, reconnecting, or banned.
 *
 * Same discipline as the Cloud API transport: the code is never logged, the
 * destination is masked, and every failure becomes one generic client-facing
 * error so that "not a WhatsApp user" is not an enumeration oracle.
 */

const { ApiError } = require('../../middleware/errors');

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function createWhatsappBridgeTransport({
  bridgeUrl,
  bridgeToken,
  timeoutMs = 30000,
  maxAttempts = 2,
  fetchImpl = globalThis.fetch,
}) {
  if (!bridgeUrl || !bridgeToken) {
    throw new Error('createWhatsappBridgeTransport requires bridgeUrl and bridgeToken.');
  }

  const endpoint = `${bridgeUrl.replace(/\/$/, '')}/send`;

  return {
    name: 'whatsapp_bot',

    async send(message) {
      const { channel, to, text, otp } = message || {};

      if (channel === 'email') {
        throw new Error('The WhatsApp bot transport cannot deliver email. Configure an email transport.');
      }
      if (!text) {
        throw new Error('The WhatsApp bot transport requires composed `text`.');
      }
      // `otp` is unused: unlike the Cloud API this sends free-form text, so the
      // already-composed message is exactly what should go out. Referenced here
      // only to document that the omission is deliberate.
      void otp;

      const genericFailure = () =>
        new ApiError(
          503,
          'Could not send your verification code right now. Please try again in a moment.',
          'OTP_DELIVERY_FAILED'
        );

      for (let n = 1; n <= maxAttempts; n += 1) {
        let response;
        let body = null;

        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${bridgeToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ to, text }),
            // Generous: the bot paces sends deliberately to avoid a ban, so a
            // queued message can legitimately wait seconds before going out.
            signal: AbortSignal.timeout(timeoutMs),
          });

          try {
            body = await response.json();
          } catch {
            body = null;
          }
        } catch (err) {
          const detail = `${err?.name || 'Error'}: ${err?.message || 'request failed'}`;
          if (n < maxAttempts) continue;
          console.error('[whatsapp-bot] bridge unreachable', {
            to: maskPhone(to),
            endpoint,
            attempt: n,
            detail,
            hint: 'Is `npm run bot` running and paired?',
          });
          throw genericFailure();
        }

        if (response.ok) {
          console.info('[whatsapp-bot] code dispatched', {
            to: maskPhone(to),
            messageId: body?.messageId ?? null,
            attempt: n,
          });
          return;
        }

        if (RETRYABLE_STATUS.has(response.status) && n < maxAttempts) continue;

        console.error('[whatsapp-bot] send rejected', {
          to: maskPhone(to),
          attempt: n,
          status: response.status,
          detail: body?.error ?? null,
        });
        throw genericFailure();
      }

      throw genericFailure();
    },
  };
}

module.exports = { createWhatsappBridgeTransport, maskPhone };
