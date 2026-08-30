import { buildSuggestions, normalize } from './search';

/**
 * Voice search — turn a spoken phrase into the same suggestion a typed
 * query would have produced.
 *
 * SpeechRecognition is a browser API and it is noisy: it trails a period,
 * it prefixes "search for", and it offers a few guesses. This module is the
 * one place that folds those into a catalog match, so Header only has to
 * start the recogniser and then `pick` whatever comes back.
 */

export function speechRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechLocale(language) {
  if (language === 'hi') return 'hi-IN';
  if (language === 'te') return 'te-IN';
  return 'en-IN';
}

/**
 * Chrome's recogniser must be created and `start()`ed in the same tap that
 * opened the panel. Starting it from a `useEffect` (or after `getUserMedia`)
 * drops the user-activation token; Chrome then reports `network` even when
 * the phone is online. StrictMode abort-and-restart does the same.
 */
export function createSpeechRecognition(language) {
  const SpeechRecognition = speechRecognitionCtor();
  if (!SpeechRecognition) return null;
  const recognition = new SpeechRecognition();
  recognition.lang = speechLocale(language);
  recognition.interimResults = true;
  recognition.maxAlternatives = 5;
  recognition.continuous = false;
  return recognition;
}

/**
 * Map a SpeechRecognition error name to the overlay status.
 *
 * `network` is not "the device is offline". Chrome uses that name for a
 * failed handshake with its speech service — including a start() that
 * missed the tap, and a session that was aborted and immediately restarted.
 * Only show the offline copy when the browser itself reports offline.
 */
export function mapSpeechError(error, { online = true } = {}) {
  if (error === 'aborted') return null;
  if (error === 'no-speech') return 'nospeech';
  if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture') {
    return 'permission';
  }
  if (error === 'network') return online ? 'nospeech' : 'network';
  return 'failed';
}

/**
 * Strip the things a shopper says around the produce, not the produce itself.
 *
 * "Search for lettuce." and "I want palak" have to become the same query the
 * typed box would have sent, or voice would miss matches the keyboard finds.
 */
export function cleanTranscript(value) {
  return String(value ?? '')
    .replace(/[.?!,…]+/g, ' ')
    .replace(
      /^(please\s+)?(search for|search|find me|find|show me|show|i want|i need|looking for|look for)\s+/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pick the spoken guess that best matches this market's sheet.
 *
 * Alternatives are tried in the order the recogniser ranked them. An exact
 * or prefix catalog hit wins over a later guess, even if the later one was
 * the recogniser's favourite — "lettuce" beating "let us" is the point.
 */
export function resolveVoiceQuery({ transcripts = [], products = [], categories = [] } = {}) {
  const cleaned = [...new Set(transcripts.map(cleanTranscript).filter((text) => text.length >= 2))];
  if (cleaned.length === 0) return { query: '', suggestion: null };

  let best = null;

  for (const query of cleaned) {
    const suggestions = buildSuggestions({ products, categories, query, limit: 3 });
    const top = suggestions[0];
    if (!top) continue;

    const exact = normalize(top.label) === normalize(query);
    const candidate = { query, suggestion: top, rank: exact ? -1 : top.rank };
    if (!best || candidate.rank < best.rank) best = candidate;
    if (candidate.rank < 0) break;
  }

  return {
    query: best?.query || cleaned[0],
    suggestion: best?.suggestion || null,
  };
}
