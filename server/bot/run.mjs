/**
 * WhatsApp bot entry point.  Run with:  npm run bot
 *
 * This is a SEPARATE PROCESS from the API, on purpose:
 *
 *  - baileys is ESM-only; server/ is CommonJS.
 *  - It owns a long-lived socket and an on-disk session that exactly one process
 *    may hold. It cannot be scaled horizontally alongside the API, and it cannot
 *    run on serverless or any platform with an ephemeral filesystem.
 *  - If it crashes or gets banned, the API keeps serving.
 *
 * ⚠️  This uses the WhatsApp Web protocol, not the Business API. It violates
 *     WhatsApp's Terms of Service and the number can be banned without warning.
 *     Use a number you are willing to lose. See ./README.md.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CommonJS modules import cleanly into ESM as default exports, so the bot reuses
// the API's validated config and models rather than duplicating either.
import configModule from '../config/env.js';
import mongooseModule from 'mongoose';

import { startSocket } from './socket.mjs';
import { startBridge } from './bridge.mjs';
import { createThrottle } from './throttle.mjs';
import { createMessageHandler } from './handlers.mjs';

const config = configModule.default ?? configModule;
const mongoose = mongooseModule.default ?? mongooseModule;

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const bot = config.whatsappBot;

  if (!bot.bridgeToken) {
    console.error(
      '[bot] WHATSAPP_BOT_BRIDGE_TOKEN is not set.\n' +
      '[bot] Generate one with:\n' +
      '      node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'
    );
    process.exit(1);
  }

  const authDir = path.isAbsolute(bot.authDir) ? bot.authDir : path.join(here, bot.authDir);

  console.warn(
    '\n⚠️  Unofficial WhatsApp client (WhatsApp Web protocol, not the Business API).\n' +
    '   This is against WhatsApp\'s Terms of Service; the number may be banned.\n' +
    `   Session directory: ${authDir}\n` +
    '   Treat that directory as a credential — anyone with a copy can send as you.\n'
  );

  // Order lookup needs the database. Read-only in practice, but it uses the same
  // connection settings as the API.
  let dbReady = false;
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 });
    dbReady = true;
    console.info('[bot] database connected');
  } catch (err) {
    // The bot is still useful for sending without it; only order lookup degrades.
    console.warn(`[bot] database unavailable (${err.message}); order lookup will be disabled.`);
  }

  const throttle = createThrottle({
    minIntervalMs: bot.minIntervalMs,
    jitterMs: bot.jitterMs,
    dailyCap: bot.dailyCap,
    perRecipientCooldownMs: bot.perRecipientCooldownMs,
  });

  /**
   * Recent orders for a phone number, scoped to that number only.
   * Lean + projected: nothing sensitive leaves the database.
   */
  async function findOrdersByPhone(localPhone) {
    if (!dbReady) throw new Error('database unavailable');
    const { default: Order } = await import('../models/Order.js');
    return Order.find({ phone: localPhone })
      .sort({ createdAt: -1 })
      .limit(3)
      .select('orderNumber status totalAmountPaise')
      .lean();
  }

  let socket;

  const handleMessage = createMessageHandler({
    findOrdersByPhone,
    countryCode: bot.countryCode,
    // Inbound replies go through the same throttle as everything else.
    reply: (jid, text) => throttle.submit(jid, () => socket.sendText(jid, text)),
  });

  socket = await startSocket({
    authDir,
    onMessage: handleMessage,
    verbose: bot.verbose,
  });

  const server = await startBridge({
    socket,
    throttle,
    token: bot.bridgeToken,
    countryCode: bot.countryCode,
    port: bot.bridgePort,
    host: bot.bridgeHost,
  });

  console.info('[bot] waiting for the WhatsApp socket to come up…');
  await socket.whenReady();
  console.info('[bot] ready.');

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[bot] ${signal} received, shutting down…`);

    server.close();
    await socket.stop();
    if (dbReady) await mongoose.disconnect().catch(() => {});
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[bot] failed to start:', err);
  process.exit(1);
});
