import React from 'react';
import { Languages } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { LANGUAGES } from '../i18n/translations';

/**
 * The language setting, shared by all three apps (Customer, Shopkeeper,
 * Delivery) via LanguageProvider in main.jsx — this component is the one
 * place all three render it from.
 *
 * Selecting a language applies immediately; there is nothing to save or
 * cancel, the same way a system settings toggle works. `LANGUAGES` carries
 * each language's own native name, never translated, so a language can be
 * found in the list by someone who cannot read whichever one is active now.
 */
export default function LanguagePicker() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-center gap-2 border-b pb-2 mb-4">
        <Languages className="w-4 h-4 text-emerald-700" />
        <h3 className="font-black text-gray-900">{t('settings.language')}</h3>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed mb-4">{t('settings.languageHint')}</p>

      <div className="grid grid-cols-3 gap-2">
        {LANGUAGES.map((lang) => {
          const isActive = lang.code === language;
          return (
            <button
              key={lang.code}
              type="button"
              onClick={() => setLanguage(lang.code)}
              aria-pressed={isActive}
              className={`py-2.5 rounded-xl text-sm font-bold transition-all active:scale-95 border ${
                isActive
                  ? 'bg-emerald-700 text-white border-emerald-700 shadow-sm'
                  : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
              }`}
            >
              {lang.nativeName}
            </button>
          );
        })}
      </div>
    </section>
  );
}
