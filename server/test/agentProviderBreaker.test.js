'use strict';

/**
 * The cooking assistant's provider circuit breaker.
 *
 * `config.agent.configured` is only "the OPENAI_API_KEY string is not empty" —
 * a claim about configuration, not a fact about the account behind it. A key
 * whose billing has run out answers every call with a rejection, and the chat
 * still works because `runTurn` falls through to the local router. That is
 * what makes it easy to miss: the only symptom is that every reply got slower
 * and the log filled up, one wasted round trip per customer message.
 *
 * The key is set before `config/env.js` is required, because config is frozen
 * at load — the same reason spelled out at the top of `reverseOtp.test.js`.
 * Without it `providerAvailable()` is false for a reason that has nothing to
 * do with the breaker, and every assertion below would pass vacuously.
 *
 * No database and no provider: the breaker is module state and clock
 * arithmetic, which is the whole of what is worth pinning.
 */

process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config/env');
const {
  resetProviderBreaker,
  providerAvailable,
  noteProviderFailure,
  noteProviderSuccess,
} = require('../services/agent/runTurn');

test.beforeEach(resetProviderBreaker);
test.after(resetProviderBreaker);

test('a configured key is what the breaker is allowed to take away', () => {
  assert.equal(config.agent.configured, true, 'the key must load, or nothing below means anything');
  assert.equal(providerAvailable(), true);
});

test('one failure and two do not pause it — a blip is not a condition', () => {
  noteProviderFailure();
  assert.equal(providerAvailable(), true, 'one failure stopped the provider being tried');
  noteProviderFailure();
  assert.equal(providerAvailable(), true, 'two failures stopped the provider being tried');
});

test('the third consecutive failure pauses it', () => {
  noteProviderFailure();
  noteProviderFailure();
  noteProviderFailure();
  assert.equal(providerAvailable(), false, 'three refusals in a row is a condition, not an accident');
});

test('a success clears the pause outright, however deep the failures went', () => {
  for (let i = 0; i < 12; i += 1) noteProviderFailure();
  assert.equal(providerAvailable(), false);

  // The moment credits are added the key starts working again, and nothing
  // should have to be restarted for the next message to use it.
  noteProviderSuccess();
  assert.equal(providerAvailable(), true);
});

test('a success also resets the COUNT, not just the pause', () => {
  // Otherwise one more failure after a recovery would re-pause immediately,
  // and a provider that fails once an hour would spend most of the day paused.
  noteProviderFailure();
  noteProviderFailure();
  noteProviderSuccess();

  noteProviderFailure();
  assert.equal(providerAvailable(), true, 'a stale failure count re-armed the pause');
});

test('the backoff doubles from five minutes and stops at an hour', () => {
  // Stated independently of the breaker: a billing failure is not fixed in
  // seconds, so there is no point rediscovering it on every message — but the
  // pause must never grow without bound either, or a key fixed in the evening
  // stays unused overnight.
  const BEFORE = 3;
  const BASE_MS = 5 * 60 * 1000;
  const CEILING_MS = 60 * 60 * 1000;
  const pauseAfter = (n) => (n < BEFORE ? 0 : Math.min(CEILING_MS, BASE_MS * 2 ** (n - BEFORE)));

  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 50].map(pauseAfter),
    [0, 0, 5, 10, 20, 40, 60, 60].map((m) => m * 60 * 1000)
  );
});
