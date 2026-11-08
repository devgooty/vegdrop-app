/**
 * Which product — or which cart line — a spoken vegetable name means.
 *
 * `lib/voiceCommands.js` decides which words in a sentence were about a
 * vegetable; this decides which row on the sheet those words name. It is pure,
 * like the parser, so it is tested without a browser.
 *
 * It replaced a lookup in App.jsx that ran the spoken name through the search
 * box's `normalize()`, which keeps `[a-z0-9]` and nothing else. Every Telugu
 * and Devanagari name folded to an empty string, so:
 *
 * - **adding by voice in Telugu or Hindi found nothing, ever** — the
 *   recogniser listening in te-IN or hi-IN returns script, not romanisation;
 * - **removing by voice deleted the FIRST line in the cart**, whatever was
 *   asked for, because `"anything".includes("")` is true — and then said it
 *   had removed it.
 *
 * So the two rules this file exists to keep: every script is a name, and an
 * empty name matches nothing.
 */

/**
 * Words that describe a product rather than name it. "Fresh Potato" and
 * "Desi Tomatoes" are a potato and tomatoes, and leaving these in would make
 * a spoken "potato" a worse match for "Fresh Potato" than for "Sweet Potato".
 */
const DESCRIBING = new Set(['fresh', 'organic', 'desi', 'premium', 'natural', 'farm', 'local']);

const LATIN_WORD = /^[a-z0-9]+$/;

/**
 * Fold a name into comparable words, in any script.
 *
 * Latin accents go ("jalapeño"); Telugu vowel signs and Devanagari matras are
 * kept, because they are part of the letter, not decoration on it. Zero-width
 * joiners go because Telugu writes "బీట్‌రూట్" with or without one.
 */
export function spokenKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The English plural, folded to one form on BOTH sides.
 *
 * Not a real stemmer, and it does not need to be: it only has to map
 * "tomatoes" and "tomato" to the same string, and since the spoken word and
 * the catalog word go through it alike, "celery" → "celeri" is harmless.
 */
function stem(word) {
  if (!LATIN_WORD.test(word) || word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}i`;
  if (/(oes|ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('y')) return `${word.slice(0, -1)}i`;
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function words(value) {
  return spokenKey(value)
    .split(' ')
    .filter((word) => word && !DESCRIBING.has(word))
    .map(stem);
}

/**
 * Every name one row answers to.
 *
 * The catalog writes a second name in brackets — "Desi Tomatoes (Tamatar)" —
 * so the bracket is a name of its own, and so is the name without it. A
 * bracket holding a digit is a weight ("(500g)" on a cart line), not a name.
 */
function namesOf(row) {
  const name = String(row?.name ?? '');
  const brackets = [...name.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]).filter((inside) => !/\d/.test(inside));
  return [name, name.replace(/\([^)]*\)/g, ' '), ...brackets, row?.nameTe, row?.nameHi]
    .map(words)
    .filter((list) => list.length > 0);
}

/**
 * One spoken word and one catalog word are the same word.
 *
 * Latin compares after the plural fold. Telugu and Hindi carry case and number
 * as suffixes on the word itself — టమాటాలు is టమాటా plus a plural, and the
 * catalog's ఉల్లిపాయలు is the plural of a spoken ఉల్లిపాయ — so there one may be
 * the other plus a suffix, in either direction.
 */
function sameWord(a, b) {
  if (a === b) return true;
  if (LATIN_WORD.test(a) || LATIN_WORD.test(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * How well a spoken name fits one of a row's names — lower is better, null is
 * no fit at all.
 *
 * 0 is every word and nothing else. Otherwise it is every spoken word plus
 * however many words the name has beyond them, so "potato" fits "Potato" (0)
 * before "Sweet Potato" (1). A single word cut short is the loosest fit there
 * is, and only from the start of a word: "cauli" is cauliflower, "flower" is
 * not.
 */
function fit(spoken, name) {
  if (spoken.join('') === name.join('')) return 0;

  const used = new Set();
  const all = spoken.every((word) => {
    const index = name.findIndex((candidate, at) => !used.has(at) && sameWord(word, candidate));
    if (index === -1) return false;
    used.add(index);
    return true;
  });
  if (all) return name.length - spoken.length;

  if (spoken.length === 1) {
    const [word] = spoken;
    const partial = LATIN_WORD.test(word)
      ? word.length >= 4 && name.some((candidate) => candidate.startsWith(word))
      : word.length >= 3 && name.some((candidate) => candidate.includes(word));
    if (partial) return 50 + name.length;
  }
  return null;
}

/**
 * The best row for a spoken name, or null.
 *
 * Ties go to the row whose full English name is shortest — the more general
 * item, as search ranks "Mango" above "Mango Pickle" — and then to the row
 * listed first.
 */
function bestRow(spoken, rows) {
  const said = words(spoken);
  if (said.length === 0) return null;

  let best = null;
  for (const row of rows || []) {
    for (const name of namesOf(row)) {
      const score = fit(said, name);
      if (score == null) continue;
      const size = words(row.name).length;
      if (!best || score < best.score || (score === best.score && size < best.size)) {
        best = { row, score, size };
      }
    }
  }
  return best?.row ?? null;
}

/** The product on this sheet a spoken name means, or null. */
export function findSpokenProduct(spoken, products) {
  return bestRow(spoken, products);
}

/**
 * The cart line a spoken name means, or null.
 *
 * Lines carry `nameTe`/`nameHi` (App.jsx copies them in when a line is
 * added), so a removal spoken in Telugu finds the line the shopper is reading
 * in Telugu.
 */
export function findCartLine(spoken, lines) {
  return bestRow(spoken, lines);
}
