import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { useBackLayer } from '../hooks/useBackLayer';
import { currentPosition, savedCustomerCoords } from '../services/markets';
import { hasNativeLocation, nativeLocationStatus, enableNativeLocation } from '../services/nativeLocation';

/** Once per launch: sessionStorage outlives a trip to Settings, not a cold start. */
const SHOWN_KEY = 'vegdrop_location_sheet_shown';

function shownThisLaunch() {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

function markShown() {
  try {
    sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    // Storage disabled: it may show again on the next visit to Home.
  }
}

async function browserPermission() {
  try {
    if (navigator.permissions?.query) {
      return (await navigator.permissions.query({ name: 'geolocation' })).state;
    }
  } catch {
    // Permissions API unsupported (older Safari).
  }
  return 'prompt';
}

function announceLocationOn() {
  // MarketPicker and DeliveryLocationBar retry on this, the same event the
  // Android app sends when location is switched on from anywhere else.
  window.dispatchEvent(new Event('vegdrop:locationon'));
}

/**
 * "Location permission not enabled" — shown as the app opens when the shop
 * cannot find out where the customer is, offering the two ways forward:
 * switch location on, or pick an address on the map by hand.
 *
 * In the Android app it asks the phone directly (services/nativeLocation.js):
 * the permission, then Google's one-tap "Turn on location". A page has no way
 * to do either, so before this a phone with location off simply failed to find
 * any market, with nothing on screen saying why.
 *
 * In a browser only a refusal, or a fix that never comes, is shown here — the
 * browser asks for the permission itself, and LocationPrimer explains it first
 * — and only when no address has been saved, since an address is all the shop
 * needs.
 */
export default function LocationRequiredSheet({ onPickManually }) {
  const { t } = useLanguage();
  // null while all is well; otherwise what is missing: 'permission' | 'off'
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState(null);

  useEffect(() => {
    if (shownThisLaunch()) return undefined;
    let cancelled = false;

    async function decide() {
      let missing = null;
      if (hasNativeLocation()) {
        const status = await nativeLocationStatus().catch(() => null);
        if (!status) return;
        if (!status.granted) missing = 'permission';
        else if (!status.enabled) missing = 'off';
      } else {
        if (savedCustomerCoords()) return;
        const state = await browserPermission();
        if (state === 'denied') missing = 'permission';
        else if (state === 'granted' && !(await currentPosition({ timeout: 6000 }))) missing = 'off';
      }
      if (cancelled || !missing) return;
      markShown();
      setProblem(missing);
    }

    decide();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback(() => {
    setProblem(null);
    setHint(null);
  }, []);

  useBackLayer(Boolean(problem), close);

  // Switched on another way — the quick-settings tile — while this is open.
  useEffect(() => {
    if (!problem) return undefined;
    window.addEventListener('vegdrop:locationon', close);
    return () => window.removeEventListener('vegdrop:locationon', close);
  }, [problem, close]);

  // Back from the Settings page a blocked permission sends people to.
  useEffect(() => {
    if (!problem || !hasNativeLocation()) return undefined;
    const recheck = async () => {
      if (document.visibilityState !== 'visible') return;
      const status = await nativeLocationStatus().catch(() => null);
      if (!status?.granted) return;
      if (status.enabled) {
        close();
        announceLocationOn();
      } else {
        setProblem('off');
        setHint(null);
      }
    };
    document.addEventListener('visibilitychange', recheck);
    return () => document.removeEventListener('visibilitychange', recheck);
  }, [problem, close]);

  const handleEnable = async () => {
    setBusy(true);
    setHint(null);
    try {
      if (hasNativeLocation()) {
        const status = await enableNativeLocation();
        if (status.granted && status.enabled) {
          close();
          announceLocationOn();
        } else if (status.openedSettings) {
          setHint(t('locSheet.blockedApp'));
        } else if (status.granted) {
          setProblem('off');
          setHint(t('locSheet.stillOff'));
        }
        return;
      }

      if (await currentPosition({ timeout: 10000 })) {
        close();
        announceLocationOn();
        return;
      }
      setHint((await browserPermission()) === 'denied' ? t('locSheet.blockedBrowser') : t('locSheet.stillOff'));
    } catch {
      setHint(t('locSheet.stillOff'));
    } finally {
      setBusy(false);
    }
  };

  const handleManual = () => {
    close();
    onPickManually?.();
  };

  if (!problem) return null;

  // Portalled: Home renders inside PageTransition, whose transform makes it the
  // containing block for `fixed` — the card was centred on the whole page, far
  // below the screen, with only its backdrop in view.
  return createPortal(
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/50 px-8 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vd-location-sheet-title"
    >
      <div className="w-full max-w-[20rem] overflow-hidden rounded-2xl bg-white shadow-2xl animate-scale-in">
        <div className="px-5 pt-6 pb-4 text-center">
          {/* A pin struck through in red, white-haloed where the line crosses it. */}
          <svg viewBox="0 0 48 48" className="mx-auto mb-3 h-14 w-14" aria-hidden="true">
            <path
              d="M24 44s14-13.2 14-24a14 14 0 1 0-28 0c0 10.8 14 24 14 24z"
              fill="none"
              stroke="#1F2937"
              strokeWidth="3.2"
              strokeLinejoin="round"
            />
            <circle cx="24" cy="20" r="5" fill="none" stroke="#1F2937" strokeWidth="3.2" />
            <path d="M9 39 39 9" stroke="#FFFFFF" strokeWidth="8" strokeLinecap="round" />
            <path d="M9 39 39 9" stroke="#E11D48" strokeWidth="3.4" strokeLinecap="round" />
          </svg>

          <h2 id="vd-location-sheet-title" className="text-[16.5px] font-extrabold text-gray-900">
            {problem === 'permission' ? t('locSheet.permissionTitle') : t('locSheet.offTitle')}
          </h2>
          <p className="mt-1.5 text-[13px] leading-snug text-gray-500">{t('locSheet.body')}</p>

          {hint && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-snug text-amber-900">
              {hint}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={handleEnable}
          disabled={busy}
          className="flex w-full cursor-pointer items-center justify-center gap-2 border-t border-gray-100 py-3.5 text-[14.5px] font-bold text-emerald-700 active:bg-gray-50 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('locSheet.enable')}
        </button>
        <button
          type="button"
          onClick={handleManual}
          className="w-full cursor-pointer border-t border-gray-100 py-3.5 text-[14.5px] font-semibold text-gray-600 active:bg-gray-50"
        >
          {t('locSheet.manual')}
        </button>
      </div>
    </div>,
    document.body
  );
}
