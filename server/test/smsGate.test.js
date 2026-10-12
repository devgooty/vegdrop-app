'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { createSmsGateTransport, toE164India } = require('../services/transports/smsGate');

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

const ACCEPTED = { status: 202, body: { id: 'msg_1', state: 'Pending' } };

function transport(overrides = {}, responses = [ACCEPTED]) {
  const { impl, calls } = stubFetch(responses);
  const t = createSmsGateTransport({ username: 'gate-user', password: 'gate-pass', fetchImpl: impl, ...overrides });
  return { t, calls };
}

const TEXT = '482913 is your VegDrop verification code to sign in to your account.\nIt expires in 5 minutes. Do not share it with anyone.';
const msg = (extra = {}) => ({
  channel: 'sms',
  to: '9876543210',
  text: TEXT,
  otp: { code: '482913', purpose: 'login', ttlSeconds: 300 },
  ...extra,
});

test('a stored 10-digit number is sent in +91 form; prefixed spellings normalise the same', () => {
  assert.equal(toE164India('9876543210'), '+919876543210');
  assert.equal(toE164India('919876543210'), '+919876543210');
  assert.equal(toE164India('+91 98765 43210'), '+919876543210');
  assert.throws(() => toE164India('12345'), /Cannot build an SMS destination/);
  assert.throws(() => toE164India('1234567890'), /Cannot build an SMS destination/);
});

test('constructing without credentials fails at boot, not at first send', () => {
  assert.throws(() => createSmsGateTransport({ username: '', password: 'x' }), /requires username and password/);
});

test('a send posts the composed text once to the cloud relay with basic auth', async () => {
  const { t, calls } = transport();

  await t.send(msg());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sms-gate.app/3rdparty/v1/message');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(
    calls[0].options.headers.Authorization,
    `Basic ${Buffer.from('gate-user:gate-pass').toString('base64')}`
  );
  assert.deepEqual(calls[0].body, { textMessage: { text: TEXT }, phoneNumbers: ['+919876543210'] });
});

test('a self-hosted relay URL is honoured, trailing slash or not', async () => {
  const { t, calls } = transport({ baseUrl: 'https://sms.example.test/api/3rdparty/v1/' });
  await t.send(msg());
  assert.equal(calls[0].url, 'https://sms.example.test/api/3rdparty/v1/message');
});

test('email and a missing text are refused without sending anything', async () => {
  const { t, calls } = transport();
  await assert.rejects(() => t.send(msg({ channel: 'email', to: 'a@example.com' })), /cannot deliver email/);
  await assert.rejects(() => t.send(msg({ text: '' })), /none was given/);
  assert.equal(calls.length, 0);
});

test('a transient 503 is retried once and can then succeed', async () => {
  const { t, calls } = transport({}, [{ status: 503, body: { message: 'busy' } }, ACCEPTED]);
  await t.send(msg());
  assert.equal(calls.length, 2);
});

test('bad credentials are not retried and become a generic 503', async () => {
  const { t, calls } = transport({}, [{ status: 401, body: { message: 'Unauthorized' } }]);

  await assert.rejects(
    () => t.send(msg()),
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'OTP_DELIVERY_FAILED');
      assert.doesNotMatch(err.message, /unauthorized|gateway|sms-gate/i);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test('network timeouts are retried once and then reported as a delivery failure', async () => {
  const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const { t, calls } = transport({}, [{ throws: timeout() }, { throws: timeout() }]);

  await assert.rejects(() => t.send(msg()), (err) => err.code === 'OTP_DELIVERY_FAILED');
  assert.equal(calls.length, 2);
});

test('the code, the text and the credentials never appear in log output; the number is masked', async () => {
  const written = [];
  const originals = { info: console.info, error: console.error, warn: console.warn };
  console.info = (...a) => written.push(JSON.stringify(a));
  console.error = (...a) => written.push(JSON.stringify(a));
  console.warn = (...a) => written.push(JSON.stringify(a));

  try {
    await transport().t.send(msg());
    await transport({}, [{ status: 400, body: { message: 'rejected text 482913 is your VegDrop…' } }])
      .t.send(msg())
      .catch(() => {});
  } finally {
    Object.assign(console, originals);
  }

  const combined = written.join('\n');
  assert.ok(written.length > 0, 'expected some log output');
  assert.doesNotMatch(combined, /482913/, 'the code must never be logged');
  assert.doesNotMatch(combined, /gate-pass|gate-user/, 'credentials must never be logged');
  assert.doesNotMatch(combined, /9876543210/, 'the full number must not be logged');
  assert.match(combined, /\*+3210/);
});

// ---------------------------------------------------------------------------
// Boot-time configuration (config/env.js freezes at load: observe from a child)
// ---------------------------------------------------------------------------

function loadConfig(env) {
  const res = spawnSync(
    process.execPath,
    ['-e', "const c = require('./server/config/env'); console.log(JSON.stringify({ transport: c.notifyTransport, outboundFirst: c.otp.outboundFirst }))"],
    {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        NOTIFY_TRANSPORT: '',
        OTP_OUTBOUND_FIRST: '',
        FAST2SMS_API_KEY: '',
        SMSGATE_USERNAME: '',
        SMSGATE_PASSWORD: '',
        SMSGATE_URL: '',
        WHATSAPP_PHONE_NUMBER_ID: '',
        WHATSAPP_ACCESS_TOKEN: '',
        WHATSAPP_OTP_TEMPLATE_NAME: '',
        RAILWAY_ENVIRONMENT: '',
        RAILWAY_SERVICE_ID: '',
        VERCEL: '',
        RENDER: '',
        ...env,
      },
    }
  );
  const last = (res.stdout || '').trim().split('\n').pop();
  let printed = null;
  try {
    printed = JSON.parse(last);
  } catch {
    printed = null;
  }
  return { ...res, printed };
}

test('configuring only SMSGATE_* selects smsgate, code-first', () => {
  const res = loadConfig({ SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.printed, { transport: 'smsgate', outboundFirst: true });
});

test('NOTIFY_TRANSPORT=smsgate without credentials is a boot-time fatal', () => {
  const res = loadConfig({ NOTIFY_TRANSPORT: 'smsgate', SMSGATE_USERNAME: 'u' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /NOTIFY_TRANSPORT=smsgate requires SMSGATE_USERNAME and SMSGATE_PASSWORD/);
});

test('a malformed SMSGATE_URL is a boot-time fatal, not a crash at first send', () => {
  const res = loadConfig({ SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p', SMSGATE_URL: 'not a url' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /SMSGATE_URL must be an absolute URL/);
});

test('fast2sms still wins over smsgate when both are configured, unless chosen explicitly', () => {
  const both = { FAST2SMS_API_KEY: 'k'.repeat(32), SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p' };
  assert.equal(loadConfig(both).printed.transport, 'fast2sms');
  assert.equal(loadConfig({ ...both, NOTIFY_TRANSPORT: 'smsgate' }).printed.transport, 'smsgate');
});
