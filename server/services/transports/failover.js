'use strict';

/**
 * Try several transports in order until one delivers.
 *
 * WHY THIS EXISTS
 *
 * Sign-in is passwordless, so the transport is a hard dependency: if a code
 * cannot be delivered, nobody can get in at all. That is not hypothetical here —
 * it is exactly what happened when the WhatsApp number was banned and the single
 * channel disappeared. A second provider is the difference between a degraded
 * evening and a closed shop.
 *
 * WHAT IT DOES AND DOES NOT SOLVE
 *
 * This fixes AVAILABILITY: one provider being down, rate limited, or out of
 * quota. It does nothing for DELIVERABILITY — if messages are landing in spam
 * because of the sender address, every provider in the chain will land in spam
 * too. Those are different problems and only a verified sending domain fixes the
 * second one.
 *
 * NO QUOTA COUNTER
 *
 * The chain reacts to what a provider actually says (402/429), never to a tally
 * it keeps itself. A local counter drifts from the provider's own accounting the
 * moment the process restarts or a second instance starts, and then either skips
 * a provider that had room or hammers one that did not.
 */

const { ApiError } = require('../../middleware/errors');
const { ProviderExhaustedError } = require('./httpEmail');

/**
 * @param {object} options
 * @param {Array<{name: string, send: Function}>} options.transports in preference order
 * @returns {{ name: string, send: (msg: object) => Promise<void> }}
 */
function createFailoverTransport({ transports }) {
  const chain = transports.filter(Boolean);

  if (chain.length === 0) {
    throw new Error('createFailoverTransport requires at least one transport.');
  }

  return {
    name: `failover(${chain.map((t) => t.name).join(' -> ')})`,
    transports: chain,

    async send(message) {
      const failures = [];

      for (const transport of chain) {
        try {
          await transport.send(message);

          if (failures.length > 0) {
            // Worth a line: a chain that silently absorbs a dead provider looks
            // identical to one where nothing is wrong, until the last one dies.
            console.warn('[notify] delivered on a fallback provider', {
              delivered: transport.name,
              skipped: failures,
            });
          }
          return;
        } catch (err) {
          failures.push(transport.name);

          const exhausted = err instanceof ProviderExhaustedError;
          console.warn('[notify] provider failed, trying the next', {
            provider: transport.name,
            reason: exhausted ? 'quota' : 'error',
            remaining: chain.length - failures.length,
          });
        }
      }

      console.error('[notify] every email provider failed', { tried: failures });

      // The same generic error any single transport raises: which providers were
      // tried is our operational detail, not the caller's business, and naming
      // them would leak infrastructure into a public response.
      throw new ApiError(
        503,
        'Could not deliver the verification code. Please try again shortly.',
        'OTP_DELIVERY_FAILED'
      );
    },
  };
}

module.exports = { createFailoverTransport };
