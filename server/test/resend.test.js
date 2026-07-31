'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Sets NODE_ENV=test and the required secrets before config/env.js loads.
require('./helpers');

const { createResendTransport, maskEmail } = require('../services/transports/resend');

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
      json: async () => next.body,
    };
  };

  return { impl, calls };
}

function transport(responses = [{ status: 200, body: { id: 'abc-123' } }]) {
  const { impl, calls } = stubFetch(responses);
  const t = createResendTransport({
    apiKey: 'test-key',
    from: 'VegBazzar <noreply@example.com>',
    fetchImpl: impl,
  });
  return { t, calls };
}

const message = {
  channel: 'email',
  to: 'customer@example.com',
  subject: 'Your VegBazzar verification code',
  text: '123456 is your VegBazzar verification code to sign in to your account.',
};

// ---------------------------------------------------------------------------

test('a successful send posts to Resend with a bearer key', async () => {
  const { t, calls } = transport();

  await t.send(message);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.from, 'VegBazzar <noreply@example.com>');
  assert.deepEqual(calls[0].body.to, ['customer@example.com']);
  assert.equal(calls[0].body.subject, message.subject);
});

test('a transient failure is retried exactly once', async () => {
  const { t, calls } = transport([
    { status: 503, body: { name: 'internal_server_error' } },
    { status: 200, body: { id: 'abc-123' } },
  ]);

  await t.send(message);

  assert.equal(calls.length, 2, 'one retry, then success');
});

test('a permanent failure is not retried', async () => {
  const { t, calls } = transport([{ status: 422, body: { name: 'validation_error', message: 'bad from' } }]);

  await assert.rejects(
    () => t.send(message),
    (err) => err.statusCode === 503 && err.code === 'OTP_DELIVERY_FAILED'
  );

  assert.equal(calls.length, 1, 'a rejected sender will be rejected again');
});

test("Resend's status never becomes the caller's status", async () => {
  // A 422 means our `from` is wrong, not that the caller's request was.
  const { t } = transport([{ status: 422, body: { name: 'validation_error' } }]);

  await assert.rejects(
    () => t.send(message),
    (err) => err.statusCode === 503
  );
});

test('every failure reports the same generic message', async () => {
  // "Mailbox does not exist" would otherwise confirm whether an address is real.
  const cases = [
    [{ status: 422, body: { name: 'validation_error' } }],
    [{ status: 401, body: { name: 'invalid_api_key' } }],
    [
      { status: 429, body: { name: 'rate_limit_exceeded' } },
      { status: 429, body: { name: 'rate_limit_exceeded' } },
    ],
  ];

  const messages = [];
  for (const responses of cases) {
    const { t } = transport(responses);
    await t.send(message).catch((err) => messages.push(`${err.statusCode}:${err.code}:${err.message}`));
  }

  assert.equal(new Set(messages).size, 1, 'no failure may be distinguishable from another');
});

test('a network error is handled and retried', async () => {
  const { t, calls } = transport([
    { throws: new Error('ECONNRESET') },
    { status: 200, body: { id: 'abc-123' } },
  ]);

  await t.send(message);
  assert.equal(calls.length, 2);
});

test('the code never appears in a thrown error', async () => {
  const { t } = transport([{ status: 422, body: { name: 'validation_error', message: 'bad' } }]);

  await t.send(message).catch((err) => {
    assert.ok(!err.message.includes('123456'), 'the code must not leak into an error');
  });
});

test('an address is masked for logs', () => {
  assert.equal(maskEmail('customer@example.com'), 'c*******@example.com');
  assert.equal(maskEmail('a@b.com'), 'a*@b.com');
  assert.equal(maskEmail('not-an-email'), '***');
});
