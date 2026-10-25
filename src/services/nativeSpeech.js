/**
 * The Android app's microphone (android/…/SpeechPlugin.java).
 *
 * `SpeechRecognition` is a browser API, and Android's WebView does not
 * implement it — so every voice feature on this site reaches the overlay's
 * `unsupported` state inside the APK while working in Chrome. This module
 * wraps the native recogniser in the SAME interface the browser object has,
 * so `Header`, `VoiceListSession` and the assistant need no branch of their
 * own: `createSpeechRecognition` hands back whichever one exists.
 *
 * Reached through the bridge Capacitor injects into the page rather than an
 * npm package, exactly as `nativeLocation.js` is — the app loads this site
 * from its live URL, so a native change ships only in a new APK while the
 * page itself keeps deploying normally.
 */

const PLUGIN = 'VegDropSpeech';

function bridge() {
  return typeof window === 'undefined' ? null : window.Capacitor || null;
}

/** True only inside the Android app, on a build that has the plugin. */
export function hasNativeSpeech() {
  const cap = bridge();
  return Boolean(
    cap?.nativePromise &&
      typeof cap.addListener === 'function' &&
      Array.isArray(cap.PluginHeaders) &&
      cap.PluginHeaders.some((plugin) => plugin.name === PLUGIN)
  );
}

/**
 * One spoken guess, shaped like a `SpeechRecognitionAlternative`.
 *
 * `confidence` is 0 because Android's `SpeechRecognizer` does not report one
 * per alternative. Nothing in this app reads it — the catalog match decides
 * which guess wins (`resolveVoiceQuery`) — but the field is present so a
 * reader of the shim is not misled about what the platform gives us.
 */
function alternative(transcript) {
  return { transcript, confidence: 0 };
}

/**
 * Build a `SpeechRecognitionResultList`-shaped event.
 *
 * The browser's `results` is CUMULATIVE across a session and `resultIndex`
 * names the first entry that changed. Both consumers depend on that: Header
 * reads the last entry, and `VoiceListSession` iterates from `resultIndex`.
 * So a partial replaces a partial already standing, and a final appends.
 */
function pushResult(results, transcripts, isFinal) {
  const result = transcripts.map(alternative);
  result.isFinal = isFinal;

  const last = results.length - 1;
  if (last >= 0 && !results[last].isFinal) {
    results[last] = result;
    return last;
  }
  results.push(result);
  return results.length - 1;
}

/**
 * A native-backed stand-in for a `SpeechRecognition` object.
 *
 * Only the surface this app uses is implemented. Two differences from the
 * browser object are deliberate and both are absorbed here:
 *
 * - **`start()` is asynchronous natively** (it may have to ask for the
 *   microphone permission first), while the browser's throws synchronously.
 *   A rejected start is reported through `onerror` + `onend` instead, which
 *   is the path the call sites already handle.
 * - **`onend` is guaranteed exactly once.** The plugin emits `speechEnd`
 *   after a result or an error, but a permission refusal resolves no session
 *   at all, so the shim closes the session itself rather than leaving an
 *   overlay waiting on an event that is not coming.
 */
export function createNativeSpeechRecognition() {
  const cap = bridge();

  const recognition = {
    lang: 'en-IN',
    interimResults: true,
    maxAlternatives: 5,
    continuous: false,
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    start,
    stop,
    abort,
  };

  let listeners = [];
  let results = [];
  let running = false;
  let ended = false;

  function detach() {
    const open = listeners;
    listeners = [];
    // `remove()` is async in the injected bridge; nothing waits on it, and a
    // failure to unregister must not surface as an unhandled rejection.
    for (const listener of open) Promise.resolve(listener?.remove?.()).catch(() => {});
  }

  /** Close the session once, whatever closed it. */
  function finish() {
    if (ended) return;
    ended = true;
    running = false;
    detach();
    recognition.onend?.(new Event('end'));
  }

  function fail(name) {
    if (ended) return;
    recognition.onerror?.({ error: name });
    finish();
  }

  function attach() {
    listeners = [
      cap.addListener(PLUGIN, 'speechStart', () => {
        if (!ended) recognition.onstart?.(new Event('start'));
      }),
      cap.addListener(PLUGIN, 'speechResult', (payload) => {
        if (ended) return;
        const transcripts = (payload?.transcripts || []).filter(
          (text) => typeof text === 'string' && text.trim()
        );
        if (transcripts.length === 0) return;
        const isFinal = Boolean(payload?.isFinal);
        if (!isFinal && !recognition.interimResults) return;
        const resultIndex = pushResult(results, transcripts, isFinal);
        recognition.onresult?.({ results, resultIndex });
      }),
      cap.addListener(PLUGIN, 'speechError', (payload) => {
        fail(payload?.error || 'failed');
      }),
      cap.addListener(PLUGIN, 'speechEnd', () => finish()),
    ];
  }

  function start() {
    if (running) throw new Error('Speech recognition is already started.');
    running = true;
    ended = false;
    results = [];
    attach();

    cap
      .nativePromise(PLUGIN, 'start', {
        locale: recognition.lang,
        partialResults: recognition.interimResults,
        maxAlternatives: recognition.maxAlternatives,
      })
      // A rejection the plugin did not already describe (no recogniser on the
      // device, a bridge fault). `fail` is a no-op once an error event landed.
      .catch(() => fail('failed'));
  }

  function stop() {
    if (!running) return;
    cap.nativePromise(PLUGIN, 'stop', {}).catch(() => fail('failed'));
  }

  function abort() {
    // Detach first: the call sites drop their reference before aborting, and
    // a trailing `onend` for a session nobody is watching is noise.
    ended = true;
    running = false;
    detach();
    cap.nativePromise(PLUGIN, 'abort', {}).catch(() => {});
  }

  return recognition;
}
