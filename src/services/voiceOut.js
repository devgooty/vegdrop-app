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

/**
 * Say something in the shopper's language.
 *
 * @returns {Promise<boolean>} true when the words were handed to a voice.
 */
export async function speak(text, language) {
  const sentence = String(text || '').trim();
  if (!sentence) return false;
  const locale = speechLocale(language);

  const cap = nativeSpeaker();
  if (cap) {
    try {
      const result = await cap.nativePromise(PLUGIN, 'speak', { text: sentence, locale });
      if (result?.spoken) return true;
    } catch {
      // No engine, or it is still starting. The browser path below is not
      // available inside the app, so this is simply a quiet answer.
      return false;
    }
    return false;
  }

  const engine = synth();
  if (!engine) return false;

  try {
    // Anything still being read is about a screen the shopper has left.
    engine.cancel();
    const utterance = new window.SpeechSynthesisUtterance(sentence);
    utterance.lang = locale;
    const voice = pickVoice(locale);
    if (voice) utterance.voice = voice;
    engine.speak(utterance);
    return true;
  } catch {
    return false;
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
