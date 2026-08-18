'use strict';

/**
 * Reverse OTP — verifying a number by RECEIVING a message rather than sending one.
 *
 * WHY THE ENVIRONMENT IS SET HERE AND NOT IN helpers.js
 *
 * config/env.js validates and freezes configuration the first time it is
 * required, so a test cannot turn a channel on partway through a run. Both
 * channels have to be configured before `./helpers` pulls the app in.
 *
 * They are set in THIS FILE rather than in the shared helper on purpose.
 * whatsapp.test.js asserts that an unsigned webhook POST is refused with 503
 * *because* no app secret is configured — configuring one globally would flip
 * that assertion and delete the coverage it provides. `node --test` runs each
 * test file in its own process, so this file gets a configured app secret and
 * that one keeps its unconfigured server. Neither has to know about the other.
 */
process.env.WHATSAPP_APP_SECRET = 'test-whatsapp-app-secret-long-enough-00000000';
process.env.WHATSAPP_INBOX_NUMBER = '919000000001';
process.env.SMS_GATEWAY_INBOX_NUMBER = '919000000002';
process.env.SMS_GATEWAY_SECRET = 'test-sms-gateway-secret-long-enough-000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startTestServer, stopTestServer, resetDatabase, api, createUser, auth } = require('./helpers');
const ReverseOtpChallenge = require('../models/ReverseOtpChallenge');
const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

const GATEWAY_SECRET = process.env.SMS_GATEWAY_SECRET;

/** Start a reverse challenge and return the whole body. */
async function start({ phone, purpose = 'login', app, name } = {}) {
  const res = await api()
    .post('/api/auth/reverse/start')
    .send({ phone, purpose, ...(app ? { app } : {}), ...(name ? { name } : {}) });

  if (res.status !== 201) {
    throw new Error(`reverse/start failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** Deliver an inbound SMS through the relay endpoint. */
function relaySms({ from, text, secret = GATEWAY_SECRET }) {
  return api()
    .post('/api/gateway/reverse-otp-sms')
    .set('X-Gateway-Secret', secret)
    .send({ from, text });
}

/**
 * Deliver a signed inbound WhatsApp message.
 *
 * The body is sent as a STRING with an explicit content type. Handing supertest
 * an object would let it re-serialise, and the HMAC covers the exact bytes Meta
 * sent — a re-serialised body no longer matches its own signature.
 */
function deliverWhatsapp({ from, text }) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [{ from, id: 'wamid.test', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });

  const signature = crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(raw)
    .digest('hex');

  return api()
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', `sha256=${signature}`)
    .send(raw);
}

function status(token) {
  return api().get('/api/auth/reverse/status').query({ token });
}

// ---------------------------------------------------------------------------
// Starting a challenge
// ---------------------------------------------------------------------------

test('starting a challenge returns a code and the channels that are live', async () => {
  const body = await start({ phone: '9876543210' });

  assert.ok(body.token, 'expected a poll token');
  assert.match(body.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.ok(body.channels.whatsapp, 'whatsapp is configured in this file');
  assert.ok(body.channels.sms, 'sms is configured in this file');
});

test('the code excludes characters that are easy to misread', async () => {
  // A handful of draws, since any single code may legitimately miss a character.
  for (let i = 0; i < 25; i += 1) {
    const { code } = await start({ phone: '9876543210' });
    assert.doesNotMatch(code, /[01OIL]/, `ambiguous character in ${code}`);
  }
});

test('the prefilled links carry the code and point at the inbox numbers', async () => {
  const { code, channels } = await start({ phone: '9876543210' });

  assert.ok(channels.whatsapp.link.startsWith('https://wa.me/919000000001?text='));
  assert.ok(channels.whatsapp.link.includes(code), 'the wa.me link must carry the code');

  // Both RFC 5724 separators are offered; they cannot share one href.
  assert.ok(channels.sms.link.startsWith('sms:919000000002?body='));
  assert.ok(channels.sms.linkLegacy.startsWith('sms:919000000002&body='));
  assert.ok(channels.sms.link.includes(code));
});

test('the SMS channel is reported as lower assurance than WhatsApp', async () => {
  const { channels } = await start({ phone: '9876543210' });

  // Meta attests its senders; a relayed SMS header does not. The difference is
  // surfaced rather than left for the caller to assume away.
  assert.equal(channels.whatsapp.assurance, 'high');
  assert.equal(channels.sms.assurance, 'low');
});

test('the token does not contain the phone number', async () => {
  const { token } = await start({ phone: '9876543210' });

  // The token travels in a query string on every poll. A phone-derived handle
  // would put the number in logs, referrers and proxy caches.
  assert.doesNotMatch(token, /9876543210/);
  assert.doesNotMatch(token, /543210/);
});

test('the plaintext code is never stored', async () => {
  const { code } = await start({ phone: '9876543210' });
  const stored = await ReverseOtpChallenge.findOne({ phone: '9876543210' }).lean();

  assert.ok(stored.codeHash, 'expected a hash');
  assert.notEqual(stored.codeHash, code);
  assert.equal(JSON.stringify(stored).includes(code), false, 'the code must not appear anywhere on the record');
});

test('starting again supersedes the previous challenge for that number', async () => {
  const first = await start({ phone: '9876543210' });
  const second = await start({ phone: '9876543210' });

  // Otherwise a screen still polling the first token waits on a code the user
  // has already replaced, forever.
  assert.equal((await status(first.token)).body.state, 'expired');
  assert.equal((await status(second.token)).body.state, 'pending');
});

test('a phone change cannot be started through the unauthenticated route', async () => {
  const res = await api()
    .post('/api/auth/reverse/start')
    .send({ phone: '9876543210', purpose: 'phone_change' });

  // It needs a session to bind to; an unbound phone-change challenge would be
  // redeemable by whoever holds the token.
  assert.equal(res.status, 400);
});

test('a role cannot be smuggled into the start request', async () => {
  const res = await api()
    .post('/api/auth/reverse/start')
    .send({ phone: '9876543210', purpose: 'login', role: 'developer' });

  assert.equal(res.status, 400, '.strict() must reject an unknown field');
});

// ---------------------------------------------------------------------------
// Matching an inbound message
// ---------------------------------------------------------------------------

test('a message from the claimed number verifies it', async () => {
  const { user } = await createUser({ role: 'customer', phone: '9876543210' });
  const { token, code } = await start({ phone: user.phone, app: 'customer' });

  assert.equal((await status(token)).body.state, 'pending');

  const relayed = await relaySms({ from: '+91 98765 43210', text: `Verify my number for VegDrop: ${code}` });
  assert.equal(relayed.status, 204);

  assert.equal((await status(token)).body.state, 'verified');
});

test('a fully qualified sender matches a locally stored number', async () => {
  await createUser({ role: 'customer', phone: '9876543210' });
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  // Meta reports senders as 919876543210; the database holds ten digits.
  await deliverWhatsapp({ from: '919876543210', text: code });

  assert.equal((await status(token)).body.state, 'verified');
});

test('the code is matched case-insensitively and inside surrounding text', async () => {
  await createUser({ role: 'customer', phone: '9876543210' });
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  await relaySms({ from: '9876543210', text: `hi there ${code.toLowerCase()} thanks` });

  assert.equal((await status(token)).body.state, 'verified');
});

test('the right code from the wrong number is refused and reported', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  // Someone else forwarded the message. Knowing the code is not enough.
  await relaySms({ from: '9999999999', text: code });

  const body = (await status(token)).body;
  assert.equal(body.state, 'mismatch');
  assert.equal(body.expectedPhone, '******3210', 'the user is told which number to send from');

  // The number that actually sent it is a third party's and is never returned.
  assert.equal(JSON.stringify(body).includes('9999999999'), false);
});

test('a mismatch does not complete', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });
  await relaySms({ from: '9999999999', text: code });

  const res = await api().post('/api/auth/reverse/complete').send({ token });
  assert.equal(res.status, 400);
  assert.equal(res.body.accessToken, undefined, 'no session may be issued for a refused verification');
});

test('a message with no valid code is attributed back to the sender', async () => {
  const { token } = await start({ phone: '9876543210', app: 'customer' });

  await relaySms({ from: '9876543210', text: 'Verify my number for VegDrop: ABC999' });

  // Without this the user sees "waiting" forever and never learns they mistyped.
  assert.equal((await status(token)).body.state, 'bad_code');
});

test('a correct send after a wrong one still succeeds', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  await relaySms({ from: '9876543210', text: 'oops WRONG1' });
  assert.equal((await status(token)).body.state, 'bad_code');

  await relaySms({ from: '9876543210', text: code });
  assert.equal((await status(token)).body.state, 'verified', 'verified must win over a stale badCode');
});

test('a later wrong-number message cannot undo a verification', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  await relaySms({ from: '9876543210', text: code });
  await relaySms({ from: '9999999999', text: code });

  assert.equal((await status(token)).body.state, 'verified', 'verified must win over a later mismatch');
});

test('an expired challenge cannot be verified', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  // TTL reaping lags by up to a minute, so the document is still present. Expiry
  // has to be decided on the timestamp, not on the row being gone.
  await ReverseOtpChallenge.updateOne({ token }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  await relaySms({ from: '9876543210', text: code });
  assert.equal((await status(token)).body.state, 'expired');
});

test('an unknown token reads as expired', async () => {
  assert.equal((await status('nope')).body.state, 'expired');
});

// ---------------------------------------------------------------------------
// Inbound channel authentication
// ---------------------------------------------------------------------------

test('the SMS relay refuses a wrong shared secret', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  const res = await relaySms({ from: '9876543210', text: code, secret: 'wrong-secret' });

  assert.equal(res.status, 403);
  assert.equal((await status(token)).body.state, 'pending', 'an unauthenticated relay must verify nothing');
});

test('the SMS relay refuses a missing shared secret', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  const res = await api().post('/api/gateway/reverse-otp-sms').send({ from: '9876543210', text: code });

  assert.equal(res.status, 403);
  assert.equal((await status(token)).body.state, 'pending');
});

test('the relay answers the same whether or not a code matched', async () => {
  const { code } = await start({ phone: '9876543210', app: 'customer' });

  const matched = await relaySms({ from: '9876543210', text: code });
  const unmatched = await relaySms({ from: '9111111111', text: 'nothing here' });

  // Anyone holding the secret must not be able to read match results off the
  // status code and use it to test codes against numbers.
  assert.equal(matched.status, 204);
  assert.equal(unmatched.status, 204);
});

test('an unsigned WhatsApp webhook verifies nothing', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });

  const res = await api()
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ value: { messages: [{ from: '919876543210', type: 'text', text: { body: code } }] } }] }],
    }));

  assert.equal(res.status, 403, 'the signature is the only thing establishing this came from Meta');
  assert.equal((await status(token)).body.state, 'pending');
});

test('a non-text WhatsApp message never verifies anything', async () => {
  const { token } = await start({ phone: '9876543210', app: 'customer' });

  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [{ value: { messages: [{ from: '919876543210', type: 'image', image: { id: 'x' } }] } }],
      },
    ],
  });
  const signature = crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex');

  await api()
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', `sha256=${signature}`)
    .send(raw);

  assert.equal((await status(token)).body.state, 'pending');
});

// ---------------------------------------------------------------------------
// Completing
// ---------------------------------------------------------------------------

test('completing a verified login issues a session', async () => {
  const { user } = await createUser({ role: 'customer', phone: '9876543210' });
  const { token, code } = await start({ phone: user.phone, app: 'customer' });
  await relaySms({ from: '9876543210', text: code });

  const res = await api().post('/api/auth/reverse/complete').send({ token });

  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  assert.equal(res.body.user.id, String(user._id));
  assert.ok((res.headers['set-cookie'] || []).some((c) => c.startsWith('vb_rt=')), 'expected a refresh cookie');
});

test('a challenge that was never verified cannot be completed', async () => {
  const { token } = await start({ phone: '9876543210', app: 'customer' });

  const res = await api().post('/api/auth/reverse/complete').send({ token });

  assert.equal(res.status, 400);
  assert.equal(res.body.accessToken, undefined);
});

test('a token is single use', async () => {
  await createUser({ role: 'customer', phone: '9876543210' });
  const { token, code } = await start({ phone: '9876543210', app: 'customer' });
  await relaySms({ from: '9876543210', text: code });

  assert.equal((await api().post('/api/auth/reverse/complete').send({ token })).status, 200);

  const second = await api().post('/api/auth/reverse/complete').send({ token });
  assert.equal(second.status, 400, 'a spent token must not mint a second session');
});

test('a new number signing in on the customer app gets an account', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'customer', name: 'Asha Rao' });
  await relaySms({ from: '9876543210', text: code });

  const res = await api().post('/api/auth/reverse/complete').send({ token });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'customer');
  assert.equal(res.body.user.name, 'Asha Rao');
  assert.equal(res.body.user.phoneVerified, true);
});

test('an unknown number on the shopkeeper app never mints an account', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'shopkeeper' });
  await relaySms({ from: '9876543210', text: code });

  // Verification succeeded — they do own the number — but a privileged account
  // is only ever created through its own dual-OTP registration.
  assert.equal((await status(token)).body.state, 'verified');

  const res = await api().post('/api/auth/reverse/complete').send({ token });
  assert.equal(res.status, 401);
  assert.equal(await User.countDocuments({ phone: '9876543210' }), 0, 'no account may be created here');
});

test('the app recorded at start decides account creation, not the completing request', async () => {
  const { token, code } = await start({ phone: '9876543210', app: 'delivery' });
  await relaySms({ from: '9876543210', text: code });

  // .strict() means an `app` override on complete is a 400, and the stored value
  // is what governs regardless.
  const spoofed = await api().post('/api/auth/reverse/complete').send({ token, app: 'customer' });
  assert.equal(spoofed.status, 400);

  const honest = await api().post('/api/auth/reverse/complete').send({ token });
  assert.equal(honest.status, 401);
  assert.equal(await User.countDocuments({ phone: '9876543210' }), 0);
});

test('a suspended account cannot sign in through the reverse flow', async () => {
  const { user } = await createUser({ role: 'customer', phone: '9876543210', status: 'suspended' });
  const { token, code } = await start({ phone: user.phone, app: 'customer' });
  await relaySms({ from: '9876543210', text: code });

  const res = await api().post('/api/auth/reverse/complete').send({ token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ACCOUNT_INACTIVE');
});

// ---------------------------------------------------------------------------
// Changing a number
// ---------------------------------------------------------------------------

async function signedInCustomer(phone) {
  const { user } = await createUser({ role: 'customer', phone });
  const { token, code } = await start({ phone, app: 'customer' });
  await relaySms({ from: phone, text: code });
  const res = await api().post('/api/auth/reverse/complete').send({ token });
  return { user, accessToken: res.body.accessToken };
}

test('changing a number requires a session', async () => {
  const res = await api().post('/api/auth/reverse/start/phone').send({ phone: '9000011111' });
  assert.equal(res.status, 401);
});

test('a verified reverse challenge changes the number and signs other devices out', async () => {
  const { user, accessToken } = await signedInCustomer('9876543210');
  const originalTokenVersion = user.tokenVersion;

  const started = await api()
    .post('/api/auth/reverse/start/phone')
    .set(auth(accessToken))
    .send({ phone: '9000011111' });
  assert.equal(started.status, 201);

  // Sent from the NEW number: the point is proving they can use the number that
  // sign-in will depend on afterwards.
  await relaySms({ from: '9000011111', text: started.body.code });

  const done = await api()
    .post('/api/auth/reverse/complete/phone')
    .set(auth(accessToken))
    .send({ token: started.body.token });

  assert.equal(done.status, 200);
  assert.equal(done.body.user.phone, '9000011111');

  const stored = await User.findById(user._id);
  assert.equal(stored.phone, '9000011111');
  assert.ok(stored.tokenVersion > originalTokenVersion, 'sessions issued against the old number must be revoked');
});

test('one account cannot redeem another account phone-change token', async () => {
  const owner = await signedInCustomer('9876543210');
  const stranger = await signedInCustomer('9555544444');

  const started = await api()
    .post('/api/auth/reverse/start/phone')
    .set(auth(owner.accessToken))
    .send({ phone: '9000011111' });
  await relaySms({ from: '9000011111', text: started.body.code });

  const stolen = await api()
    .post('/api/auth/reverse/complete/phone')
    .set(auth(stranger.accessToken))
    .send({ token: started.body.token });

  assert.equal(stolen.status, 403);
  assert.equal((await User.findById(stranger.user._id)).phone, '9555544444');
});

test('a rejected phone-change attempt does not destroy the verification', async () => {
  const owner = await signedInCustomer('9876543210');
  const stranger = await signedInCustomer('9555544444');

  const started = await api()
    .post('/api/auth/reverse/start/phone')
    .set(auth(owner.accessToken))
    .send({ phone: '9000011111' });
  await relaySms({ from: '9000011111', text: started.body.code });

  // Someone else tries it first and is refused.
  const stolen = await api()
    .post('/api/auth/reverse/complete/phone')
    .set(auth(stranger.accessToken))
    .send({ token: started.body.token });
  assert.equal(stolen.status, 403);

  /**
   * The owner must still be able to use it. Consuming before checking ownership
   * would have spent the token on that refusal, so anyone who obtained a token
   * could destroy the verification without being able to use it.
   */
  const done = await api()
    .post('/api/auth/reverse/complete/phone')
    .set(auth(owner.accessToken))
    .send({ token: started.body.token });

  assert.equal(done.status, 200);
  assert.equal(done.body.user.phone, '9000011111');
});

test('a reverse token is single use', async () => {
  const reverse = await start({ phone: '9876543210', purpose: 'registration' });
  await relaySms({ from: '9876543210', text: reverse.code });

  const first = await api().post('/api/auth/register/verify').send({
    phoneToken: reverse.token,
    name: 'Asha Rao',
  });
  assert.equal(first.status, 201);

  // Spent. A second attempt cannot mint a duplicate account on the same number.
  const second = await api().post('/api/auth/register/verify').send({
    phoneToken: reverse.token,
  });
  assert.equal(second.status, 400);
});

test('two apps can verify the same unregistered number at once', async () => {
  const customer = await start({ phone: '9876543210', app: 'customer' });
  const shopkeeper = await start({ phone: '9876543210', app: 'shopkeeper' });

  /**
   * Both have `user: null` until an account exists, so a supersede scoped only
   * by phone and purpose would have killed the first when the second started —
   * leaving that screen waiting on a code the server had already retired.
   */
  assert.equal((await status(customer.token)).body.state, 'pending');
  assert.equal((await status(shopkeeper.token)).body.state, 'pending');
});

test('a login token cannot be redeemed as a phone change, or the reverse', async () => {
  const { accessToken } = await signedInCustomer('9876543210');

  const login = await start({ phone: '9111122222', app: 'customer' });
  await relaySms({ from: '9111122222', text: login.code });

  const crossed = await api()
    .post('/api/auth/reverse/complete/phone')
    .set(auth(accessToken))
    .send({ token: login.token });

  // Purpose is part of the consume filter, exactly as it is for outbound codes.
  assert.equal(crossed.status, 400);
});

// ---------------------------------------------------------------------------
// Registration — the reverse token replaces the phone leg only
// ---------------------------------------------------------------------------

test('registration completes with a reverse token instead of a phone code', async () => {
  const started = await api()
    .post('/api/auth/register/start')
    .send({ phone: '9876543210', name: 'Asha Rao' });
  assert.equal(started.status, 202);

  const reverse = await start({ phone: '9876543210', purpose: 'registration' });
  await relaySms({ from: '9876543210', text: reverse.code });

  const res = await api().post('/api/auth/register/verify').send({
    phoneToken: reverse.token,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.phone, '9876543210');
  assert.equal(res.body.user.phoneVerified, true, 'the number was proved, so it is the account phone');
});

test('the account is created for the number the token proved, not the one /start named', async () => {
  /**
   * There is nothing left to cross-check against.
   *
   * The old flow paired the reverse token with a phone carried in the EMAIL
   * challenge's payload, and refused a mismatch — otherwise a challenge proving
   * one number could be attached to a registration for another. With the email
   * leg gone the token is the only claim about a number there is, so it is the
   * whole answer: the account is created for what was actually proved, which is
   * exactly what a mismatch would have had to fall back to anyway.
   */
  await api().post('/api/auth/register/start').send({ phone: '9876543210', name: 'Asha Rao' });

  const reverse = await start({ phone: '9111122222', purpose: 'registration' });
  await relaySms({ from: '9111122222', text: reverse.code });

  const res = await api().post('/api/auth/register/verify').send({
    phoneToken: reverse.token,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.phone, '9111122222', 'the proved number, not the typed one');
  assert.equal(
    await User.countDocuments({ phone: '9876543210' }),
    0,
    'the number nobody proved gets no account'
  );
});

test('registration refuses an unverified reverse token', async () => {
  const started = await api()
    .post('/api/auth/register/start')
    .send({ phone: '9876543210', name: 'Asha Rao' });

  // Issued, but no message was ever sent.
  const reverse = await start({ phone: '9876543210', purpose: 'registration' });

  const res = await api().post('/api/auth/register/verify').send({
    phoneToken: reverse.token,
  });

  assert.equal(res.status, 400);
});

test('a customer registration token cannot mint a shopkeeper', async () => {
  const started = await api()
    .post('/api/auth/vendor/register/start')
    .send({ phone: '9876543210', name: 'Vendor' });

  // Raised for the customer sign-up flow, redeemed against the vendor one.
  const reverse = await start({ phone: '9876543210', purpose: 'registration' });
  await relaySms({ from: '9876543210', text: reverse.code });

  const res = await api().post('/api/auth/vendor/register/verify').send({
    phoneToken: reverse.token,
  });

  assert.equal(res.status, 400);
  assert.equal(await User.countDocuments({ role: 'shopkeeper' }), 0);
});

test('a registration cannot supply both phone legs at once', async () => {
  const started = await api()
    .post('/api/auth/register/start')
    .send({ phone: '9876543210', name: 'Asha Rao' });

  const reverse = await start({ phone: '9876543210', purpose: 'registration' });
  await relaySms({ from: '9876543210', text: reverse.code });

  const res = await api().post('/api/auth/register/verify').send({
    phoneChallengeId: started.body.phone.challengeId,
    phoneCode: started.body.devCodes.phone,
    phoneToken: reverse.token,
  });

  // Ambiguous about which leg proved the number, and would leave the reverse
  // token unspent and still redeemable elsewhere.
  assert.equal(res.status, 400);
});
