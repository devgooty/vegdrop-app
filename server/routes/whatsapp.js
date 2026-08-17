'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config/env');
const { isConnected } = require('../db/connect');
const reverseOtp = require('../services/reverseOtp');

const router = express.Router();

/**
 * WhatsApp Cloud API webhook.
 *
 * WHY THIS EXISTS
 *
 * POST /messages returns 200 as soon as Meta *accepts* a message, which is well
 * before it is delivered. Without this endpoint an OTP that never reaches the
 * user is indistinguishable from one that did: the send looked fine, the user
 * says no code arrived, and there is nothing to inspect. Delivery status arrives
 * only here.
 *
 * SECURITY
 *
 * This is a public, unauthenticated endpoint — Meta calls it, so it cannot carry
 * one of our tokens. The only thing establishing that a request is genuine is the
 * X-Hub-Signature-256 HMAC over the raw body, keyed by the app secret. Without
 * that check, anyone who found this URL could inject arbitrary "delivery
 * failures" into our logs. Unverified requests are rejected before the body is
 * looked at.
 *
 * SCOPE
 *
 * Read-only observation: statuses are logged, nothing is persisted and nothing is
 * sent in reply. Auto-replying to an inbound message would need either an
 * approved template or an open 24-hour service window, which is a different
 * feature from delivering codes.
 */

/** Statuses that mean the code did not get there. */
const FAILURE_STATUSES = new Set(['failed', 'undelivered']);

/** ******3210 — correlates a log line without being an enumeration source. */
function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/**
 * Constant-time comparison of the delivered signature against one computed over
 * the raw bytes. `req.rawBody` is captured for this path only — see the express
 * .json() verify hook in app.js. Re-serialising the parsed body would not work:
 * the HMAC covers the exact bytes Meta sent, and JSON.stringify does not
 * round-trip key order or number formatting.
 */
function signatureIsValid(req) {
  const header = req.get('x-hub-signature-256');
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) return false;

  const expected = crypto
    .createHmac('sha256', config.whatsapp.appSecret)
    .update(req.rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(header.slice('sha256='.length), 'utf8');

  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Subscription handshake. Meta calls this once when the webhook URL is saved and
 * expects the `hub.challenge` value echoed back as plain text.
 */
router.get('/webhook', (req, res) => {
  const { webhookVerifyToken } = config.whatsapp;

  if (!webhookVerifyToken) {
    console.warn('[whatsapp] webhook verification attempted but WHATSAPP_WEBHOOK_VERIFY_TOKEN is unset.');
    return res.status(503).json({
      error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook is not configured.' },
    });
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const tokenBuf = Buffer.from(String(token ?? ''), 'utf8');
  const expectedBuf = Buffer.from(webhookVerifyToken, 'utf8');
  const tokenMatches =
    tokenBuf.length === expectedBuf.length && crypto.timingSafeEqual(tokenBuf, expectedBuf);

  if (mode !== 'subscribe' || !tokenMatches) {
    console.warn('[whatsapp] webhook verification rejected', { mode, tokenMatches });
    return res.sendStatus(403);
  }

  console.info('[whatsapp] webhook verified.');
  // Plain text, not JSON: Meta compares the body to the challenge verbatim.
  return res.status(200).type('text/plain').send(String(challenge ?? ''));
});

router.post('/webhook', (req, res) => {
  if (!config.whatsapp.appSecret) {
    console.warn('[whatsapp] webhook POST received but WHATSAPP_APP_SECRET is unset; refusing to trust it.');
    return res.sendStatus(503);
  }

  if (!signatureIsValid(req)) {
    // 403 is what Meta expects for a signature mismatch; it does not retry.
    console.warn('[whatsapp] webhook POST rejected: signature mismatch.');
    return res.sendStatus(403);
  }

  /**
   * Acknowledge immediately, then process.
   *
   * Meta retries any non-2xx with backoff and will disable a webhook that keeps
   * failing. Nothing below can fail in a way a retry would fix, so there is no
   * reason to make Meta wait on it.
   */
  res.sendStatus(200);

  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];

      for (const change of changes) {
        const value = change?.value || {};

        for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
          const line = {
            messageId: status?.id ?? null,
            to: maskPhone(status?.recipient_id),
            status: status?.status ?? 'unknown',
          };

          if (FAILURE_STATUSES.has(status?.status)) {
            const firstError = Array.isArray(status?.errors) ? status.errors[0] : null;
            // The actionable one: a code was accepted but never arrived.
            console.error('[whatsapp] delivery failed', {
              ...line,
              errorCode: firstError?.code ?? null,
              errorTitle: firstError?.title ?? null,
              errorDetail: firstError?.error_data?.details ?? firstError?.message ?? null,
            });
          } else {
            console.info('[whatsapp] delivery status', line);
          }
        }

        /**
         * Inbound messages.
         *
         * These are how reverse OTP works: the user messages US the code we
         * showed them, and Meta's signature above is what makes the sender it
         * reports trustworthy enough to verify a number against.
         *
         * STILL NEVER ANSWERED. Two reasons now. A user replying to a code is
         * usually a support question and this integration has no template
         * approved for anything but the code itself — and a reply inside the
         * 24-hour service window can be billable, which would turn a flow whose
         * whole point is costing nothing into a paid one.
         *
         * The message body is never logged. It is user content, and during a
         * verification it contains a live code.
         */
        for (const inbound of Array.isArray(value.messages) ? value.messages : []) {
          // Only text can carry a code; images, audio and reactions cannot.
          if (inbound?.type !== 'text') {
            console.info('[whatsapp] inbound message ignored', {
              from: maskPhone(inbound?.from),
              type: inbound?.type ?? 'unknown',
            });
            continue;
          }

          /**
           * This route is mounted ABOVE the database gate on purpose (see
           * app.js) so Meta never receives a 503 and never disables the
           * subscription. Matching needs the database, so it is skipped rather
           * than attempted when Mongo is down — the webhook still answers 200
           * and the property that put it up there survives.
           */
          if (!isConnected()) {
            console.warn('[whatsapp] inbound text skipped: database unavailable.');
            continue;
          }

          /**
           * Fire and forget. The 200 went out above, so a rejection here has
           * nowhere to go — it must not reach the error handler, and Meta must
           * not be made to wait on a database write it cannot act on.
           */
          reverseOtp
            .matchInbound({
              from: inbound.from,
              // Cloud API shape for a text message: `{ text: { body } }`.
              text: inbound.text?.body ?? '',
              channel: 'whatsapp',
            })
            .catch((err) => {
              console.error('[whatsapp] reverse otp matching failed', { message: err?.message });
            });
        }
      }
    }
  } catch (err) {
    // The response is already sent; never let this reach the error handler.
    console.error('[whatsapp] failed to process webhook payload', { message: err?.message });
  }
});

module.exports = router;
