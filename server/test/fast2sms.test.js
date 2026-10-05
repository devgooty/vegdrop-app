'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createFast2smsTransport,
  toFast2smsNumber,
} = require('../services/transports/fast2sms');

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

const OK = { status: 200, body: { return: true, request_id: 'req_TEST', message: ['SMS sent successfully.'] } };

function transport(overrides = {}, responses = [OK]) {
  const { impl, calls } = stubFetch(responses);
  const t = createFast2smsTransport({ apiKey: 'test-key', fetchImpl: impl, ...overrides });
  return { t, calls };
}

const otp = { code: '123456', purpose: 'login', ttlSeconds: 300 };
const msg = (extra = {}) => ({ channel: 'sms', to: '9876543210', text: 'ignored by this transport', otp, ...extra });

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

test('a stored 10-digit number is used as is', () => {
  assert.equal(toFast2smsNumber('9876543210'), '9876543210');
});

test('a +91 / 91 prefix is stripped back to the 10-digit number', () => {
  assert.equal(toFast2smsNumber('919876543210'), '9876543210');
  assert.equal(toFast2smsNumber('+91 98765 43210'), '9876543210');
});

test('an unusable number is rejected rather than silently sent', () => {
  assert.throws(() => toFast2smsNumber('12345'), /Cannot build a Fast2SMS destination/);
  assert.throws(() => toFast2smsNumber(''), /Cannot build a Fast2SMS destination/);
  // Valid length but not an Indian mobile (must start 6-9).
  assert.throws(() => toFast2smsNumber('1234567890'), /Cannot build a Fast2SMS destination/);
});

test('constructing the transport without a key fails at boot, not at first send', () => {
  assert.throws(() => createFast2smsTransport({ apiKey: '' }), /requires an apiKey/);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('a successful send posts the otp route once, with the key in the authorization header', async () => {
  const { t, calls } = transport();

  await t.send(msg());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.fast2sms.com/dev/bulkV2');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'test-key');
  assert.deepEqual(calls[0].body, { route: 'otp', variables_values: '123456', numbers: '9876543210' });
});

test('the key never appears in the request body or URL', async () => {
  const { t, calls } = transport();
  await t.send(msg());

  assert.ok(!calls[0].url.includes('test-key'));
  assert.ok(!calls[0].options.body.includes('test-key'));
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

  await assert.rejects(() => t.send(msg({ channel: 'email', to: 'a@example.com' })), /cannot deliver email/);
  assert.equal(calls.length, 0);
});

test('a transient 503 is retried once and can then succeed', async () => {
  const { t, calls } = transport({}, [{ status: 503, body: { return: false, message: 'busy' } }, OK]);

  await t.send(msg());

  assert.equal(calls.length, 2, 'should have retried exactly once');
});

test('a network timeout is retried once and then reported as a delivery failure', async () => {
  const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const { t, calls } = transport({}, [{ throws: timeout() }, { throws: timeout() }]);

  await assert.rejects(
    () => t.send(msg()),
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'OTP_DELIVERY_FAILED');
      return true;
    }
  );
  assert.equal(calls.length, 2);
});

test('a permanent rejection (bad key, empty wallet) is not retried', async () => {
  const { t, calls } = transport({}, [
    { status: 400, body: { return: false, status_code: 412, message: 'Invalid Authentication' } },
  ]);

  await assert.rejects(() => t.send(msg()));
  assert.equal(calls.length, 1, 'a bad key will never succeed on retry');
});

test('HTTP 200 with return:false is a failure, not a success', async () => {
  // Fast2SMS reports some rejections this way; trusting the status line alone
  // would tell the user a code is on its way when nothing was sent.
  const { t } = transport({}, [{ status: 200, body: { return: false, status_code: 999, message: 'low balance' } }]);

  await assert.rejects(
    () => t.send(msg()),
    (err) => {
      assert.equal(err.code, 'OTP_DELIVERY_FAILED');
      return true;
    }
  );
});

test("Fast2SMS's status code never becomes the client's status code", async () => {
  const { t } = transport({}, [{ status: 400, body: { return: false, message: 'bad request' } }]);

  await assert.rejects(
    () => t.send(msg()),
    (err) => {
      assert.equal(err.statusCode, 503);
      return true;
    }
  );
});

test('the failure message reveals nothing about why delivery failed', async () => {
  const { t } = transport({}, [{ status: 400, body: { return: false, message: ['Invalid Numbers', 'low balance'] } }]);

  await assert.rejects(
    () => t.send(msg()),
    (err) => {
      assert.match(err.message, /Could not send your verification code/);
      assert.doesNotMatch(err.message, /invalid|balance|fast2sms/i);
      return true;
    }
  );
});

test('the code and the key never appear in log output; the number is masked', async () => {
  const written = [];
  const originals = { info: console.info, error: console.error, warn: console.warn };
  console.info = (...args) => written.push(JSON.stringify(args));
  console.error = (...args) => written.push(JSON.stringify(args));
  console.warn = (...args) => written.push(JSON.stringify(args));

  try {
    const ok = transport();
    await ok.t.send(msg());

    // A provider that echoes the request back must not smuggle the code into the log.
    const bad = transport({}, [
      { status: 400, body: { return: false, message: 'rejected variables_values=123456' } },
    ]);
    await bad.t.send(msg()).catch(() => {});
  } finally {
    Object.assign(console, originals);
  }

  const combined = written.join('\n');
  assert.ok(written.length > 0, 'expected some log output');
  assert.doesNotMatch(combined, /123456/, 'the OTP code must never be logged');
  assert.doesNotMatch(combined, /test-key/, 'the API key must never be logged');
  assert.doesNotMatch(combined, /9876543210/, 'the full number must not be logged');
  assert.match(combined, /\*+3210/, 'expected a masked destination');
});

// ---------------------------------------------------------------------------
// Boot-time configuration
// ---------------------------------------------------------------------------

/**
 * config/env.js freezes at load and throws on a bad environment, so it can only
 * be observed from a child process.
 */
function loadConfig(env) {
  return spawnSync(
    process.execPath,
    ['-e', "const c = require('./server/config/env'); console.log(c.notifyTransport)"],
    {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        NOTIFY_TRANSPORT: '',
        FAST2SMS_API_KEY: '',
        WHATSAPP_PHONE_NUMBER_ID: '',
        WHATSAPP_ACCESS_TOKEN: '',
        WHATSAPP_OTP_TEMPLATE_NAME: '',
        // Cleared so a platform marker leaking in from the real shell cannot make
        // this look like a deployed host.
        RAILWAY_ENVIRONMENT: '',
        RAILWAY_SERVICE_ID: '',
        VERCEL: '',
        RENDER: '',
        ...env,
      },
    }
  );
}

// dotenv may print a banner to stdout before the line the child writes.
const lastLine = (out) => out.trim().split('\n').pop();

test('configuring only FAST2SMS_API_KEY selects the fast2sms transport', () => {
  const res = loadConfig({ FAST2SMS_API_KEY: 'k'.repeat(32) });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(lastLine(res.stdout), 'fast2sms');
});

test('NOTIFY_TRANSPORT=fast2sms without a key is a boot-time fatal', () => {
  const res = loadConfig({ NOTIFY_TRANSPORT: 'fast2sms' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /NOTIFY_TRANSPORT=fast2sms requires FAST2SMS_API_KEY/);
});

test('with neither provider configured the default stays the console stub', () => {
  const res = loadConfig({});
  assert.equal(res.status, 0, res.stderr);
  assert.equal(lastLine(res.stdout), 'console');
});
