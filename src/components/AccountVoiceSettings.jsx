import React from 'react';
import { Check, MicOff } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { VOICE_MODES } from '../lib/voiceCommands';

/**
 * How much of the app the voice agent may drive.
 *
 * The four steps are the shopper's own answer to that question, and they are a
 * SETTING rather than a prompt per action for one reason: a confirmation dialog
 * on every spoken command is slower than tapping, which is the only thing
 * voice has to beat. Choosing the ceiling once, in a screen that says plainly
 * what each step allows, is the trade that keeps voice worth using.
 *
 * Payment appears in no step, and the highest step says so out loud rather
 * than leaving its absence to be noticed. A shopper has to be able to read
 * what they are switching on.
 */
export default function AccountVoiceSettings({ mode, onChange, supported }) {
  const { t } = useLanguage();

  return (
    <div className="text-left space-y-3">
      <p className="text-[12.5px] font-semibold text-slate-500 px-1">{t('voice.settings.subtitle')}</p>

      {!supported && (
        /* Said before the list, not instead of it: the setting is still worth
           keeping, because the same account opens this site in a browser that
           can listen. */
        <div className="flex items-start gap-2.5 rounded-2xl bg-amber-50 border border-amber-100 px-3.5 py-3">
          <MicOff className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
          <p className="text-[12px] font-bold text-amber-900 leading-snug">{t('voice.settings.unsupported')}</p>
        </div>
      )}

      <div className="bg-white/90 backdrop-blur-sm rounded-[1.75rem] shadow-sm border border-white/50 divide-y divide-slate-100 overflow-hidden">
        {VOICE_MODES.map((step) => {
          const active = mode === step;
          return (
            <button
              key={step}
              type="button"
              onClick={() => onChange?.(step)}
              aria-pressed={active}
              className="w-full p-4 flex items-center gap-3.5 text-left active:bg-slate-50 transition-colors"
            >
              <div className="flex-1">
                <h3 className={`text-sm font-extrabold tracking-tight ${active ? 'text-[#1B4D3E]' : 'text-slate-600'}`}>
                  {t(`voice.settings.${step}`)}
                </h3>
                <p className="text-[11.5px] font-bold text-slate-400 mt-0.5 leading-snug">
                  {t(`voice.settings.${step}Hint`)}
                </p>
              </div>
              <div
                className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center ${
                  active ? 'bg-[#1B4D3E] text-white' : 'border-2 border-slate-200'
                }`}
              >
                {active ? <Check className="w-3.5 h-3.5" /> : null}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[11.5px] font-bold text-slate-400 px-1 leading-snug">{t('voice.settings.payNote')}</p>
    </div>
  );
}
