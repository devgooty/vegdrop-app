import React, { useCallback, useEffect, useState } from 'react';
import { MapPin, Mic, CircleCheck, CircleX, CircleHelp } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { currentPosition } from '../services/markets';

/**
 * What this screen shows is only what the app actually asks the browser for.
 * There is no Notifications or Camera row here because nothing in this app
 * calls `Notification.requestPermission()` or opens a live camera stream —
 * the vendor photo flow is a file input, which the OS handles on its own and
 * never becomes a queryable permission. A toggle for something the app never
 * requests would be exactly the kind of "looks real, proves nothing" control
 * this codebase avoids elsewhere (see the KYC penny-drop reasoning).
 *
 * Mirrors LocationPrimer's status pattern rather than inventing a new one:
 * `navigator.permissions.query` where it exists, a try/catch fallback for
 * Safari (which doesn't support querying 'microphone'), and — critically —
 * no "Allow" button once a permission reads denied. The browser's own dialog
 * cannot be re-shown after a decline, so a button that looks actionable there
 * would just do nothing and read as broken.
 */

const CHECKS = [
  { key: 'geolocation', icon: MapPin, titleKey: 'permissions.location', hintKey: 'permissions.locationHint' },
  { key: 'microphone', icon: Mic, titleKey: 'permissions.microphone', hintKey: 'permissions.microphoneHint' },
];

async function queryStatus(name) {
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name });
      return status;
    }
  } catch {
    // Unsupported permission name or browser (Safari has no 'microphone' query).
  }
  return null;
}

function StatusBadge({ state, t }) {
  if (state === 'granted') {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-emerald-600">
        <CircleCheck className="w-3.5 h-3.5" />
        {t('permissions.statusGranted')}
      </span>
    );
  }
  if (state === 'denied') {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-red-600">
        <CircleX className="w-3.5 h-3.5" />
        {t('permissions.statusDenied')}
      </span>
    );
  }
  if (state === 'prompt') {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-amber-600">
        <CircleHelp className="w-3.5 h-3.5" />
        {t('permissions.statusPrompt')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-slate-400">
      <CircleHelp className="w-3.5 h-3.5" />
      {t('permissions.statusUnknown')}
    </span>
  );
}

export default function AccountPermissions() {
  const { t } = useLanguage();
  const [states, setStates] = useState({ geolocation: null, microphone: null });
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const cleanups = [];

    CHECKS.forEach(({ key }) => {
      queryStatus(key).then((status) => {
        if (cancelled) return;
        if (!status) {
          setStates((prev) => ({ ...prev, [key]: 'unsupported' }));
          return;
        }
        setStates((prev) => ({ ...prev, [key]: status.state }));
        const onChange = () => setStates((prev) => ({ ...prev, [key]: status.state }));
        status.addEventListener('change', onChange);
        cleanups.push(() => status.removeEventListener('change', onChange));
      });
    });

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const requestLocation = useCallback(async () => {
    setBusy('geolocation');
    const found = await currentPosition();
    setStates((prev) => ({ ...prev, geolocation: found ? 'granted' : 'denied' }));
    setBusy(null);
  }, []);

  const requestMicrophone = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStates((prev) => ({ ...prev, microphone: 'unsupported' }));
      return;
    }
    setBusy('microphone');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Only proving access is possible — nothing here is recorded or kept.
      stream.getTracks().forEach((track) => track.stop());
      setStates((prev) => ({ ...prev, microphone: 'granted' }));
    } catch {
      setStates((prev) => ({ ...prev, microphone: 'denied' }));
    }
    setBusy(null);
  }, []);

  const requestFns = { geolocation: requestLocation, microphone: requestMicrophone };

  return (
    <div className="space-y-4 text-left animate-fade-in w-full max-w-md mx-auto">
      <div className="bg-white/90 backdrop-blur-sm rounded-[1.75rem] shadow-sm border border-white/50 divide-y divide-slate-100 overflow-hidden">
        {CHECKS.map(({ key, icon: Icon, titleKey, hintKey }) => {
          const state = states[key];
          return (
            <div key={key} className="p-4 flex items-start gap-4">
              <div className="w-11 h-11 shrink-0 rounded-xl bg-slate-100 text-slate-800 flex items-center justify-center shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(0,0,0,0.06)]">
                <Icon className="w-5 h-5 drop-shadow-sm" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">{t(titleKey)}</h3>
                  {state && <StatusBadge state={state} t={t} />}
                </div>
                <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">{t(hintKey)}</p>

                {state === 'prompt' && (
                  <button
                    onClick={requestFns[key]}
                    disabled={busy === key}
                    className="mt-2.5 skeuo-btn-emerald text-xs font-black px-3 py-1.5 rounded-full shadow-xs transition-all active:scale-95 cursor-pointer disabled:opacity-60"
                  >
                    {busy === key ? t('permissions.requesting') : t('permissions.allow')}
                  </button>
                )}
                {state === 'denied' && (
                  <p className="text-[11.5px] font-semibold text-amber-700 mt-2 leading-relaxed">
                    {t('permissions.deniedHint')}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[12.5px] font-semibold text-slate-400 leading-relaxed px-2">
        {t('permissions.note')}
      </p>
    </div>
  );
}
