import React from 'react';
import { Mic, Loader2, MicOff } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * The one way in to the voice agent.
 *
 * It is a button rather than a wake word, deliberately: a microphone that
 * listens for its name is a microphone that is always on, and this app runs in
 * a market where a phone sits in a pocket among other people's conversations.
 * One tap, one command, mic closed — the shopper can always see whether it is
 * listening, which no wake word can offer.
 *
 * It sits above the bottom navigation rather than beside it, because the nav is
 * six fixed destinations and a seventh item would make the voice agent look
 * like a seventh screen. `bottom` is composed from the nav's own height plus
 * the safe-area inset, so it rides above the gesture bar on a phone that has
 * one and sits lower on a phone that does not.
 */
export default function VoiceAgentButton({ status, heard, said, onListen, onStop }) {
  const { t } = useLanguage();

  const listening = status === 'listening';
  const thinking = status === 'thinking';
  const busy = listening || thinking;

  /*
   * The bubble is what makes a spoken answer reviewable.
   *
   * Speech is gone the moment it is said — and on a phone with no voice for
   * this language it was never said at all (`services/voiceOut.js`). So
   * whatever the agent answered is also shown here, along with what it heard,
   * which is the only way a shopper can tell a misheard word from a command
   * the agent refused.
   */
  const bubble =
    status === 'unsupported'
      ? t('voice.settings.unsupported')
      : status === 'permission'
        ? t('voice.micBlocked')
        : status === 'nospeech'
          ? t('voice.notHeard')
          : status === 'network'
            ? t('voice.offline')
            : status === 'failed'
              ? t('voice.notHeard')
              : said || (busy && heard) || '';

  return (
    <div className="fixed right-4 z-40 flex flex-col items-end gap-2 pointer-events-none" style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}>
      {bubble && (
        <div className="pointer-events-auto max-w-[72vw] rounded-2xl bg-white/95 backdrop-blur border border-[#E8E2D6] shadow-lg px-3.5 py-2.5 text-[12.5px] font-semibold text-[#1F2937] leading-snug">
          {/* What it heard, quietly above what it answered: a wrong answer to a
              misheard word is a different problem from a wrong answer. */}
          {said && heard ? (
            <p className="text-[11px] font-bold text-[#8A7E6B] mb-1">“{heard}”</p>
          ) : null}
          {bubble}
        </div>
      )}

      <button
        type="button"
        onClick={busy ? onStop : onListen}
        aria-label={listening ? t('voice.listening') : t('voice.listen')}
        className={`pointer-events-auto w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-transform active:scale-95 ${
          listening ? 'bg-red-600 text-white animate-pulse' : 'bg-[#1B4D3E] text-white'
        }`}
      >
        {thinking ? (
          <Loader2 className="w-6 h-6 animate-spin" />
        ) : status === 'unsupported' ? (
          <MicOff className="w-6 h-6" />
        ) : (
          <Mic className="w-6 h-6" />
        )}
      </button>

    </div>
  );
}
