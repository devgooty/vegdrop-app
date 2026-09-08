'use strict';

/**
 * Presentational reverse-OTP channel payloads (links + assurance flags).
 *
 * Shared by /auth/reverse/start and the cross-device handover phone poll so the
 * message wording and SMS assurance labels cannot drift apart.
 */

const config = require('../config/env');
const smsGatewayHealth = require('./smsGatewayHealth');

function messageFor(code) {
  return `Verify my number for VegDrop: ${code}`;
}

/**
 * Only configured channels appear. A button that opens a chat with nobody
 * leaves the user waiting forever — worse than omitting the option.
 */
async function channelsForCode(code) {
  const text = messageFor(code);
  const encoded = encodeURIComponent(text);
  const channels = { whatsapp: null, sms: null };

  if (config.reverseOtp.whatsapp.configured) {
    channels.whatsapp = {
      to: config.reverseOtp.whatsapp.inboxNumber,
      // wa.me wants digits only — no +, no spaces, no dashes.
      link: `https://wa.me/${config.reverseOtp.whatsapp.inboxNumber}?text=${encoded}`,
      message: text,
      assurance: 'high',
    };
  }

  if (config.reverseOtp.sms.configured) {
    const to = config.reverseOtp.sms.inboxNumber;
    const relay = await smsGatewayHealth.getRelayHealth();
    channels.sms = {
      to,
      // RFC 5724 `?body=`; older iOS needed `&body=` — client picks one.
      link: `sms:${to}?body=${encoded}`,
      linkLegacy: `sms:${to}&body=${encoded}`,
      message: text,
      // SMS sender IDs can be forged; WhatsApp webhooks are Meta-signed.
      assurance: 'low',
      // null = never heard from the relay (not the same as "down").
      relayHealthy: relay.healthy,
    };
  }

  return channels;
}

module.exports = { messageFor, channelsForCode };
