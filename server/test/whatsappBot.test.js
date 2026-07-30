'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Sets NODE_ENV=test and required secrets before config/env.js loads.
require('./helpers');

const { createWhatsappBridgeTransport } = require('../services/transports/whatsappBridge');

/**
 * The bot is ESM (baileys is ESM-only) and this suite is CommonJS, so its pure
 * helpers are pulled in with a dynamic import rather than require().
 */
let handlers;
test.before(async () => {
  handlers = await import('../bot/handlers.mjs');
});

function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];

  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = queue.shift();
    if (!next) throw new Error('stubFetch: no queued response');
    if (next.throws) throw next.throws;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };

  return { impl, calls };
}

function transport(responses = [{ status: 200, body: { messageId: 'BOT1' } }], overrides = {}) {
  const { impl, calls } = stubFetch(responses);
  const t = createWhatsappBridgeTransport({
    bridgeUrl: 'http://127.0.0.1:5055',
    bridgeToken: 'a'.repeat(24),
    fetchImpl: impl,
    ...overrides,
  });
  return { t, calls };
}

const otp = { code: '123456', purpose: 'login', ttlSeconds: 300 };
const text = '123456 is your VegBazzar verification code.';

test('a send posts the composed text to the loopback bridge', async () => {
  const { t, calls } = transport();

  await t.send({ channel: 'sms', to: '9876543210', text, otp });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:5055/send');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${'a'.repeat(24)}`);
  assert.equal(calls[0].body.to, '9876543210');
  assert.equal(calls[0].body.text, text);
});

test('the bridge is required — no token means no transport', () => {
  assert.throws(
    () => createWhatsappBridgeTransport({ bridgeUrl: 'http://127.0.0.1:5055' }),
    /requires bridgeUrl and bridgeToken/
  );
});

test('email is refused rather than dropped', async () => {
  const { t, calls } = transport();
  await assert.rejects(
    () => t.send({ channel: 'email', to: 'a@example.com', text, otp }),
    /cannot deliver email/
  );
  assert.equal(calls.length, 0);
});

test('an unreachable bridge is retried once then reported as a delivery failure', async () => {
  const { t, calls } = transport([
    { throws: Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }) },
    { throws: Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }) },
  ]);

  await assert.rejects(
    () => t.send({ channel: 'sms', to: '9876543210', text, otp }),
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'OTP_DELIVERY_FAILED');
      return true;
    }
  );
  assert.equal(calls.length, 2);
});

test('a disconnected socket (503) is retried and can then succeed', async () => {
  const { t, calls } = transport([
    { status: 503, body: { error: 'WhatsApp socket is not connected.' } },
    { status: 200, body: { messageId: 'BOT2' } },
  ]);

  await t.send({ channel: 'sms', to: '9876543210', text, otp });
  assert.equal(calls.length, 2);
});

test('a recipient not on WhatsApp (422) is not retried', async () => {
  const { t, calls } = transport([
    { status: 422, body: { error: 'Destination is not reachable on WhatsApp.' } },
  ]);

  await assert.rejects(() => t.send({ channel: 'sms', to: '9876543210', text, otp }));
  assert.equal(calls.length, 1, 'a missing WhatsApp account will not appear on retry');
});

test('the failure message never says why delivery failed', async () => {
  const { t } = transport([{ status: 422, body: { error: 'Destination is not reachable on WhatsApp.' } }]);

  await assert.rejects(
    () => t.send({ channel: 'sms', to: '9876543210', text, otp }),
    (err) => {
      assert.match(err.message, /Could not send your verification code/);
      assert.doesNotMatch(err.message, /reachable|WhatsApp/i);
      return true;
    }
  );
});

test('neither the code nor the full number reaches the logs', async () => {
  const written = [];
  const info = console.info;
  const error = console.error;
  console.info = (...a) => written.push(JSON.stringify(a));
  console.error = (...a) => written.push(JSON.stringify(a));

  try {
    await transport().t.send({ channel: 'sms', to: '9876543210', text, otp });
    await transport([{ status: 422, body: { error: 'x' } }])
      .t.send({ channel: 'sms', to: '9876543210', text, otp })
      .catch(() => {});
  } finally {
    console.info = info;
    console.error = error;
  }

  const combined = written.join('\n');
  assert.ok(written.length > 0);
  assert.doesNotMatch(combined, /123456/, 'the code must never be logged');
  assert.doesNotMatch(combined, /9876543210/, 'the full number must not be logged');
  assert.match(combined, /\*+3210/);
});

// ---------------------------------------------------------------------------
// Inbound parsing (pure helpers from the bot's handler)
// ---------------------------------------------------------------------------

test('a sender JID reduces to phone digits', () => {
  assert.equal(handlers.digitsFromJid('919876543210@s.whatsapp.net'), '919876543210');
  // Linked-device JIDs carry a device suffix.
  assert.equal(handlers.digitsFromJid('919876543210:12@s.whatsapp.net'), '919876543210');
});

test('an international sender maps back to the stored 10-digit number', () => {
  assert.equal(handlers.toLocalNumber('919876543210', '91'), '9876543210');
  assert.equal(handlers.toLocalNumber('9876543210', '91'), '9876543210');
  // A foreign number has no local form in this schema.
  assert.equal(handlers.toLocalNumber('14155550123', '91'), null);
});

test('message text is read from every shape WhatsApp uses', () => {
  assert.equal(handlers.textOf({ message: { conversation: ' orders ' } }), 'orders');
  assert.equal(handlers.textOf({ message: { extendedTextMessage: { text: 'help' } } }), 'help');
  assert.equal(handlers.textOf({ message: { imageMessage: { caption: 'hi' } } }), 'hi');
  assert.equal(handlers.textOf({ message: {} }), '');
  assert.equal(handlers.textOf({}), '');
});

// ---------------------------------------------------------------------------
// Inbound routing — the property that matters is scoping
// ---------------------------------------------------------------------------

/** Drive the handler and collect what it would reply. */
function harness({ orders = [], countryCode = '91' } = {}) {
  const replies = [];
  const lookups = [];

  const handle = handlers.createMessageHandler({
    countryCode,
    findOrdersByPhone: async (phone) => {
      lookups.push(phone);
      return orders;
    },
    reply: async (jid, text) => {
      replies.push({ jid, text });
    },
  });

  return { handle, replies, lookups };
}

const from = (text, jid = '919876543210@s.whatsapp.net') => ({
  key: { remoteJid: jid, fromMe: false },
  message: { conversation: text },
});

test('"help" returns the menu without touching the database', async () => {
  const { handle, replies, lookups } = harness();
  await handle(from('help'));

  assert.equal(lookups.length, 0);
  assert.match(replies[0].text, /VegBazzar/);
  assert.match(replies[0].text, /orders/);
});

test('an order lookup is scoped to the sender own number', async () => {
  const { handle, lookups } = harness({
    orders: [{ orderNumber: 'VB1', status: 'Preparing', totalAmountPaise: 12500 }],
  });

  await handle(from('orders'));

  // The lookup key is derived from the WhatsApp-verified sender, never from
  // anything in the message body.
  assert.deepEqual(lookups, ['9876543210']);
});

test('an order number in the message body is never used as a lookup key', async () => {
  const { handle, lookups } = harness({ orders: [] });

  // If this were honoured, anyone could read any order by guessing a number.
  await handle(from('orders VB9999ABC'));

  assert.deepEqual(lookups, ['9876543210'], 'must still query only the sender');
});

test('replies list status and total but never the delivery address', async () => {
  const { handle, replies } = harness({
    orders: [{ orderNumber: 'VB77', status: 'Out for Delivery', totalAmountPaise: 45000 }],
  });

  await handle(from('orders'));

  assert.match(replies[0].text, /VB77/);
  assert.match(replies[0].text, /Out for Delivery/);
  assert.match(replies[0].text, /450\.00/);
});

test('group and broadcast messages are ignored', async () => {
  const { handle, replies, lookups } = harness();

  await handle(from('orders', '1234567890-987654@g.us'));
  await handle(from('orders', 'status@broadcast'));

  assert.equal(replies.length, 0);
  assert.equal(lookups.length, 0);
});

test('a foreign sender that maps to no local account is told so, not queried', async () => {
  const { handle, replies, lookups } = harness();

  await handle(from('orders', '14155550123@s.whatsapp.net'));

  assert.equal(lookups.length, 0);
  assert.match(replies[0].text, /could not match this number/i);
});

test('a lookup failure does not leak the underlying error', async () => {
  const replies = [];
  const handle = handlers.createMessageHandler({
    countryCode: '91',
    findOrdersByPhone: async () => {
      throw new Error('MongoServerError: connection refused at 10.0.0.5:27017');
    },
    reply: async (jid, text) => replies.push({ jid, text }),
  });

  await handle(from('orders'));

  assert.doesNotMatch(replies[0].text, /Mongo|27017|10\.0\.0\.5/);
  assert.match(replies[0].text, /could not look that up/i);
});
