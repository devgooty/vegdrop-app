'use strict';

const config = require('../config/env');
const SmsGatewayHealth = require('../models/SmsGatewayHealth');

const HEALTH_ID = 'sms';

async function recordHeartbeat() {
  const now = new Date();
  await SmsGatewayHealth.findOneAndUpdate(
    { _id: HEALTH_ID },
    { $set: { lastSeenAt: now } },
    { upsert: true, returnDocument: 'after' }
  );
  return { lastSeenAt: now };
}

/**
 * @returns {Promise<{ seen: boolean, healthy: boolean | null, lastSeenAt: Date | null }>}
 *   `healthy: null` means no heartbeat has ever been recorded (fresh deploy /
 *   operator has not pointed the forwarder at us yet) — do not treat as down.
 */
async function getRelayHealth() {
  const staleMs = (config.reverseOtp.sms.staleSeconds || 300) * 1000;
  const row = await SmsGatewayHealth.findById(HEALTH_ID).lean();
  if (!row?.lastSeenAt) {
    return { seen: false, healthy: null, lastSeenAt: null };
  }
  const lastSeenAt = new Date(row.lastSeenAt);
  const healthy = Date.now() - lastSeenAt.getTime() <= staleMs;
  return { seen: true, healthy, lastSeenAt };
}

module.exports = {
  recordHeartbeat,
  getRelayHealth,
};
