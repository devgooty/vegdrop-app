'use strict';

const config = require('./config/env');
const { connect, disconnect, ensureIndexes } = require('./db/connect');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./utils/seed');
const sweeper = require('./services/sweeper');

/**
 * Process bootstrap: connect, seed (development only), listen, and shut down
 * cleanly so in-flight requests are allowed to finish.
 */
async function main() {
  const app = createApp();

  try {
    await connect();
    console.info('[db] connected');
    // Before seeding: the seed writes documents whose uniqueness constraints
    // only exist once the indexes do.
    await ensureIndexes();
    await seedIfEmpty();
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
    console.info(`[http] VegDrop API listening on port ${config.port} (${config.NODE_ENV})`);
  });

  // Slowloris mitigation: cap how long a client may hold a connection open
  // while sending headers.
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;

  /**
   * The clock behind market sourcing: closes expired offer windows and chases
   * unanswered rider offers. Started after the server is listening so a slow
   * first tick cannot delay accepting traffic. Safe to run on every instance —
   * see the note in services/sweeper.js.
   */
  sweeper.start();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[http] ${signal} received, draining connections…`);

    // Stop before draining: a tick that starts mid-shutdown would issue writes
    // against a connection that is about to close.
    sweeper.stop();

    const force = setTimeout(() => {
      console.error('[http] forced exit after drain timeout');
      process.exit(1);
    }, 10000);
    force.unref();

    server.close(async () => {
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
