import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import { createSpeechRecognition, mapSpeechError, speechRecognitionCtor } from '../services/voiceSearch';
import { hasNativeSpeech } from '../services/nativeSpeech';
import { speak, stopSpeaking } from '../services/voiceOut';
import { parseVoiceCommand, routeVoiceCommand, routeModelGuess, modelCanHelp } from '../lib/voiceCommands';
import { classifySpokenCommand } from '../services/agent';
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
  /**
   * Which spoken turn is current. Bumped by every listen and every stop.
   *
   * A turn that waits on the model can outlive the shopper's patience: they
   * tap stop while it is "thinking", and the answer used to arrive anyway and
   * act — adding to the cart or changing the screen after being told to stop.
   * Anything that resumes after an `await` checks this first.
   */
  const turnRef = useRef(0);
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
    turnRef.current += 1;
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

  /**
   * Carry out one ALREADY-ROUTED command, in whatever mode is current.
   *
   * `spokenReply` is the model's own wording when the command came from it:
   * the app's fixed sentence is correct but flat, and a sentence written for
   * this shopper in their own words is the whole point of asking a model what
   * they meant. It is only ever the WORDING — what happens is this switch,
   * every time.
   */
  const perform = useCallback(
    (command, { reply: spokenReply, deferMiss = false } = {}) => {
      const run = actionsRef.current;
      const screen = viewRef.current;
      const say = (fallback) => answer(spokenReply || fallback);

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
          say(t('voice.opening', { screen: t(`voice.target.${command.target}`) }));
          return;
        }

        case 'add_item': {
          const { added = [], missing = [] } = run.addItems?.(command.items || []) || {};
          if (added.length === 0) {
            // Nothing changed, so the caller may ask the model what the
            // vegetable was before answering "couldn't find".
            if (deferMiss) return false;
            answer(t('voice.notFound', { items: missing.join(', ') || command.text || '' }));
            return;
          }
          // The model's wording is used only when everything asked for landed.
          // A partial result has to name what did NOT, and the model does not
          // know — it never saw this market's sheet.
          if (missing.length > 0) {
            answer(`${t('voice.added', { items: added.join(', ') })} ${t('voice.notFound', { items: missing.join(', ') })}`);
            return;
          }
          say(t('voice.added', { items: added.join(', ') }));
          return;
        }

        case 'remove_item': {
          const { removed = [], missing = [] } = run.removeItems?.(command.items || []) || {};
          if (removed.length === 0) {
            if (deferMiss) return false;
            answer(t('voice.notInCart', { items: missing.join(', ') || command.text || '' }));
            return;
          }
          say(t('voice.removed', { items: removed.join(', ') }));
          return;
        }

        case 'clear_cart':
          run.clearCart?.();
          say(t('voice.cleared'));
          return;

        case 'cook':
        default:
          /*
           * To the cooking assistant, which holds a real conversation.
           *
           * The agent says nothing of its own here — two voices answering one
           * question is worse than one — so the reply the shopper hears is the
           * assistant's.
           */
          run.ask?.(command.text || '');
          setStatus('idle');
          setSaid('');
          return;
      }
    },
    [answer, stop, t]
  );

  /**
   * Work out what was said, then do it.
   *
   * Two stages, in this order for a reason. The keyword table answers
   * instantly and with no connection, so a command it recognises never waits
   * on a network — and the commands people repeat all day are exactly the ones
   * it covers. Only a sentence it cannot place is sent to the model, which is
   * the half a table cannot do: people do not say "add two kg tomato", they
   * say "tomato konchem veyyi" and "put a couple of those in".
   *
   * **The model names a command. It never runs one.** Whatever it returns goes
   * back through the same mode gate and the same switch above, so the ceiling
   * the shopper set still holds, the catalog lookup and pack arithmetic are
   * unchanged, and `payment` stays unreachable. A wrong answer from it is a
   * wrong screen, never a wrong price.
   *
   * Every failure — no key, provider down, no connection — falls through to
   * the cooking assistant, which is exactly where an unrecognised sentence
   * went before any of this existed.
   */
  const act = useCallback(
    async (utterance) => {
      const turn = turnRef.current;
      const routed = routeVoiceCommand(utterance, modeRef.current);
      const command = { ...routed, text: routed.text ?? utterance };
      const askable = modelCanHelp(modeRef.current);

      /** The model's reading of the sentence as a command, or null. Never throws. */
      const understand = async () => {
        const screen = viewRef.current;
        try {
          const guess = await classifySpokenCommand({
            utterance,
            language: languageRef.current,
            screen: {
              ...(screen.tab ? { tab: screen.tab } : {}),
              ...(screen.productName ? { productName: screen.productName } : {}),
              cartCount: Array.isArray(screen.cartLines) ? screen.cartLines.length : 0,
            },
          });
          // Converted, not passed through: the server names vegetables
          // `{ name }`, the cart handlers read `{ text }` — see routeModelGuess.
          const understood = routeModelGuess(guess, modeRef.current, utterance);
          return understood ? { ...understood, reply: typeof guess?.reply === 'string' ? guess.reply : '' } : null;
        } catch {
          // Offline, signed out, rate limited: the caller answers without it.
          return null;
        }
      };

      if (routed.intent !== 'cook') {
        /*
         * A second chance for the vegetable, not for the verb.
         *
         * The table knew it was an add ("vankaya veyyi") but no row on the
         * sheet is called "vankaya" — the model knows it is brinjal. Nothing
         * was written by the first try, so asking costs nothing but time, and
         * only an answer with the SAME verb is used: a model that hears a
         * removal in what the table heard as an addition is overruled.
         */
        const writes = routed.verdict === 'allow' && (routed.intent === 'add_item' || routed.intent === 'remove_item');
        if (perform(command, { deferMiss: writes && askable }) !== false) return;

        const second = await understand();
        if (turnRef.current !== turn) return;
        if (second && second.verdict === 'allow' && second.intent === routed.intent) {
          perform(second, { reply: second.reply });
          return;
        }
        perform(command);
        return;
      }

      // Conversation, or a mode where the model could not be acted on anyway:
      // straight to the assistant, with no round trip in front of it.
      if (!askable) {
        perform(command);
        return;
      }

      const guess = await understand();
      if (turnRef.current !== turn) return;
      perform(guess || command, { reply: guess?.reply });
    },
    [perform]
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
    turnRef.current += 1;
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
