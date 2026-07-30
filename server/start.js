'use strict';

/**
 * Single-command entry point for platforms that run one process per service
 * (Railway, and similar container hosts).
 *
 * The API and the WhatsApp bot run as two child processes inside this one
 * container — not because that's simpler, but because it's required: the
 * bot's bridge (server/bot/bridge.mjs) binds to 127.0.0.1 only, since it can
 * send WhatsApp messages as you and must never be reachable off-box. Loopback
 * only works when both processes share a network namespace, so splitting them
 * into two separate Railway services would silently break the bridge.
 *
 * The bot is started only when NOTIFY_TRANSPORT=whatsapp_bot is actually
 * configured. Starting it unconditionally would mean an unpaired bot
 * crash-looping (or waiting forever) on every deploy that isn't using it yet.
 *
 * If either running child exits, this process exits too, so the platform's
 * own restart policy brings the whole service back up together rather than
 * leaving the API running with a dead bot (or vice versa).
 */

const { spawn } = require('child_process');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const children = [];
let shuttingDown = false;

function start(name, args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: repoRoot });
  children.push(child);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[start] ${name} exited (code=${code}, signal=${signal}); shutting down.`);
    shutdown(code ?? 1);
  });

  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

start('api', ['server/index.js']);

if (process.env.NOTIFY_TRANSPORT === 'whatsapp_bot') {
  start('bot', ['server/bot/run.mjs']);
} else {
  console.info('[start] NOTIFY_TRANSPORT is not whatsapp_bot; bot process not started.');
}
