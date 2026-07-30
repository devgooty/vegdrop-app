/**
 * Baileys socket lifecycle.
 *
 * Baileys does not use WhatsApp's Business API — it speaks the WhatsApp Web
 * protocol and registers as a *linked device* on a real account. Consequences
 * that drive the design here:
 *
 *  - Pairing is a QR scan from the phone. It cannot be automated; a human does it
 *    once, and the resulting credentials are written to disk.
 *  - Those credentials ARE the account session. Treat the auth directory like a
 *    password: it is gitignored, and anyone who copies it can send as you.
 *  - The socket drops constantly (network, WhatsApp-side restarts). Reconnect is
 *    normal operation, not an error path — but a `loggedOut` disconnect means the
 *    session is dead and retrying just burns attempts.
 *  - This is against WhatsApp's Terms of Service and the number can be banned.
 */

// Named imports, not a default namespace: baileys' default export is
// makeWASocket itself, so destructuring the helpers off it yields undefined.
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from 'baileys';
import qrcode from 'qrcode-terminal';

/** Reconnect backoff, capped. Reconnecting in a tight loop looks like abuse. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];

/**
 * @param {object} options
 * @param {string} options.authDir           directory for credentials
 * @param {(msg: object) => Promise<void>} [options.onMessage] inbound handler
 * @param {boolean} [options.verbose]
 */
export async function startSocket({ authDir, onMessage, verbose = false }) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  let sock = null;
  let connected = false;
  let attempt = 0;
  let stopping = false;
  /** @type {Promise<void>|null} */
  let readyPromise = null;
  let markReady = () => {};

  const logger = {
    level: verbose ? 'debug' : 'silent',
    // Baileys expects a pino-like logger; a minimal shim keeps stdout usable.
    child: () => logger,
    trace: () => {},
    debug: (...a) => verbose && console.debug('[bot:debug]', ...a),
    info: (...a) => verbose && console.info('[bot:info]', ...a),
    warn: (...a) => console.warn('[bot:warn]', ...a),
    error: (...a) => console.error('[bot:error]', ...a),
    fatal: (...a) => console.error('[bot:fatal]', ...a),
  };

  function connect() {
    readyPromise = new Promise((resolve) => {
      markReady = resolve;
    });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // Caching the signal key store cuts a lot of disk churn per message.
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      // Identifies the linked device in the phone's "Linked devices" list.
      browser: Browsers.appropriate('VegBazzar Bot'),
      // We are not a chat client: skipping presence and history sync keeps the
      // socket quiet and avoids appearing "online" around the clock.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.info(
          '\n──────── Pair this bot ────────\n' +
            'On the phone that owns the number:\n' +
            '  WhatsApp → Settings → Linked devices → Link a device\n' +
            'then scan:\n'
        );
        qrcode.generate(qr, { small: true });
        console.info('This QR expires in about 20 seconds; a fresh one is printed automatically.\n');
      }

      if (connection === 'open') {
        connected = true;
        attempt = 0;
        const me = sock.user?.id ?? 'unknown';
        console.info(`[bot] connected as ${me}`);
        markReady();
      }

      if (connection === 'close') {
        connected = false;
        // Baileys raises Boom errors, which carry the code on `output`. Read it
        // directly rather than importing @hapi/boom, which is only a transitive
        // dependency here and could vanish on a baileys upgrade.
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.output?.payload?.statusCode;

        if (stopping) return;

        if (statusCode === DisconnectReason.loggedOut) {
          // Terminal: the device was unlinked, or the number was banned.
          console.error(
            '[bot] session is logged out. The device was unlinked from the phone, or the number was banned.\n' +
              `[bot] delete ${authDir} and pair again to recover.`
          );
          return;
        }

        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        console.warn(`[bot] disconnected (code ${statusCode ?? 'n/a'}); reconnecting in ${delay}ms`);
        setTimeout(connect, delay);
      }
    });

    if (onMessage) {
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // 'notify' is a live incoming message; 'append' is history backfill.
        if (type !== 'notify') return;

        for (const message of messages) {
          if (message.key?.fromMe) continue;
          try {
            await onMessage(message, sock);
          } catch (err) {
            console.error('[bot] inbound handler failed', { message: err?.message });
          }
        }
      });
    }
  }

  connect();

  return {
    isConnected: () => connected,

    /** Resolve once the socket is open, so the bridge can wait before serving. */
    whenReady: () => readyPromise ?? Promise.resolve(),

    /**
     * Confirm a number is reachable on WhatsApp and return its JID.
     * Sending to a non-existent JID is silently dropped, so check first.
     * @param {string} internationalDigits e.g. "919876543210"
     * @returns {Promise<string|null>}
     */
    async resolveJid(internationalDigits) {
      if (!connected) throw new Error('Socket is not connected.');
      const results = await sock.onWhatsApp(internationalDigits);
      const hit = Array.isArray(results) ? results.find((r) => r?.exists) : null;
      return hit?.jid ?? null;
    },

    /** @param {string} jid @param {string} text */
    async sendText(jid, text) {
      if (!connected) throw new Error('Socket is not connected.');
      const result = await sock.sendMessage(jid, { text });
      return result?.key?.id ?? null;
    },

    async stop() {
      stopping = true;
      try {
        // Do NOT call sock.logout(): that unlinks the device and forces a re-pair.
        sock?.end?.(undefined);
      } catch {
        /* already gone */
      }
    },
  };
}
