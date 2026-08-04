'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Sets NODE_ENV=test and the required secrets before config/env.js loads.
require('./helpers');

const { renderOtpEmail } = require('../services/templates/otpEmail');
const notify = require('../services/notify');

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

test('both parts carry the code, so a client that refuses HTML is not left empty', () => {
  const { text, html } = renderOtpEmail({ code: '482913', purpose: 'login', minutes: 5 });

  assert.match(text, /482913/);
  assert.match(html, /482913/);
});

test('the subject leads with the code, so it is readable from a notification', () => {
  const { subject } = renderOtpEmail({ code: '482913', purpose: 'login', minutes: 5 });

  assert.match(subject, /^482913/);
});

test('the expiry is stated in both parts and agrees with its unit', () => {
  const many = renderOtpEmail({ code: '111111', purpose: 'login', minutes: 5 });
  assert.match(many.text, /5 minutes/);
  assert.match(many.html, /5 minutes/);

  // "1 minutes" is the kind of thing that survives review precisely because it
  // is only ever seen on the one-minute path.
  const one = renderOtpEmail({ code: '111111', purpose: 'login', minutes: 1 });
  assert.match(one.text, /1 minute\b/);
  assert.doesNotMatch(one.text, /1 minutes/);
  assert.doesNotMatch(one.html, /1 minutes/);
});

test('both parts warn that support will never ask for the code', () => {
  const { text, html } = renderOtpEmail({ code: '482913', purpose: 'login', minutes: 5 });

  assert.match(text, /never ask you for this code/i);
  assert.match(html, /never ask you for this code/i);
});

/**
 * A display name is user-supplied and lands inside the markup. Without escaping
 * it is stored XSS with an email client as the sink.
 */
test('a display name containing markup is escaped, not interpolated', () => {
  const { html } = renderOtpEmail({
    code: '482913',
    purpose: 'login',
    minutes: 5,
    name: '<script>alert(1)</script>',
  });

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('an absent name falls back to an unnamed greeting rather than "Hi undefined"', () => {
  const { text, html } = renderOtpEmail({ code: '482913', purpose: 'registration', minutes: 5 });

  assert.match(text, /Hi there,/);
  assert.doesNotMatch(text, /undefined|null/);
  assert.doesNotMatch(html, /undefined|null/);
});

test('only the first name is used, so the greeting does not read like a form letter', () => {
  const { text } = renderOtpEmail({
    code: '482913',
    purpose: 'login',
    minutes: 5,
    name: 'Ramesh Kumar Reddy',
  });

  assert.match(text, /Hi Ramesh,/);
});

test('a shopkeeper signing in is told it is the merchant dashboard', () => {
  const merchant = renderOtpEmail({ code: '1', purpose: 'login', minutes: 5, role: 'shopkeeper' });
  const customer = renderOtpEmail({ code: '1', purpose: 'login', minutes: 5, role: 'customer' });

  assert.match(merchant.text, /merchant dashboard/i);
  assert.doesNotMatch(customer.text, /merchant dashboard/i);
});

test('each purpose reads as a sentence, and an unknown one still does', () => {
  assert.match(renderOtpEmail({ code: '1', purpose: 'registration', minutes: 5 }).text, /to create your VegDrop account/);
  assert.match(renderOtpEmail({ code: '1', purpose: 'phone_change', minutes: 5 }).text, /to move your VegDrop account/);
  // Never "to undefined your account".
  assert.match(renderOtpEmail({ code: '1', purpose: 'not_a_purpose', minutes: 5 }).text, /to verify your VegDrop account/);
});

// ---------------------------------------------------------------------------
// What each channel actually receives
// ---------------------------------------------------------------------------

function recordingTransport() {
  const sent = [];
  return {
    sent,
    transport: {
      name: 'recording',
      async send(message) {
        sent.push(message);
      },
    },
  };
}

test('an emailed code carries an HTML part alongside the text', async () => {
  const recorder = recordingTransport();
  notify.setTransport(recorder.transport);

  try {
    await notify.sendOtp({
      channel: 'email',
      to: 'customer@example.com',
      code: '482913',
      purpose: 'login',
      ttlSeconds: 300,
    });
  } finally {
    notify.setTransport(null);
  }

  const [message] = recorder.sent;
  assert.match(message.html, /482913/);
  assert.match(message.text, /482913/);
});

/**
 * The phone channel is a notification preview, and WhatsApp's template takes
 * only the code. Markup there is at best ignored and at worst printed raw.
 */
test('a phone code carries no HTML at all', async () => {
  const recorder = recordingTransport();
  notify.setTransport(recorder.transport);

  try {
    await notify.sendOtp({
      channel: 'sms',
      to: '9000000001',
      code: '482913',
      purpose: 'login',
      ttlSeconds: 300,
    });
  } finally {
    notify.setTransport(null);
  }

  const [message] = recorder.sent;
  assert.equal(message.html, undefined);
  assert.match(message.text, /482913/);
  // One line, not the inbox copy.
  assert.doesNotMatch(message.text, /Hi there,/);
});
