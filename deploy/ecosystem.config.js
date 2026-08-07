/**
 * PM2 process list for the VM. Keeps the API alive, restarts it on crash, and
 * survives a reboot once `pm2 save` + `pm2 startup` are run (see
 * deploy/README.md).
 *
 * One process. A second entry here used to run an unofficial WhatsApp client
 * for OTP delivery; it was removed, along with the reason it needed isolating.
 * Codes now go out over the official Cloud API, which is an outbound HTTPS call
 * from the API process with no socket and no on-disk session to own.
 *
 * Usage:
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save
 *   pm2 logs
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
  ],
};
