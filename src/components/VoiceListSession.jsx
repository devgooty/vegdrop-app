import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Mic, X, Check } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { createSpeechRecognition, mapSpeechError } from '../services/voiceSearch';
import { mergeItems, parseSpokenList } from '../services/voiceList';

/**
 * Dictate a shopping list: say an item, get asked for the next, tap OK.
 *
 * The recogniser hears one utterance per session (`continuous` stays false —
 * Android Chrome repeats earlier text back inside continuous results), so the
 * loop is ours: each session that ends after an item starts the next one. The
 * interpretation of what was said lives in services/voiceList.js.
 *
 * Two browser rules shape how listening starts and stops:
 *
 *  - Chrome wants `start()` inside the tap that asked for it (see
 *    `createSpeechRecognition`). So the parent calls `start()` through the ref
 *    from its own click handler rather than this component starting itself in
 *    an effect. The automatic restarts between items cannot have a tap behind
 *    them; if the browser refuses one, the screen pauses and asks for a tap,
 *    instead of claiming the microphone is blocked when it plainly just worked.
 *  - A mic that stays open while nobody is speaking is a privacy cost, not a
 *    convenience. Silence restarts only a couple of times, then pauses.
 */

const RESTART_DELAY_MS = 300;

/** Silent sessions in a row (each is several seconds) before listening pauses. */
const MAX_SILENT_RESTARTS = 2;

const VoiceListSession = forwardRef(function VoiceListSession(
  { open, products = [], categories = [], onDone, onClose },
  ref
) {
  const { t, language } = useLanguage();
  const [status, setStatus] = useState('listening');
  const [items, setItems] = useState([]);
  const [liveText, setLiveText] = useState('');

  const recognitionRef = useRef(null);
  const restartTimerRef = useRef(null);
  // The session wants the mic. False once OK, close, or the parent hiding us.
  const activeRef = useRef(false);
  // The mic has produced a session at least once since `start()`.
  const listenedRef = useRef(false);
  const silentRef = useRef(0);
  const itemsRef = useRef([]);
  const latestRef = useRef({ products, categories, language, onDone, onClose });

  // Recognition callbacks outlive the render that created them.
  useEffect(() => {
    latestRef.current = { products, categories, language, onDone, onClose };
  });

  const setItemsBoth = (next) => {
    itemsRef.current = next;
    setItems(next);
  };

  const stopRecognition = () => {
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try {
      recognition?.abort();
    } catch {
      // abort() throws if the session never started
    }
  };

  const end = () => {
    activeRef.current = false;
    stopRecognition();
    setLiveText('');
    return itemsRef.current;
  };

  const finish = () => {
    const list = end();
    if (list.length > 0) latestRef.current.onDone?.(list);
    else latestRef.current.onClose?.(list);
  };

  const close = () => {
    const list = end();
    latestRef.current.onClose?.(list);
  };

  const listen = () => {
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    if (!activeRef.current) return;

    const recognition = createSpeechRecognition(latestRef.current.language);
    if (!recognition) {
      setStatus('unsupported');
      return;
    }

    let heard = false;
    let error = null;

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      listenedRef.current = true;
      setStatus('listening');
    };

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alternatives = Array.from(result, (alternative) => alternative.transcript);
        if (!result.isFinal) {
          setLiveText(alternatives[0]?.trim() || '');
          continue;
        }

        heard = true;
        setLiveText('');
        const { products: catalog, categories: sections } = latestRef.current;
        const parsed = parseSpokenList(alternatives, { products: catalog, categories: sections });
        if (parsed.done) {
          finish();
          return;
        }
        if (parsed.items.length > 0) setItemsBoth(mergeItems(itemsRef.current, parsed.items));
      }
    };

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      error = mapSpeechError(event.error, { online: navigator.onLine });
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      if (!activeRef.current) return;
      setLiveText('');

      if (error && error !== 'nospeech') {
        // Being offline is worth saying. Anything else after the mic has already
        // worked is the browser declining a restart no tap asked for.
        setStatus(error === 'network' || !listenedRef.current ? error : 'paused');
        return;
      }

      silentRef.current = heard ? 0 : silentRef.current + 1;
      if (silentRef.current > MAX_SILENT_RESTARTS) {
        setStatus('paused');
        return;
      }
      restartTimerRef.current = setTimeout(listen, RESTART_DELAY_MS);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setStatus(listenedRef.current ? 'paused' : 'failed');
    }
  };

  /** A new list. Call from the tap that opened the screen. */
  const begin = () => {
    stopRecognition();
    activeRef.current = true;
    listenedRef.current = false;
    silentRef.current = 0;
    setItemsBoth([]);
    setLiveText('');
    setStatus('listening');
    listen();
  };

  /** Carry on with the same list — the mic tapped after a pause. */
  const resume = () => {
    stopRecognition();
    activeRef.current = true;
    silentRef.current = 0;
    setStatus('listening');
    listen();
  };

  const pause = () => {
    stopRecognition();
    setLiveText('');
    setStatus('paused');
  };

  useImperativeHandle(ref, () => ({ start: begin }));

  // Hidden by the parent, or unmounted: the microphone goes with it.
  useEffect(() => {
    if (!open) {
      activeRef.current = false;
      stopRecognition();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(
    () => () => {
      activeRef.current = false;
      stopRecognition();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const listening = status === 'listening';
  const count = items.length;
  const headline =
    {
      listening: count > 0 ? t('voiceList.next') : t('voiceList.first'),
      paused: count > 0 ? t('voiceList.pausedNext') : t('voiceList.pausedFirst'),
      permission: t('notepad.voicePermission'),
      unsupported: t('notepad.voiceUnsupported'),
      network: t('notepad.voiceNetwork'),
      failed: t('notepad.voiceFailed'),
    }[status] || t('voiceList.first');

  return (
    <div
      className="fixed inset-0 z-[210] mx-auto max-w-md bg-white flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={t('notepad.voiceAdd')}
    >
      <div className="shrink-0 flex justify-end px-3 pt-safe-3">
        <button
          type="button"
          className="w-10 h-10 flex items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f1f3f4] cursor-pointer"
          onClick={close}
          aria-label={t('common.close')}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="shrink-0 px-6 pt-6">
        <div className="vd-voice-overlay-row">
          <p className="vd-voice-overlay-title" aria-live="polite">
            {headline}
          </p>

          <button
            type="button"
            className={`vd-voice-mic ${listening ? 'is-listening' : ''}`}
            onClick={listening ? pause : resume}
            aria-label={listening ? t('header.voiceStop') : t('notepad.voiceAdd')}
          >
            <span className="vd-voice-mic-halo" aria-hidden="true" />
            {listening && <span className="vd-voice-mic-ring" aria-hidden="true" />}
            <span className="vd-voice-mic-core">
              <Mic className="w-8 h-8 text-white" strokeWidth={2.25} />
            </span>
          </button>
        </div>

        <p className="vd-voice-overlay-live min-h-[1.5rem]">
          {listening && liveText ? `“${liveText}”` : listening || status === 'paused' ? t('voiceList.hint') : ''}
        </p>
      </div>

      <ol className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-2" aria-label={t('voiceList.listLabel')}>
        {items.map((item, index) => (
          <li
            key={item}
            className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2.5 animate-fade-in"
          >
            <span className="w-7 h-7 shrink-0 rounded-full bg-[#1B4D3E] text-white text-xs font-black flex items-center justify-center">
              {index + 1}
            </span>
            <span className="flex-1 min-w-0 text-[15px] font-bold text-slate-800 break-words">{item}</span>
            <button
              type="button"
              onClick={() => setItemsBoth(itemsRef.current.filter((existing) => existing !== item))}
              aria-label={t('voiceList.remove', { item })}
              className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </li>
        ))}
      </ol>

      <div className="shrink-0 px-5 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] border-t border-slate-100">
        <button
          type="button"
          onClick={finish}
          disabled={count === 0}
          className="w-full flex items-center justify-center gap-2 bg-[#1B4D3E] text-white rounded-2xl py-3.5 text-[15px] font-black shadow-[0_6px_18px_rgba(27,77,62,0.25)] active:scale-[0.99] transition hover:bg-[#123B2F] disabled:opacity-40 disabled:shadow-none cursor-pointer"
        >
          <Check className="w-5 h-5" strokeWidth={2.75} />
          {count === 0 ? t('voiceList.okEmpty') : count === 1 ? t('voiceList.okOne') : t('voiceList.ok', { count })}
        </button>
      </div>
    </div>
  );
});

export default VoiceListSession;
