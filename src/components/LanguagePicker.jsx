import React, { useState } from 'react';
import { Languages, ChevronDown, Check } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { LANGUAGES } from '../i18n/translations';

/**
 * The language setting, shared by all three apps (Customer, Shopkeeper,
 * Delivery) via LanguageProvider in main.jsx — this component is the one
 * place all three render it from.
 *
 * Collapsed to a single row showing the current language, with the full list
 * behind a tap — the three-button grid this replaced showed every option at
 * once, all the time, on a screen that is mostly about something else. This
 * matches MarketPicker's own collapse-with-chevron shape rather than
 * inventing a second pattern for "pick one of a few things" on the same page.
 *
 * Selecting a language applies immediately and closes the list; there is
 * nothing to save or cancel, the same way a system settings toggle works.
 * `LANGUAGES` carries each language's own native name, never translated, so a
 * language can be found in the list by someone who cannot read whichever one
 * is active now.
 */
export default function LanguagePicker() {
  const { language, setLanguage, t } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  const current = LANGUAGES.find((lang) => lang.code === language) || LANGUAGES[0];

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 p-5 text-left cursor-pointer"
      >
        <span className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
          <Languages className="w-4.5 h-4.5 text-emerald-700" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[10px] font-bold text-emerald-700 uppercase tracking-wider">
            {t('settings.language')}
          </span>
          <span className="block text-[14px] font-extrabold text-gray-900 truncate">
            {current.nativeName}
          </span>
        </span>
        <ChevronDown
          className={`w-5 h-5 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-5 pb-5 pt-3 animate-fade-in">
          <p className="text-xs text-gray-500 leading-relaxed mb-3">{t('settings.languageHint')}</p>

          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100 overflow-hidden">
            {LANGUAGES.map((lang) => {
              const isActive = lang.code === language;
              return (
                <li key={lang.code}>
                  <button
                    type="button"
                    onClick={() => {
                      setLanguage(lang.code);
                      setExpanded(false);
                    }}
                    aria-pressed={isActive}
                    className={`w-full px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer ${
                      isActive ? 'bg-emerald-50' : 'bg-white hover:bg-gray-50'
                    }`}
                  >
                    <span
                      className={`text-[14px] font-bold ${isActive ? 'text-emerald-700' : 'text-gray-700'}`}
                    >
                      {lang.nativeName}
                    </span>
                    {isActive && <Check className="w-4.5 h-4.5 text-emerald-600 shrink-0" strokeWidth={3} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
