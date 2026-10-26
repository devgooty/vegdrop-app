import { speechLocale } from './voiceSearch';

/**
 * The agent's voice.
 *
 * Speaking is half of a voice agent, and it is the half with no guaranteed
 * home: `speechSynthesis` is a browser API that Android's WebView does not
 * implement, exactly like `SpeechRecognition`. So this resolves the native
 * engine first inside the app (`SpeechPlugin.speak`) and the browser's
 * otherwise, and reports honestly when neither can say a sentence.
 *
 * **A sentence that cannot be spoken must still be readable.** Telugu and
 * Hindi voices are downloaded packs and plenty of handsets hold neither, so
 * `speak()` resolving `false` is an ordinary outcome, not an error: the caller
 * shows the same words as text, which is a complete answer. Treating it as a
 * failure would make the feature look broken on a phone that is merely quiet.
 */

const PLUGIN = 'VegDropSpeech';

function bridge() {
  return typeof window === 'undefined' ? null : window.Capacitor || null;
}

function nativeSpeaker() {
  const cap = bridge();
  const has =
    cap?.nativePromise &&
    Array.isArray(cap.PluginHeaders) &&
    cap.PluginHeaders.some((plugin) => plugin.name === PLUGIN);
  return has ? cap : null;
}

function synth() {
  return typeof window === 'undefined' ? null : window.speechSynthesis || null;
}

/** Whether anything on this device can say a sentence out loud. */
export function canSpeak() {
  return Boolean(nativeSpeaker() || synth());
}

/**
 * Pick a voice for this language, falling back to the bare language.
 *
 * `getVoices()` is empty until the browser has loaded them, which it does
 * asynchronously and without a reliable event in every engine — so a missing
 * voice is not an error either. Left unset, the utterance's own `lang` is
 * what the engine matches on, which is the right default.
 */
function pickVoice(locale) {
  const voices = synth()?.getVoices?.() || [];
  const base = locale.split('-')[0];
  return (
    voices.find((voice) => voice.lang?.replace('_', '-') === locale) ||
    voices.find((voice) => voice.lang?.startsWith(base)) ||
    null
  );
}

/** A hung bridge call must not look the same as a phone that is merely quiet. */
const SPEAK_TIMEOUT_MS = 4000;

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ spoken: false, reason: 'timeout' }), SPEAK_TIMEOUT_MS)),
  ]);
}

/**
 * Say something in the shopper's language.
 *
 * Returns WHY it stayed quiet, not just that it did. Silence has several
 * causes a shopper can act on — no voice installed for this language, media
 * volume at zero, no speech engine at all — and they are indistinguishable
 * from a broken feature unless the app says which one it was. The caller puts
 * that line on screen under the answer.
 *
 * @returns {Promise<{ spoken: boolean, reason: string|null }>}
 */
export async function speak(text, language) {
  const sentence = String(text || '').trim();
  if (!sentence) return { spoken: false, reason: null };
  const locale = speechLocale(language);

  const cap = nativeSpeaker();
  if (cap) {
    try {
      const result = await withTimeout(cap.nativePromise(PLUGIN, 'speak', { text: sentence, locale }));
      if (result?.spoken) return { spoken: true, reason: null };
      return { spoken: false, reason: result?.reason || 'engine' };
    } catch {
      // The plugin rejected: no speech engine on the device, or it could not
      // be started. The browser path below does not exist inside the app.
      return { spoken: false, reason: 'engine' };
    }
  }

  const engine = synth();
  if (!engine) return { spoken: false, reason: 'engine' };

  try {
    // Anything still being read is about a screen the shopper has left.
    engine.cancel();
    const utterance = new window.SpeechSynthesisUtterance(sentence);
    utterance.lang = locale;
    const voice = pickVoice(locale);
    if (voice) utterance.voice = voice;
    engine.speak(utterance);
    return { spoken: true, reason: null };
  } catch {
    return { spoken: false, reason: 'engine' };
  }
}

/** Stop mid-sentence — the shopper said something else, or said "stop". */
export function stopSpeaking() {
  const cap = nativeSpeaker();
  if (cap) {
    cap.nativePromise(PLUGIN, 'stopSpeaking', {}).catch(() => {});
    return;
  }
  try {
    synth()?.cancel();
  } catch {
    // Nothing was being said.
  }
}
