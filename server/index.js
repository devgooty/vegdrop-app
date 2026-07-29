'use strict';

const config = require('./config/env');
const { connect, disconnect, ensureIndexes } = require('./db/connect');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./utils/seed');
const fulfilment = require('./services/fulfilment');

/**
 * Process bootstrap: connect, seed (development only), listen, and shut down
 * cleanly so in-flight requests are allowed to finish.
 */
async function main() {
  const app = createApp();

  try {
    await connect();
    console.info('[db] connected');

    // Before any traffic: $geoNear is a hard error without its 2dsphere index.
    const { total, failed } = await ensureIndexes();
    console.info(`[db] indexes ready (${total - failed}/${total} models)`);

    await seedIfEmpty();

    /**
     * Auto-rejects stall slices whose response deadline has passed. Without it an
     * unattended stall would hold the customer's funds and the reserved stock
     * indefinitely.
     */
    fulfilment.startSweeper();
    console.info(`[fulfilment] acceptance window ${fulfilment.ACCEPTANCE_WINDOW_SECONDS}s, sweeper running`);
  } catch (err) {
    // The API answers /api/health and returns 503 elsewhere rather than dying,
    // so an orchestrator can observe the unhealthy state and retry.
    console.error('[db] connection failed:', err.message);
    if (config.isProduction) {
      console.error('[db] refusing to serve traffic without a database in production.');
      process.exit(1);
    }
  }

  const server = app.listen(config.port, () => {
    console.info(`[http] VegBazzar API listening on port ${config.port} (${config.NODE_ENV})`);
  });

  // Slowloris mitigation: cap how long a client may hold a connection open
  // while sending headers.
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[http] ${signal} received, draining connections…`);

    const force = setTimeout(() => {
      console.error('[http] forced exit after drain timeout');
      process.exit(1);
    }, 10000);
    force.unref();

    server.close(async () => {
      fulfilment.stopSweeper();
      await disconnect().catch(() => {});
      clearTimeout(force);
      console.info('[http] shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejection that reaches here means state is unknown; fail loudly rather
  // than continuing to serve requests from a process in an undefined state.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection:', reason);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception:', err);
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});
