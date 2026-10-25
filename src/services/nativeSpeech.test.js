import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNativeSpeechRecognition, hasNativeSpeech } from './nativeSpeech';
import { createSpeechRecognition } from './voiceSearch';

/**
 * The native microphone wearing the browser's interface.
 *
 * What is worth pinning is the SHAPE the call sites read, not the plugin:
 * `Header` takes the last entry of a cumulative `results`, and
 * `VoiceListSession` iterates from `resultIndex` and calls `Array.from` over
 * each result. A shim that got either wrong would look like a silent mic.
 */

/** A stand-in for the bridge Capacitor injects into the page. */
function fakeBridge({ startRejects = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const removed = [];

  return {
    cap: {
      PluginHeaders: [{ name: 'VegDropSpeech' }],
      nativePromise: (plugin, method) => {
        calls.push(method);
        if (method === 'start' && startRejects) return Promise.reject(new Error('no mic'));
        return Promise.resolve({});
      },
      addListener: (plugin, event, callback) => {
        handlers.set(event, callback);
        return { remove: () => { removed.push(event); return Promise.resolve(); } };
      },
    },
    emit: (event, payload) => handlers.get(event)?.(payload),
    listening: () => handlers.size > 0,
    calls,
    removed,
  };
}

let bridge;

beforeEach(() => {
  bridge = fakeBridge();
  globalThis.window = { Capacitor: bridge.cap };
});

afterEach(() => {
  delete globalThis.window;
  vi.restoreAllMocks();
});

describe('hasNativeSpeech', () => {
  it('is false in a plain browser', () => {
    globalThis.window = {};
    expect(hasNativeSpeech()).toBe(false);
  });

  it('is false on an older APK that has no speech plugin', () => {
    globalThis.window = {
      Capacitor: { nativePromise: () => {}, addListener: () => {}, PluginHeaders: [{ name: 'VegDropLocation' }] },
    };
    expect(hasNativeSpeech()).toBe(false);
  });

  it('is true inside the app', () => {
    expect(hasNativeSpeech()).toBe(true);
  });
});

describe('createSpeechRecognition', () => {
  it('falls through to the native recogniser when the browser has none', () => {
    const recognition = createSpeechRecognition('te');
    expect(recognition).not.toBeNull();
    expect(recognition.lang).toBe('te-IN');
  });

  it('is still null where neither exists', () => {
    globalThis.window = {};
    expect(createSpeechRecognition('en')).toBeNull();
  });

  it('prefers the browser API where both exist', () => {
    class Browser {}
    globalThis.window = { Capacitor: bridge.cap, SpeechRecognition: Browser };
    expect(createSpeechRecognition('hi')).toBeInstanceOf(Browser);
  });
});

describe('results', () => {
  it('replaces a standing partial and appends a final', () => {
    const recognition = createNativeSpeechRecognition();
    const seen = [];
    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      seen.push({
        index: event.resultIndex,
        length: event.results.length,
        text: last[0].transcript,
        isFinal: last.isFinal,
      });
    };
    recognition.start();

    bridge.emit('speechResult', { transcripts: ['toma'], isFinal: false });
    bridge.emit('speechResult', { transcripts: ['tomato'], isFinal: false });
    bridge.emit('speechResult', { transcripts: ['tomato', 'tomahto'], isFinal: true });
    bridge.emit('speechResult', { transcripts: ['onion'], isFinal: true });

    expect(seen).toEqual([
      { index: 0, length: 1, text: 'toma', isFinal: false },
      { index: 0, length: 1, text: 'tomato', isFinal: false },
      { index: 0, length: 1, text: 'tomato', isFinal: true },
      { index: 1, length: 2, text: 'onion', isFinal: true },
    ]);
  });

  it('gives VoiceListSession an alternatives list it can read', () => {
    const recognition = createNativeSpeechRecognition();
    let alternatives = null;
    recognition.onresult = (event) => {
      const result = event.results[event.resultIndex];
      alternatives = Array.from(result, (one) => one.transcript);
    };
    recognition.start();
    bridge.emit('speechResult', { transcripts: ['let us', 'lettuce'], isFinal: true });
    expect(alternatives).toEqual(['let us', 'lettuce']);
  });

  it('drops partials when the caller asked for none', () => {
    const recognition = createNativeSpeechRecognition();
    recognition.interimResults = false;
    const seen = [];
    recognition.onresult = (event) => seen.push(event.results[event.resultIndex].isFinal);
    recognition.start();
    bridge.emit('speechResult', { transcripts: ['toma'], isFinal: false });
    bridge.emit('speechResult', { transcripts: ['tomato'], isFinal: true });
    expect(seen).toEqual([true]);
  });

  it('ignores an empty transcript list', () => {
    const recognition = createNativeSpeechRecognition();
    const seen = vi.fn();
    recognition.onresult = seen;
    recognition.start();
    bridge.emit('speechResult', { transcripts: [], isFinal: true });
    bridge.emit('speechResult', { transcripts: ['   '], isFinal: true });
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('the session ends exactly once', () => {
  it('reports an error and then ends', () => {
    const recognition = createNativeSpeechRecognition();
    const errors = [];
    const ends = vi.fn();
    recognition.onerror = (event) => errors.push(event.error);
    recognition.onend = ends;
    recognition.start();

    bridge.emit('speechError', { error: 'not-allowed' });
    // The plugin sends both after a failure; the overlay must not be closed
    // twice, and a late error must not reopen a finished session.
    bridge.emit('speechEnd', {});
    bridge.emit('speechError', { error: 'network' });

    expect(errors).toEqual(['not-allowed']);
    expect(ends).toHaveBeenCalledTimes(1);
  });

  it('ends after a final result', () => {
    const recognition = createNativeSpeechRecognition();
    const ends = vi.fn();
    recognition.onend = ends;
    recognition.start();
    bridge.emit('speechResult', { transcripts: ['tomato'], isFinal: true });
    bridge.emit('speechEnd', {});
    expect(ends).toHaveBeenCalledTimes(1);
  });

  it('reports a start the plugin refused', async () => {
    bridge = fakeBridge({ startRejects: true });
    globalThis.window = { Capacitor: bridge.cap };

    const recognition = createNativeSpeechRecognition();
    const errors = [];
    recognition.onerror = (event) => errors.push(event.error);
    recognition.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(['failed']);
  });

  it('stays quiet after abort, and unregisters', () => {
    const recognition = createNativeSpeechRecognition();
    const ends = vi.fn();
    const results = vi.fn();
    recognition.onend = ends;
    recognition.onresult = results;
    recognition.start();
    recognition.abort();

    bridge.emit('speechResult', { transcripts: ['tomato'], isFinal: true });
    bridge.emit('speechEnd', {});

    expect(results).not.toHaveBeenCalled();
    expect(ends).not.toHaveBeenCalled();
    expect(bridge.calls).toContain('abort');
    expect(bridge.removed).toEqual(
      expect.arrayContaining(['speechStart', 'speechResult', 'speechError', 'speechEnd'])
    );
  });

  it('passes the chosen locale and alternatives count to the plugin', () => {
    const sent = [];
    globalThis.window = {
      Capacitor: {
        ...bridge.cap,
        nativePromise: (plugin, method, options) => {
          sent.push([method, options]);
          return Promise.resolve({});
        },
      },
    };
    const recognition = createSpeechRecognition('hi');
    recognition.start();
    expect(sent[0]).toEqual([
      'start',
      { locale: 'hi-IN', partialResults: true, maxAlternatives: 5 },
    ]);
  });
});
