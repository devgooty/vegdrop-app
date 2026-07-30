/**
 * Localhost bridge between the API and the bot.
 *
 * The API is CommonJS and baileys is ESM-only, and the bot needs a single
 * long-lived process with exclusive access to its on-disk session. Rather than
 * contorting either side, the bot exposes a tiny HTTP surface that the API's
 * transport calls.
 *
 * SECURITY — this endpoint sends WhatsApp messages as you.
 *
 *  - It binds to 127.0.0.1 only. Never put this on 0.0.0.0 or behind a public
 *    reverse proxy: an open /send is an open relay for your own WhatsApp account.
 *  - A shared bearer token is still required, compared in constant time, because
 *    "localhost only" is not a boundary on a shared host or in a container with
 *    other processes.
 *  - Codes are never logged here. Destination numbers are masked.
 */

import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY_BYTES = 8 * 1024;

function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function tokenMatches(presented, expected) {
  const a = Buffer.from(String(presented ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Body is not valid JSON.'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * @param {object} deps
 * @param {object} deps.socket              from startSocket()
 * @param {object} deps.throttle            from createThrottle()
 * @param {string} deps.token               shared secret
 * @param {string} deps.countryCode
 * @param {number} deps.port
 * @param {string} [deps.host]
 */
export function startBridge({ socket, throttle, token, countryCode, port, host = '127.0.0.1' }) {
  if (!token || token.length < 16) {
    throw new Error('WHATSAPP_BOT_BRIDGE_TOKEN must be set and at least 16 characters.');
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    // Health is unauthenticated so a supervisor can poll it, and reveals only
    // whether the socket is up.
    if (req.method === 'GET' && req.url === '/health') {
      const connected = socket.isConnected();
      return send(connected ? 200 : 503, { status: connected ? 'ok' : 'disconnected', ...throttle.stats() });
    }

    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer\s+/i, ''), token)) {
      return send(401, { error: 'Unauthorized.' });
    }

    if (req.method !== 'POST' || req.url !== '/send') {
      return send(404, { error: 'Not found.' });
    }

    if (!socket.isConnected()) {
      // 503 so the caller can distinguish "not paired / reconnecting" from a
      // permanent failure and retry.
      return send(503, { error: 'WhatsApp socket is not connected.' });
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(400, { error: err.message });
    }

    const { to, text } = body;
    if (typeof to !== 'string' || typeof text !== 'string' || !text.trim()) {
      return send(400, { error: 'Both `to` and a non-empty `text` are required.' });
    }

    const digits = to.replace(/\D/g, '');
    const international = digits.length === 10 ? `${countryCode}${digits}` : digits;

    if (international.length < 11 || international.length > 15) {
      return send(400, { error: 'Unusable destination number.' });
    }

    try {
      const messageId = await throttle.submit(international, async () => {
        const jid = await socket.resolveJid(international);
        if (!jid) {
          const err = new Error('NOT_ON_WHATSAPP');
          err.notOnWhatsapp = true;
          throw err;
        }
        return socket.sendText(jid, text);
      });

      console.info('[bridge] sent', { to: maskPhone(international), messageId });
      return send(200, { messageId });
    } catch (err) {
      if (err?.notOnWhatsapp) {
        console.warn('[bridge] destination is not a WhatsApp user', { to: maskPhone(international) });
        return send(422, { error: 'Destination is not reachable on WhatsApp.' });
      }
      console.error('[bridge] send failed', { to: maskPhone(international), message: err?.message });
      return send(502, { error: 'Send failed.' });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.info(`[bridge] listening on http://${host}:${port} (loopback only)`);
      resolve(server);
    });
  });
}
