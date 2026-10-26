import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import { createSpeechRecognition, mapSpeechError, speechRecognitionCtor } from '../services/voiceSearch';
import { hasNativeSpeech } from '../services/nativeSpeech';
import { speak, stopSpeaking } from '../services/voiceOut';
import { parseVoiceCommand, routeVoiceCommand } from '../lib/voiceCommands';
import { describeScreen, describeCart, describeHelp } from '../lib/voiceScreen';

/**
 * One spoken turn: listen, decide, do, answer.
 *
 * The hook holds the microphone and the talking. It holds no knowledge of the
 * catalog or the cart — every act goes out through `actions`, which the app
 * supplies — so what a command MEANS is decided in `lib/voiceCommands.js` and
 * what it DOES is decided in App.jsx, and this file only carries the turn
 * between them. That split is what keeps the two testable without a browser.
 *
 * `view` is read through a ref rather than a dependency, because the answer
 * must describe the screen as it is WHEN THE SHOPPER FINISHES SPEAKING. Closing
 * over the render that started the session would narrate the screen they were
 * on several seconds ago, which during navigation is the wrong one.
 *
 * @param {object} options
 * @param {'off'|'low'|'medium'|'high'} options.mode
 * @param {object} options.view     what is on screen, for `describeScreen`
 * @param {object} options.actions  navigate / addItems / removeItems / clearCart / ask / openCart
 */
/** How long an answer stays on screen after it has been said. */
const ANSWER_VISIBLE_MS = 9000;

export default function useVoiceAgent({ mode = 'off', view = {}, actions = {} }) {
  const { t, language } = useLanguage();
  const [status, setStatus] = useState('idle');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [silent, setSilent] = useState(null);

  const recognitionRef = useRef(null);
  const viewRef = useRef(view);
  const actionsRef = useRef(actions);
  const modeRef = useRef(mode);
  const languageRef = useRef(language);

  viewRef.current = view;
  actionsRef.current = actions;
  modeRef.current = mode;
  languageRef.current = language;

  /*
   * Asked of the constructor, never by building one.
   *
   * `createSpeechRecognition()` returns a live recogniser, and calling it on
   * every render to test for null would create and discard one each time —
   * Chrome holds a service connection behind that object.
   */
  const supported = Boolean(speechRecognitionCtor() || hasNativeSpeech());

  /**
   * Say it AND show it.
   *
   * `speak` can honestly fail — a phone with no Telugu voice is quiet, not
   * broken — so the sentence is always put on screen as well. Showing it only
   * when speech failed would mean the shopper has to know whether it failed.
   */
  const fadeRef = useRef(null);

  const answer = useCallback((sentence) => {
    setSaid(sentence);
    setSilent(null);
    setStatus('spoke');

    /*
     * Why it stayed quiet, when it did.
     *
     * A phone with no voice for the chosen language is quiet, not broken —
     * but the two look identical to the shopper, who reasonably reports the
     * whole feature as not working. So the reason goes on screen under the
     * answer, and the commonest one names the fix (install the voice, or turn
     * the media volume up).
     */
    speak(sentence, languageRef.current).then((result) => {
      if (!result?.spoken) setSilent(result?.reason || 'engine');
    });

    // The bubble is a transcript of something already said, not a notice to be
    // dismissed. Left up it becomes furniture, and furniture over the nav is
    // worse than no transcript at all.
    clearTimeout(fadeRef.current);
    fadeRef.current = setTimeout(() => {
      setSaid('');
      setHeard('');
      setSilent(null);
      setStatus((current) => (current === 'spoke' ? 'idle' : current));
    }, ANSWER_VISIBLE_MS);
  }, []);

  const stop = useCallback(() => {
    clearTimeout(fadeRef.current);
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try {
      recognition?.abort();
    } catch {
      // abort() throws if the session never started.
    }
    stopSpeaking();
    setStatus('idle');
  }, []);

  /** Carry out one command, in whatever mode is current. */
  const act = useCallback(
    (utterance) => {
      const command = routeVoiceCommand(utterance, modeRef.current);
      const run = actionsRef.current;
      const screen = viewRef.current;

      if (command.verdict === 'payment') {
        // Opening the cart is the most help that can be given here: the shopper
        // asked to pay, and the one thing voice will not do is pay.
        run.openCart?.();
        answer(t('voice.payment'));
        return;
      }

      if (command.verdict === 'blocked') {
        answer(t('voice.blocked', { mode: t(`voice.settings.${modeRef.current}`) }));
        return;
      }

      switch (command.intent) {
        case 'none':
          answer(t('voice.notHeard'));
          return;

        case 'stop':
          stop();
          return;

        case 'help':
          answer(describeHelp(modeRef.current, t));
          return;

        case 'read_screen':
          answer(describeScreen(screen, t));
          return;

        case 'read_cart':
          answer(describeCart(screen, t));
          return;

        case 'navigate': {
          const opened = run.navigate?.(command.target);
          if (!opened) {
            answer(t('voice.screen.unknown'));
            return;
          }
          // The screen named, not the screen described: this answers "I am
          // taking you there", and the shopper can then see it for themselves.
          answer(t('voice.opening', { screen: t(`voice.target.${command.target}`) }));
          return;
        }

        case 'add_item': {
          const { added = [], missing = [] } = run.addItems?.(command.items || []) || {};
          if (added.length === 0) {
            answer(t('voice.notFound', { items: missing.join(', ') || command.text || '' }));
            return;
          }
          answer(
            missing.length > 0
              ? `${t('voice.added', { items: added.join(', ') })} ${t('voice.notFound', { items: missing.join(', ') })}`
              : t('voice.added', { items: added.join(', ') })
          );
          return;
        }

        case 'remove_item': {
          const { removed = [], missing = [] } = run.removeItems?.(command.items || []) || {};
          if (removed.length === 0) {
            answer(t('voice.notInCart', { items: missing.join(', ') || command.text || '' }));
            return;
          }
          answer(t('voice.removed', { items: removed.join(', ') }));
          return;
        }

        case 'clear_cart':
          run.clearCart?.();
          answer(t('voice.cleared'));
          return;

        case 'cook':
        default:
          /*
           * The fall-through, and the reason the matcher may be narrow.
           *
           * Anything it did not recognise is handed to the cooking assistant,
           * which is the model path and holds a real conversation. The agent
           * says nothing of its own here — two voices answering one question is
           * worse than one — so the reply the shopper hears is the assistant's.
           */
          run.ask?.(command.text || utterance);
          setStatus('idle');
          setSaid('');
          return;
      }
    },
    [answer, stop, t]
  );

  /**
   * Start listening.
   *
   * Called from the tap, never from an effect: Chrome's recogniser must be
   * created and started inside the user-activation the tap carries, or it
   * reports `network` on a phone that is perfectly online — the reason spelled
   * out on `createSpeechRecognition`.
   */
  const listen = useCallback(() => {
    if (modeRef.current === 'off') return;
    stopSpeaking();

    const recognition = createSpeechRecognition(languageRef.current);
    if (!recognition) {
      setStatus('unsupported');
      return;
    }

    setHeard('');
    setSaid('');
    setSilent(null);

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      setStatus('listening');
    };

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      const last = event.results[event.results.length - 1];
      if (!last) return;
      const transcript = last[0]?.transcript?.trim();
      if (transcript) setHeard(transcript);
      if (!last.isFinal) return;

      // One command per session: the recogniser is stopped before the command
      // runs, so navigating or opening the cart cannot be narrated over by a
      // second utterance the mic was still collecting.
      recognitionRef.current = null;
      try {
        recognition.abort();
      } catch {
        // Already finished on its own.
      }
      setStatus('thinking');
      /*
       * Every alternative is tried, in the recogniser's own ranking.
       *
       * Its favourite guess is often not the one carrying the command word —
       * the same reason voice search ranks guesses against the catalog rather
       * than taking the first. So the first guess that reads as a COMMAND wins;
       * if none does, the favourite goes to the assistant, which handles open
       * language better than any ranking here could.
       */
      const alternatives = Array.from(last, (one) => one.transcript)
        .map((text) => String(text || '').trim())
        .filter(Boolean);
      const commanding = alternatives.find((text) => {
        const intent = parseVoiceCommand(text).intent;
        return intent !== 'cook' && intent !== 'none';
      });
      act(commanding || alternatives[0] || transcript || '');
    };

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      const mapped = mapSpeechError(event.error, { online: navigator.onLine });
      if (!mapped) return;
      setStatus(mapped);
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setStatus((current) => (current === 'listening' ? 'nospeech' : current));
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setStatus('failed');
    }
  }, [act]);

  /** Switching the feature off, or leaving the app, must not leave a hot mic. */
  useEffect(() => {
    if (mode === 'off') stop();
  }, [mode, stop]);

  useEffect(() => stop, [stop]);

  return { supported, status, heard, said, silent, listen, stop };
}
