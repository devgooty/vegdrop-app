'use strict';

/**
 * The phone transport chain.
 *
 * `NOTIFY_TRANSPORT` picks which transport is tried FIRST. It used to also
 * decide that no other may be tried at all, and that was a live outage: this
 * project's own host had WhatsApp fully configured and was pinned to
 * `fast2sms`, Fast2SMS answered `status_code 996` to every send, and because
 * sign-in here is passwordless that pushed every customer onto reverse OTP —
 * with a working transport one `if` away. (`routes/auth.js` degrades to
 * `challengeId: null` rather than throwing when an inbound channel exists, so
 * it was not a total lockout — only everyone who did not pick "verify by
 * sending us a message".)
 *
 * No database and no server: these are the two pure parts (which transports
 * exist, and what the chain does when one refuses). Credentials are set before
 * `config/env.js` is required, because config is frozen at load — the same
 * reason spelled out at the top of `reverseOtp.test.js`.
 */

process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
process.env.WHATSAPP_OTP_TEMPLATE_NAME = 'otp_code';
process.env.FAST2SMS_API_KEY = 'test-key';
process.env.NOTIFY_TRANSPORT = 'fast2sms';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config/env');
const { configuredPhoneTransports, failoverTransport } = require('../services/notify');

/** Records which transports were reached, in order. */
function spy(name, { fails = false } = {}) {
  const calls = [];
  return {
    calls,
    entry: {
      name,
      transport: {
        async send() {
          calls.push(name);
          if (fails) throw new Error(`${name} refused`);
        },
      },
    },
  };
}

test('the chosen transport is first, and the others are still reachable', () => {
  assert.equal(config.notifyTransport, 'fast2sms');
  assert.deepEqual(config.transportCredentials, {
    whatsapp: true,
    fast2sms: true,
    smsgate: false,
  });
  // smsgate has no credentials here, so it is not in the chain at all: a
  // fallback to a transport that cannot authenticate is just a slower failure.
  assert.deepEqual(configuredPhoneTransports(), ['fast2sms', 'whatsapp']);
});

test('a chain reports whether it can reach anyone, rather than assuming it can', () => {
  const reaching = { name: 'whatsapp', transport: { reachesRecipient: true, async send() {} } };
  const stub = { name: 'console', transport: { reachesRecipient: false, async send() {} } };

  // `reachesRecipient` decides whether routes/auth.js attempts an outbound code
  // at all. A chain that claims delivery it cannot make hands back a
  // challengeId for a code nobody received, instead of offering reverse OTP.
  assert.equal(failoverTransport([stub, reaching]).reachesRecipient, true);
  assert.equal(failoverTransport([stub, stub]).reachesRecipient, false);
});

test('a refusing primary hands the SAME code to the next transport', async () => {
  const primary = spy('fast2sms', { fails: true });
  const backup = spy('whatsapp');
  const message = { to: '9999999999', otp: { code: '123456' } };

  await failoverTransport([primary.entry, backup.entry]).send(message);

  assert.deepEqual(primary.calls, ['fast2sms']);
  assert.deepEqual(backup.calls, ['whatsapp'], 'the fallback was never reached');
});

test('a working primary is the only transport used', async () => {
  const primary = spy('fast2sms');
  const backup = spy('whatsapp');

  await failoverTransport([primary.entry, backup.entry]).send({ to: '9999999999' });

  assert.deepEqual(primary.calls, ['fast2sms']);
  // Every fallback send costs money and arrives on someone's phone. A second
  // message after a success is the failure mode this assertion exists for.
  assert.deepEqual(backup.calls, [], 'the fallback sent a duplicate after a success');
});

test('when every transport refuses, the caller still sees one failure', async () => {
  const primary = spy('fast2sms', { fails: true });
  const backup = spy('whatsapp', { fails: true });

  await assert.rejects(
    () => failoverTransport([primary.entry, backup.entry]).send({ to: '9999999999' }),
    /refused/,
    'a chain that exhausts itself must throw, not resolve as if delivered'
  );

  assert.deepEqual(primary.calls, ['fast2sms']);
  assert.deepEqual(backup.calls, ['whatsapp']);
});
