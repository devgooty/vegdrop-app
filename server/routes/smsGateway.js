'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config/env');
const { validate, z, fields } = require('../middleware/validate');
const { smsGatewayLimiter } = require('../middleware/rateLimit');
const reverseOtp = require('../services/reverseOtp');
const smsGatewayHealth = require('../services/smsGatewayHealth');

const router = express.Router();

/**
 * Inbound SMS relay.
 *
 * WhatsApp can hand us inbound messages because Meta runs a webhook. SMS has no
 * such thing for an ordinary number: the messages land on a SIM. So this is the
 * endpoint an Android app holding that SIM posts to when it receives one.
 *
 * THAT APP IS NOT IN THIS REPOSITORY. This is the contract it posts to, and
 * nothing here assumes anything about it beyond the shared secret.
 *
 * ASSURANCE
 *
 * This channel is weaker than the WhatsApp one and the difference is real. A
 * Meta webhook is HMAC-signed over the exact bytes and the sender is Meta's own
 * record. Here, the sender is whatever a handset read out of an SMS header on a
 * network where sender IDs can be forged, relayed by a device we are trusting to
 * be honest. The secret proves the RELAY is ours; it proves nothing about the
 * sender it reports. Clients are told as much — `assurance: 'low'` on the
 * channel — rather than being left to assume the two are equivalent.
 */

function secretIsValid(req) {
  const configured = config.reverseOtp.sms.gatewaySecret;
  if (!configured) return false;

  const header = req.get('x-gateway-secret');
  if (typeof header !== 'string' || header.length === 0) return false;

  const expected = Buffer.from(configured, 'utf8');
  const actual = Buffer.from(header, 'utf8');

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function refuseUnlessConfigured(res) {
  if (config.reverseOtp.sms.configured) return false;
  res.status(503).json({
    error: { code: 'GATEWAY_NOT_CONFIGURED', message: 'SMS gateway is not configured.' },
  });
  return true;
}

function refuseUnlessSecret(req, res) {
  if (secretIsValid(req)) return false;
  console.warn('[sms-gateway] rejected: bad or missing shared secret.');
  res.sendStatus(403);
  return true;
}

/**
 * Dead-man's switch for the forwarder.
 *
 * Point the Android app's periodic heartbeat here. /auth/reverse/start then
 * knows whether SMS is likely to arrive, instead of leaving the user on
 * "Waiting for your message…" while the phone has been force-stopped for hours.
 */
router.post('/heartbeat', smsGatewayLimiter, async (req, res) => {
  if (refuseUnlessConfigured(res)) return;
  if (refuseUnlessSecret(req, res)) return;

  const beat = await smsGatewayHealth.recordHeartbeat();
  return res.status(204).end();
  // beat kept for clarity if we later return lastSeenAt; 204 has no body.
  void beat;
});

router.post(
  '/reverse-otp-sms',
  smsGatewayLimiter,
  validate({
    body: z
      .object({
        from: fields.nonEmptyString(32),
        text: fields.nonEmptyString(1600),
      })
      .strict(),
  }),
  async (req, res) => {
    if (refuseUnlessConfigured(res)) return;
    if (refuseUnlessSecret(req, res)) return;

    const { from, text } = req.valid.body;

    /**
     * Always 204, matched or not.
     *
     * Reporting whether a code matched would turn this into an oracle for
     * anyone who obtained the secret: they could test codes against numbers and
     * read the answer off the status. The relay has no use for the result
     * either — it forwards messages, it does not make decisions.
     *
     * The message text is never logged. It is a user's own message, and it
     * contains a live code.
     */
    try {
      // A successful forward also counts as liveness — some forwarders only
      // POST on inbound SMS and have no separate heartbeat timer.
      await smsGatewayHealth.recordHeartbeat();
      await reverseOtp.matchInbound({ from, text, channel: 'sms' });
    } catch (err) {
      console.error('[sms-gateway] failed to process inbound message', { message: err?.message });
    }

    return res.sendStatus(204);
  }
);

module.exports = router;
