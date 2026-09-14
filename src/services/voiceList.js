import { cleanTranscript, resolveVoiceQuery } from './voiceSearch';

/**
 * Dictating a shopping list one item at a time.
 *
 * The notepad's "Say it" used to take one utterance and close, so a list of
 * six things meant opening the mic six times. `VoiceListSession` now keeps
 * listening, asks for the next item after each one, and ends when the shopper
 * taps OK. This module is the part of that which has nothing to do with the
 * microphone: deciding what an utterance means.
 *
 * An utterance is one of three things:
 *  - an item, or several said as a run-on ("tomato and onion");
 *  - the shopper saying they are finished, which does what OK does;
 *  - filler said between items ("next", "and"), which adds nothing.
 */

/**
 * Whole-utterance matches only. "ok" must not swallow "okra", so these are
 * anchored at both ends rather than searched for. Hindi and Telugu arrive in
 * their own scripts from the hi-IN / te-IN recognisers, so both spellings are
 * listed.
 */
const DONE_PHRASES = new Set([
  'ok',
  'okay',
  'done',
  'finish',
  'finished',
  "that's it",
  'thats it',
  "that's all",
  'thats all',
  'that is all',
  'no more',
  'nothing else',
  'bas',
  'bas itna',
  'ho gaya',
  'बस',
  'बस इतना',
  'हो गया',
  'ठीक है',
  'ayipoyindi',
  'aipoyindi',
  'chalu',
  'అయిపోయింది',
  'చాలు',
  'సరే',
]);

const FILLER_PHRASES = new Set(['next', 'next item', 'and', 'then', 'also', 'aur', 'और', 'inka', 'ఇంకా']);

/** Lower-cased, punctuation-free, single-spaced — but, unlike search's `normalize`, not Latin-only. */
function spokenKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[.?!,…।]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isDonePhrase(text) {
  return DONE_PHRASES.has(spokenKey(text));
}

/**
 * "milk, bread and eggs" is three items. Asked for one at a time, people still
 * say two at once often enough that dropping the second would lose it.
 */
export function splitIntoItems(text) {
  return String(text ?? '')
    .split(/,| and |\s&\s| और /gi)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What one finished utterance adds to the list.
 *
 * @param {string[]} alternatives  the recogniser's guesses, best first
 * @param {{products?: object[], categories?: object[]}} catalog
 * @returns {{done: boolean, items: string[]}}
 */
export function parseSpokenList(alternatives = [], { products = [], categories = [] } = {}) {
  const heard = alternatives.map((a) => String(a ?? '').trim()).filter(Boolean);
  if (heard.length === 0) return { done: false, items: [] };

  if (isDonePhrase(heard[0])) return { done: true, items: [] };

  const parts = splitIntoItems(heard[0]);

  // One item — the usual case, since the screen asks for one. Every guess is
  // then a guess at the same thing, so the one this market actually sells is
  // taken: "lettuce" over "let us", exactly as the header's voice search does.
  // With several, the guesses split differently and cannot be lined up, so each
  // part is taken as heard.
  const items =
    parts.length === 1
      ? [resolveVoiceQuery({ transcripts: heard, products, categories }).query]
      : parts.map((part) => cleanTranscript(part));

  return {
    done: false,
    items: items.filter((item) => item && !FILLER_PHRASES.has(spokenKey(item))),
  };
}

/** Appends what was just said, skipping anything already on the list. Order is the order spoken. */
export function mergeItems(existing, incoming) {
  const seen = new Set(existing.map(spokenKey));
  const next = [...existing];
  for (const item of incoming) {
    const key = spokenKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export { spokenKey };
