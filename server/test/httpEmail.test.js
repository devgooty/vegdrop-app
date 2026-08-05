'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Sets NODE_ENV=test and the required secrets before config/env.js loads.
require('./helpers');

const {
  createHttpEmailTransport,
  ProviderExhaustedError,
  PROVIDER_NAMES,
  parseSender,
  maskEmail,
} = require('../services/transports/httpEmail');
const { createFailoverTransport } = require('../services/transports/failover');

/** A fetch stub that records calls and replays queued responses. */
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
      json: async () => next.body ?? null,
    };
  };

  return { impl, calls };
}

function transport(provider, responses = [{ status: 200, body: { id: 'ok' } }]) {
  const { impl, calls } = stubFetch(responses);
  const t = createHttpEmailTransport({
    provider,
    apiKey: 'test-key',
    from: 'VegDrop <no-reply@example.com>',
    fetchImpl: impl,
  });
  return { t, calls };
}

const message = {
  channel: 'email',
  to: 'customer@example.com',
  subject: 'Your VegDrop verification code',
  text: '123456 is your VegDrop verification code to sign in to your account.',
};

// ---------------------------------------------------------------------------
// Every provider
// ---------------------------------------------------------------------------

test('every provider posts to its own endpoint and authenticates', async () => {
  for (const provider of PROVIDER_NAMES) {
    const { t, calls } = transport(provider);
    await t.send(message);

    assert.equal(calls.length, 1, `${provider}: one request`);
    assert.match(calls[0].url, /^https:\/\//, `${provider}: HTTPS, since SMTP is blocked`);
    assert.equal(calls[0].options.method, 'POST');

    const headerValues = Object.values(calls[0].options.headers).join(' ');
    assert.match(headerValues, /test-key/, `${provider}: the key must be sent`);
  }
});

test('every provider carries the recipient and the code somewhere in the body', async () => {
  for (const provider of PROVIDER_NAMES) {
    const { t, calls } = transport(provider);
    await t.send(message);

    const serialized = JSON.stringify(calls[0].body);
    assert.match(serialized, /customer@example\.com/, `${provider}: recipient`);
    assert.match(serialized, /123456/, `${provider}: the code`);
    assert.match(serialized, /no-reply@example\.com/, `${provider}: sender`);
  }
});

test('a 202 with an empty body is a success, not a parse failure', async () => {
  // SendGrid and MailerSend answer 202 with no content.
  const { t } = transport('sendgrid', [{ status: 202, body: null }]);
  await t.send(message);
});

// ---------------------------------------------------------------------------
// Retry and failure behaviour
// ---------------------------------------------------------------------------

test('a transient failure is retried exactly once', async () => {
  const { t, calls } = transport('brevo', [
    { status: 503, body: { message: 'upstream' } },
    { status: 200, body: { messageId: 'x' } },
  ]);

  await t.send(message);
  assert.equal(calls.length, 2);
});

test('a permanent failure is not retried', async () => {
  const { t, calls } = transport('brevo', [{ status: 422, body: { message: 'bad sender' } }]);

  await assert.rejects(() => t.send(message));
  assert.equal(calls.length, 1, 'a rejected sender will be rejected again');
});

test('a quota response is not retried in place — it will not refill in a second', async () => {
  const { t, calls } = transport('brevo', [{ status: 429, body: { message: 'daily limit' } }]);

  await assert.rejects(() => t.send(message), (err) => err instanceof ProviderExhaustedError);
  assert.equal(calls.length, 1);
});

test("a provider's HTTP status never becomes the caller's", async () => {
  const { t } = transport('brevo', [{ status: 422, body: { message: 'bad sender' } }]);

  // 422 means our sender is wrong, not that the caller's request was.
  await assert.rejects(() => t.send(message), (err) => err.statusCode === 503);
});

test('the code never appears in a thrown error', async () => {
  const { t } = transport('brevo', [{ status: 422, body: { message: 'nope' } }]);

  await t.send(message).catch((err) => {
    assert.ok(!err.message.includes('123456'));
  });
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** A transport that fails a set number of times, then succeeds. */
function fakeTransport(name, { failWith = null } = {}) {
  const sent = [];
  return {
    sent,
    name,
    async send(msg) {
      if (failWith) throw failWith;
      sent.push(msg);
    },
  };
}

test('the chain uses the first provider when it works', async () => {
  const first = fakeTransport('first');
  const second = fakeTransport('second');

  await createFailoverTransport({ transports: [first, second] }).send(message);

  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0, 'the fallback must not be touched');
});

test('the chain moves on when a provider is out of quota', async () => {
  const first = fakeTransport('first', { failWith: new ProviderExhaustedError('brevo', 'daily limit') });
  const second = fakeTransport('second');

  await createFailoverTransport({ transports: [first, second] }).send(message);

  assert.equal(second.sent.length, 1, 'the next provider delivers');
});

test('the chain moves on when a provider is simply broken', async () => {
  const first = fakeTransport('first', { failWith: new Error('connection refused') });
  const second = fakeTransport('second');

  await createFailoverTransport({ transports: [first, second] }).send(message);

  assert.equal(second.sent.length, 1);
});

test('the chain walks past several dead providers', async () => {
  const dead = ['a', 'b', 'c', 'd'].map((n) => fakeTransport(n, { failWith: new Error('down') }));
  const last = fakeTransport('last');

  await createFailoverTransport({ transports: [...dead, last] }).send(message);

  assert.equal(last.sent.length, 1);
});

test('only when every provider fails does the caller see a failure', async () => {
  const dead = ['a', 'b'].map((n) => fakeTransport(n, { failWith: new Error('down') }));

  await assert.rejects(
    () => createFailoverTransport({ transports: dead }).send(message),
    (err) => err.statusCode === 503 && err.code === 'OTP_DELIVERY_FAILED'
  );
});

test('a total failure does not name the providers to the caller', async () => {
  const dead = [fakeTransport('email:brevo', { failWith: new Error('down') })];

  await createFailoverTransport({ transports: dead })
    .send(message)
    .catch((err) => {
      // Which providers are in use is operational detail, not a public response.
      assert.ok(!err.message.toLowerCase().includes('brevo'));
    });
});

test('a chain with no transports is refused at construction', () => {
  assert.throws(() => createFailoverTransport({ transports: [] }));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('a sender is split into name and address', () => {
  assert.deepEqual(parseSender('VegDrop <no-reply@example.com>'), {
    name: 'VegDrop',
    email: 'no-reply@example.com',
  });
  assert.deepEqual(parseSender('plain@example.com'), { name: undefined, email: 'plain@example.com' });
});

test('an address is masked for logs', () => {
  assert.equal(maskEmail('customer@example.com'), 'c*******@example.com');
  assert.equal(maskEmail('not-an-email'), '***');
});

test('an unknown provider is refused at construction', () => {
  assert.throws(() => createHttpEmailTransport({ provider: 'nope', apiKey: 'k', from: 'a@b.com' }));
});

test('the configured sender is the one EMAIL_FROM sets', () => {
  /**
   * Guards a bug that cost an evening: `from` was declared twice in the
   * config.email object literal — once from EMAIL_FROM, once from SMTP_FROM —
   * and a duplicate key in a literal is not an error, it silently wins. The
   * sender therefore always resolved to SMTP_FROM, so removing that variable
   * (correct, once SMTP was replaced) emptied it, and every provider rejected
   * the message with "sender email is missing" four layers away.
   */
  const config = require('../config/env');

  assert.equal(config.email.from, process.env.EMAIL_FROM);
  assert.ok(config.email.from.includes('@'), 'a sender must carry an address');
  // SMTP settings live in their own object so the collision cannot come back.
  assert.equal(typeof config.email.smtp, 'object');
});

// ---------------------------------------------------------------------------
// The HTML part
// ---------------------------------------------------------------------------

const htmlMessage = { ...message, html: '<p>123456</p>' };

test('every provider carries the HTML part when one is supplied', async () => {
  for (const provider of PROVIDER_NAMES) {
    const { t, calls } = transport(provider);
    await t.send(htmlMessage);

    const body = JSON.stringify(calls[0].body);
    assert.match(body, /<p>123456<\/p>/, `${provider}: the markup must reach the provider`);
  }
});

test('every provider still sends plain text when there is no HTML', async () => {
  for (const provider of PROVIDER_NAMES) {
    const { t, calls } = transport(provider);
    await t.send(message);

    const body = JSON.stringify(calls[0].body);
    assert.match(body, /123456/, `${provider}: the code must still be sent`);
    assert.doesNotMatch(body, /<p>/, `${provider}: no markup was asked for`);
  }
});

test('SendGrid receives plain text before HTML, which it requires', async () => {
  const { t, calls } = transport('sendgrid');
  await t.send(htmlMessage);

  // Ascending order of preference is not a style choice here: SendGrid rejects
  // the request outright when text/html comes first.
  assert.deepEqual(
    calls[0].body.content.map((part) => part.type),
    ['text/plain', 'text/html']
  );
});

test('Plunk declares the body type it is actually sending', async () => {
  // It takes one body rather than both parts, so the flag and the content have
  // to agree — declaring html for plain text renders the source as-is.
  const withHtml = transport('plunk');
  await withHtml.t.send(htmlMessage);
  assert.equal(withHtml.calls[0].body.type, 'html');
  assert.equal(withHtml.calls[0].body.body, htmlMessage.html);

  const withoutHtml = transport('plunk');
  await withoutHtml.t.send(message);
  assert.equal(withoutHtml.calls[0].body.type, 'text');
  assert.equal(withoutHtml.calls[0].body.body, message.text);
});
