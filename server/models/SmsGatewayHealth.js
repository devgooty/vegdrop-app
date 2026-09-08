'use strict';

const mongoose = require('mongoose');

/**
 * Last heartbeat from the Android SMS reverse-OTP relay.
 *
 * Without this, a dead forwarder is indistinguishable from a user who never
 * sent a message — the waiting screen spins until the challenge TTL. The relay
 * POSTs here on a timer; /auth/reverse/start reports whether that pulse is fresh.
 */
const smsGatewayHealthSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'sms' },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SmsGatewayHealth', smsGatewayHealthSchema);
