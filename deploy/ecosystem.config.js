/**
 * PM2 process list for the VM. Keeps the API and the WhatsApp bot alive as two
 * separate always-on processes, restarts either on crash, and survives a
 * reboot once `pm2 save` + `pm2 startup` are run (see deploy/README.md).
 *
 * Two processes, not one, on purpose: server/bot/run.mjs is ESM (baileys is
 * ESM-only) while the API is CommonJS, and the bot owns a long-lived socket
 * plus an on-disk session that exactly one process may hold. If the bot
 * crashes or the WhatsApp number gets banned, the API must keep serving —
 * coupling them into one process would take checkout and login down with it.
 *
 * Usage:
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save
 *   pm2 logs             # tail both
 *   pm2 restart all      # after a deploy
 */

module.exports = {
  apps: [
    {
      name: 'vegdrop-api',
      script: 'server/index.js',
      cwd: '/var/www/vegdrop',
      // config/env.js already loads .env via dotenv; PM2's own env_file support
      // varies by version, so the app's existing loader is left as the one
      // source of truth rather than layering a second one on top.
      env: { NODE_ENV: 'production' },
      instances: 1,
      // More than one instance would mean two processes fighting over the same
      // express-rate-limit in-memory store and the same refresh-token cookie
      // path — this app was not built for a cluster, so don't run one.
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: '/var/log/vegdrop/api.out.log',
      error_file: '/var/log/vegdrop/api.err.log',
      time: true,
    },
    {
      name: 'vegdrop-bot',
      script: 'server/bot/run.mjs',
      cwd: '/var/www/vegdrop',
      env: { NODE_ENV: 'production' },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // A crash loop here usually means the WhatsApp session died (logged
      // out / banned) — retrying forever just spams the socket. Ten attempts
      // with backoff, then stop and let the operator look at the logs.
      max_restarts: 10,
      restart_delay: 5000,
      out_file: '/var/log/vegdrop/bot.out.log',
      error_file: '/var/log/vegdrop/bot.err.log',
      time: true,
    },
  ],
};
