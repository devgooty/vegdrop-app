'use strict';

const config = require('../../config/env');
const { SPOKEN_INTENTS } = require('./voiceIntentShape');

/**
 * What a spoken sentence MEANT, decided by the model.
 *
 * The keyword table in `src/lib/voiceCommands.js` answers instantly and
 * offline, and it stays the first thing tried. This is what the phrasings it
 * does not recognise reach — the half of the problem a table cannot solve,
 * because people do not say "add two kg tomato", they say "tomato konchem
 * veyyi" and "put a couple of kilos of those tomatoes in".
 *
 * **The model decides what was meant. It never decides what happens.** It
 * returns a name from a fixed list and the vegetables it heard; the app then
 * runs the same handler a tap runs, under the same mode ceiling, through the
 * same catalog lookup and the same pack arithmetic. So a wrong answer from the
 * model is a wrong *screen*, never a wrong *price* — and `payment` is not in
 * the list it may return at all.
 *
 * Quantities are capped here as well as on the client. A misheard "two" that
 * comes back as 200 is the one way an understanding mistake could still cost
 * somebody money, so it is clamped where the untrusted value first arrives.
 */

const MAX_QUANTITY = 10;
const MAX_ITEMS = 8;
const MAX_REPLY = 200;

const LANGUAGE_NAMES = { en: 'English', hi: 'Hindi', te: 'Telugu' };

function systemPrompt(language, screen) {
  const lines = [
    'You convert ONE spoken sentence from a grocery shopper into a single JSON object.',
    'You are not a chat assistant here. Answer with JSON only.',
    '',
    'Fields:',
    '  intent  - exactly one of: ' + SPOKEN_INTENTS.join(', '),
    '  target  - only for navigate: home, prices, cook, cart, orders, account, offers, search',
    '  items   - only for add_item / remove_item: [{ "name": "<vegetable, singular, English>", "quantity": <1-10> }]',
    '  reply   - one short sentence, spoken aloud, in ' + (LANGUAGE_NAMES[language] || 'English'),
    '',
    'Rules that matter:',
    '  - A refusal is a removal. "I do not want tomato", "tomato vaddu" -> remove_item.',
    '  - Naming a screen is not asking to go there. "what is the tomato price" is chat, not navigate.',
    '  - Anything about cooking, recipes, dishes or what to make is "chat". Do not answer it yourself.',
    '  - Anything you are not sure about is "chat". A wrong command is worse than a handover.',
    '  - Never return an intent about paying, checkout or placing an order. Those are "chat".',
    '  - items carry the vegetable name in ENGLISH even when the shopper spoke Telugu or Hindi,',
    '    because the catalog is in English. "vankaya" -> "brinjal", "aloo" -> "potato".',
    '  - quantity is a count of packs. If none was said, use 1.',
  ];

  if (screen && typeof screen === 'object') {
    const where = [];
    if (screen.tab) where.push(`tab=${screen.tab}`);
    if (screen.productName) where.push(`looking at ${screen.productName}`);
    if (Number.isFinite(screen.cartCount)) where.push(`${screen.cartCount} lines in the cart`);
    if (where.length) {
      lines.push('', `The shopper is on: ${where.join(', ')}. Use this only to resolve "this" and "here".`);
    }
  }

  return lines.join('\n');
}

/**
 * Pull a usable command out of whatever the model returned.
 *
 * Exported and pure, because this is the only thing standing between a model's
 * free-form output and a handler that changes a cart: an unknown intent, a
 * quantity of 500, twenty items or a `payment` that slipped through all have to
 * become `chat` here rather than being discovered downstream.
 */
function sanitizeSpokenIntent(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const chat = (reply) => ({ intent: 'chat', reply: reply || '' });

  const reply = typeof value.reply === 'string' ? value.reply.trim().slice(0, MAX_REPLY) : '';
  const intent = typeof value.intent === 'string' ? value.intent.trim().toLowerCase() : '';
  if (!SPOKEN_INTENTS.includes(intent) || intent === 'chat') return chat(reply);

  if (intent === 'navigate') {
    const targets = ['home', 'prices', 'cook', 'cart', 'orders', 'account', 'offers', 'search'];
    const target = typeof value.target === 'string' ? value.target.trim().toLowerCase() : '';
    if (!targets.includes(target)) return chat(reply);
    return { intent, target, reply };
  }

  if (intent === 'add_item' || intent === 'remove_item') {
    const items = (Array.isArray(value.items) ? value.items : [])
      .slice(0, MAX_ITEMS)
      .map((item) => {
        const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 60) : '';
        const asked = Number(item?.quantity);
        // Clamped, not rejected: a misheard count should still buy something
        // sensible, and the shopper sees what landed in the cart either way.
        const quantity = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.round(asked), MAX_QUANTITY) : 1;
        return { name, quantity };
      })
      .filter((item) => item.name);
    if (items.length === 0) return chat(reply);
    return { intent, items, reply };
  }

  return { intent, reply };
}

/**
 * Ask the model what one spoken sentence meant.
 *
 * Returns `{ intent: 'chat' }` whenever there is no provider, the call fails,
 * or the answer cannot be trusted — the caller then hands the sentence to the
 * cooking assistant, which is where an unrecognised sentence already went. So
 * this failing degrades the feature to exactly what it was before, never to an
 * error in front of the shopper.
 */
async function classifySpoken(utterance, { language = 'en', screen = null } = {}) {
  const said = String(utterance || '').trim();
  if (!said) return { intent: 'chat', reply: '' };
  if (!config.agent.configured || config.isTest) return { intent: 'chat', reply: '' };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.agent.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.agent.model,
        // Near-zero: this is a classification, and the same sentence twice
        // must not mean two different things to the cart.
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt(language, screen) },
          { role: 'user', content: said.slice(0, 500) },
        ],
      }),
    });

    if (!response.ok) {
      console.warn('[voice] provider error', response.status);
      return { intent: 'chat', reply: '' };
    }

    const body = await response.json().catch(() => null);
    const content = body?.choices?.[0]?.message?.content;
    if (!content) return { intent: 'chat', reply: '' };

    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { intent: 'chat', reply: '' };
    }
    return sanitizeSpokenIntent(parsed);
  } catch (err) {
    console.warn('[voice] classify failed', err?.message);
    return { intent: 'chat', reply: '' };
  }
}

module.exports = { classifySpoken, sanitizeSpokenIntent, SPOKEN_INTENTS, MAX_QUANTITY };
