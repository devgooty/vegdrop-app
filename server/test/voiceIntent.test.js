'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeSpokenIntent, SPOKEN_INTENTS, MAX_QUANTITY } = require('../services/agent/voiceIntent');

/**
 * The gate between a model's free-form output and a handler that changes a
 * cart.
 *
 * No database and no provider: this is a pure function, and it is the only
 * thing that decides whether something a model invented is allowed to reach
 * the rest of the app. Every case here is a shape a model can actually
 * produce — a renamed intent, a quantity with an extra digit, a list that
 * never ends — rather than a well-formed example.
 */

test('a well-formed command passes through', () => {
  assert.deepEqual(
    sanitizeSpokenIntent({ intent: 'navigate', target: 'cart', reply: 'Opening your cart.' }),
    { intent: 'navigate', target: 'cart', reply: 'Opening your cart.' }
  );
});

test('items keep their name and count', () => {
  assert.deepEqual(
    sanitizeSpokenIntent({
      intent: 'add_item',
      items: [{ name: 'tomato', quantity: 2 }, { name: 'onion', quantity: 1 }],
      reply: 'Added.',
    }),
    {
      intent: 'add_item',
      items: [{ name: 'tomato', quantity: 2 }, { name: 'onion', quantity: 1 }],
      reply: 'Added.',
    }
  );
});

test('payment can never come back as an action', () => {
  // The model is never told this name exists, but a model that invents it must
  // still reach the shopper as conversation and move no money.
  for (const intent of ['payment', 'checkout', 'place_order', 'pay']) {
    assert.equal(sanitizeSpokenIntent({ intent, reply: 'Paying now.' }).intent, 'chat');
  }
});

test('an intent nobody defined becomes chat', () => {
  assert.equal(sanitizeSpokenIntent({ intent: 'delete_account' }).intent, 'chat');
  assert.equal(sanitizeSpokenIntent({ intent: '' }).intent, 'chat');
  assert.equal(sanitizeSpokenIntent({}).intent, 'chat');
  assert.equal(sanitizeSpokenIntent(null).intent, 'chat');
  assert.equal(sanitizeSpokenIntent('navigate').intent, 'chat');
});

test('a screen nobody has becomes chat, not a dead navigation', () => {
  assert.equal(sanitizeSpokenIntent({ intent: 'navigate', target: 'settings' }).intent, 'chat');
  assert.equal(sanitizeSpokenIntent({ intent: 'navigate' }).intent, 'chat');
});

test('a misheard count cannot fill a basket', () => {
  // "two" heard as "two hundred" is the one way an understanding mistake could
  // still cost money, so it is clamped where the value first arrives.
  const out = sanitizeSpokenIntent({ intent: 'add_item', items: [{ name: 'tomato', quantity: 200 }] });
  assert.equal(out.items[0].quantity, MAX_QUANTITY);
});

test('a missing or nonsense count is one, never zero', () => {
  const cases = [{ name: 'okra' }, { name: 'okra', quantity: 0 }, { name: 'okra', quantity: -4 }, { name: 'okra', quantity: 'two' }];
  for (const item of cases) {
    const out = sanitizeSpokenIntent({ intent: 'add_item', items: [item] });
    assert.equal(out.items[0].quantity, 1, `quantity for ${JSON.stringify(item)}`);
  }
});

test('a fractional count is rounded, not dropped', () => {
  const out = sanitizeSpokenIntent({ intent: 'add_item', items: [{ name: 'tomato', quantity: 2.6 }] });
  assert.equal(out.items[0].quantity, 3);
});

test('an endless list is cut short', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ name: `veg${i}`, quantity: 1 }));
  const out = sanitizeSpokenIntent({ intent: 'add_item', items });
  assert.ok(out.items.length <= 8, `kept ${out.items.length}`);
});

test('an add with nothing to add is chat', () => {
  assert.equal(sanitizeSpokenIntent({ intent: 'add_item', items: [] }).intent, 'chat');
  assert.equal(sanitizeSpokenIntent({ intent: 'add_item' }).intent, 'chat');
  assert.equal(sanitizeSpokenIntent({ intent: 'remove_item', items: [{ name: '   ' }] }).intent, 'chat');
});

test('a runaway reply is cut to something speakable', () => {
  const out = sanitizeSpokenIntent({ intent: 'read_cart', reply: 'x'.repeat(5000) });
  assert.ok(out.reply.length <= 200, `reply was ${out.reply.length}`);
});

test('a non-string reply does not become "undefined" out loud', () => {
  assert.equal(sanitizeSpokenIntent({ intent: 'read_cart', reply: { a: 1 } }).reply, '');
  assert.equal(sanitizeSpokenIntent({ intent: 'read_cart' }).reply, '');
});

test('every allowed intent survives, and chat is one of them', () => {
  assert.ok(SPOKEN_INTENTS.includes('chat'));
  assert.ok(!SPOKEN_INTENTS.includes('payment'));
  for (const intent of SPOKEN_INTENTS) {
    const seed = intent === 'navigate'
      ? { intent, target: 'home' }
      : intent === 'add_item' || intent === 'remove_item'
        ? { intent, items: [{ name: 'tomato' }] }
        : { intent };
    assert.equal(sanitizeSpokenIntent(seed).intent, intent);
  }
});
