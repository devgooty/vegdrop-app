import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { translate, DEFAULT_LANGUAGE, LANGUAGES } from './translations';

const STORAGE_KEY = 'vegdrop_language';

/**
 * One language preference, shared by all three apps.
 *
 * It lives above AppRouter (see main.jsx) rather than inside each app, because
 * it is a property of the person sitting at this device, not of whichever
 * role's screen happens to be open — a shopkeeper who also shops as a
 * customer should not have to set it twice.
 */
const LanguageContext = createContext(null);

function readStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((l) => l.code === stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    // Storage can throw in a locked-down webview; fall back silently rather
    // than breaking the app over a preference.
    return DEFAULT_LANGUAGE;
  }
}

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(readStoredLanguage);

  const setLanguage = useCallback((code) => {
    if (!LANGUAGES.some((l) => l.code === code)) return;
    setLanguageState(code);
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // Preference just won't survive a reload; not worth surfacing an error for.
    }
  }, []);

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (key) => translate(key, language),
    }),
    [language, setLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/** @returns {{ language: string, setLanguage: (code: string) => void, t: (key: string) => string }} */
export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage() must be used inside a LanguageProvider.');
  return ctx;
}
