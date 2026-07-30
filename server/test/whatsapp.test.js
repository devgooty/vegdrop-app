'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Sets NODE_ENV=test and the required secrets before config/env.js loads.
const { startTestServer, stopTestServer, api } = require('./helpers');

const {
  createWhatsappTransport,
  toWhatsappNumber,
  buildTemplatePayload,
} = require('../services/transports/whatsapp');

test.before(startTestServer);
test.after(stopTestServer);

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

function transport(overrides = {}, responses = [{ status: 200, body: { messages: [{ id: 'wamid.TEST' }] } }]) {
  const { impl, calls } = stubFetch(responses);
  const t = createWhatsappTransport({
    phoneNumberId: '111222333',
    accessToken: 'test-token',
    apiVersion: 'v21.0',
    templateName: 'vegbazzar_otp',
    templateLocale: 'en',
    defaultCountryCode: '91',
    fetchImpl: impl,
    ...overrides,
  });
  return { t, calls };
}

const otp = { code: '123456', purpose: 'login', ttlSeconds: 300 };

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

test('a stored 10-digit number gains the country code', () => {
  assert.equal(toWhatsappNumber('9876543210', '91'), '919876543210');
});

test('a number that already carries a country code is left alone', () => {
  assert.equal(toWhatsappNumber('919876543210', '91'), '919876543210');
  assert.equal(toWhatsappNumber('+91 98765 43210', '91'), '919876543210');
});

test('an unusable number is rejected rather than silently sent', () => {
  assert.throws(() => toWhatsappNumber('12345', '91'), /Cannot build a WhatsApp destination/);
  assert.throws(() => toWhatsappNumber('', '91'), /Cannot build a WhatsApp destination/);
});

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

test('the payload is an authentication template, never free-form text', () => {
  const payload = buildTemplatePayload({
    to: '919876543210',
    code: '123456',
    templateName: 'vegbazzar_otp',
    templateLocale: 'en',
    includeOtpButton: true,
    buttonSubType: 'url',
  });

  assert.equal(payload.type, 'template');
  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.template.name, 'vegbazzar_otp');
  assert.equal(payload.template.language.code, 'en');
  // No `text` key: a business-initiated free-form message would not deliver.
  assert.equal(payload.text, undefined);
});

test('the code is supplied to both the body and the OTP button', () => {
  const payload = buildTemplatePayload({
    to: '919876543210',
    code: '654321',
    templateName: 'vegbazzar_otp',
    templateLocale: 'en',
    includeOtpButton: true,
    buttonSubType: 'url',
  });

  const body = payload.template.components.find((c) => c.type === 'body');
  const button = payload.template.components.find((c) => c.type === 'button');

  assert.equal(body.parameters[0].text, '654321');
  assert.equal(button.parameters[0].text, '654321');
  assert.equal(button.sub_type, 'url');
});

test('the button component is omitted for templates without one', () => {
  const payload = buildTemplatePayload({
    to: '919876543210',
    code: '654321',
    templateName: 'vegbazzar_otp',
    templateLocale: 'en',
    includeOtpButton: false,
    buttonSubType: 'url',
  });

  assert.equal(payload.template.components.length, 1);
  assert.equal(payload.template.components[0].type, 'body');
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('a successful send posts once to the configured phone number id', async () => {
  const { t, calls } = transport();

  await t.send({ channel: 'sms', to: '9876543210', text: 'ignored by this transport', otp });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/111222333/messages');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].body.to, '919876543210');
  assert.equal(calls[0].body.template.components[0].parameters[0].text, '123456');
});

test('a send without structured otp details is refused', async () => {
  const { t, calls } = transport();

  await assert.rejects(
    () => t.send({ channel: 'sms', to: '9876543210', text: '123456 is your code' }),
    /requires a structured `otp` field/
  );
  assert.equal(calls.length, 0, 'nothing should be sent');
});

test('email is refused rather than dropped', async () => {
  const { t, calls } = transport();

  await assert.rejects(
    () => t.send({ channel: 'email', to: 'a@example.com', text: 'x', otp }),
    /cannot deliver email/
  );
  assert.equal(calls.length, 0);
});

test('a transient 503 is retried once and can then succeed', async () => {
  const { t, calls } = transport({}, [
    { status: 503, body: { error: { code: 2, message: 'transient' } } },
    { status: 200, body: { messages: [{ id: 'wamid.RETRY' }] } },
  ]);

  await t.send({ channel: 'sms', to: '9876543210', text: 'x', otp });

  assert.equal(calls.length, 2, 'should have retried exactly once');
});

test('a network timeout is retried once and then reported as a delivery failure', async () => {
  const { t, calls } = transport({}, [
    { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) },
    { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) },
  ]);

  await assert.rejects(
    () => t.send({ channel: 'sms', to: '9876543210', text: 'x', otp }),
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'OTP_DELIVERY_FAILED');
      return true;
    }
  );
  assert.equal(calls.length, 2);
});

test('a permanent template error is not retried', async () => {
  const { t, calls } = transport({}, [
    { status: 400, body: { error: { code: 132001, message: 'template does not exist' } } },
  ]);

  await assert.rejects(() => t.send({ channel: 'sms', to: '9876543210', text: 'x', otp }));
  assert.equal(calls.length, 1, 'a bad template will never succeed on retry');
});

test("Meta's status code never becomes the client's status code", async () => {
  // A 400 from Meta means OUR integration is wrong, not that the caller sent a
  // bad request. Surfacing it as a 400 would misreport whose fault it is.
  const { t } = transport({}, [
    { status: 400, body: { error: { code: 132000, message: 'parameter mismatch' } } },
  ]);

  await assert.rejects(
    () => t.send({ channel: 'sms', to: '9876543210', text: 'x', otp }),
    (err) => {
      assert.equal(err.statusCode, 503);
      return true;
    }
  );
});

test('the failure message reveals nothing about why delivery failed', async () => {
  // "Not a WhatsApp user" would be an account-enumeration oracle.
  const { t } = transport({}, [
    { status: 400, body: { error: { code: 131026, message: 'Message undeliverable' } } },
  ]);

  await assert.rejects(
    () => t.send({ channel: 'sms', to: '9876543210', text: 'x', otp }),
    (err) => {
      assert.match(err.message, /Could not send your verification code/);
      assert.doesNotMatch(err.message, /undeliverable|WhatsApp|131026/i);
      return true;
    }
  );
});

test('the code never appears in log output', async () => {
  const written = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => written.push(JSON.stringify(args));
  console.error = (...args) => written.push(JSON.stringify(args));

  try {
    const ok = transport();
    await ok.t.send({ channel: 'sms', to: '9876543210', text: 'x', otp });

    const bad = transport({}, [{ status: 400, body: { error: { code: 132001 } } }]);
    await bad.t.send({ channel: 'sms', to: '9876543210', text: 'x', otp }).catch(() => {});
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  const combined = written.join('\n');
  assert.ok(written.length > 0, 'expected some log output');
  assert.doesNotMatch(combined, /123456/, 'the OTP code must never be logged');
  // The destination is masked too.
  assert.doesNotMatch(combined, /919876543210/, 'the full number must not be logged');
  assert.match(combined, /\*+3210/, 'expected a masked destination');
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

test('webhook verification is refused when no verify token is configured', async () => {
  // config.whatsapp.webhookVerifyToken is unset under test.
  const res = await api()
    .get('/api/whatsapp/webhook')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': 'abc' });

  assert.equal(res.status, 503);
});

test('an unsigned webhook POST is rejected', async () => {
  const res = await api()
    .post('/api/whatsapp/webhook')
    .send({ object: 'whatsapp_business_account', entry: [] });

  // No app secret configured under test, so the endpoint refuses to trust it.
  assert.equal(res.status, 503);
});

test('a webhook signature is computed over the exact raw bytes', () => {
  // Guards the reason app.js captures rawBody: re-serialising the parsed object
  // does not reproduce Meta's bytes, so the HMAC would not match.
  const secret = 'app-secret';
  const raw = '{"object":"whatsapp_business_account","entry":[{"id":"1"}]}';

  const overRaw = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const overReserialised = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(JSON.parse(raw)))
    .digest('hex');

  assert.equal(overRaw, overReserialised, 'this payload happens to round-trip');

  // But whitespace — which Meta may include and JSON.parse discards — does not.
  const spaced = '{"object": "whatsapp_business_account", "entry": []}';
  const overSpaced = crypto.createHmac('sha256', secret).update(spaced).digest('hex');
  const overSpacedReserialised = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(JSON.parse(spaced)))
    .digest('hex');

  assert.notEqual(
    overSpaced,
    overSpacedReserialised,
    'a signature over re-serialised JSON is not the signature Meta sent'
  );
});
