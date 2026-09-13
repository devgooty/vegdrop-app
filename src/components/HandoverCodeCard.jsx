import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, Lock, RefreshCw } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/** How often a visible code re-reads itself. See the note on the component. */
const REFRESH_MS = 15000;

function spaced(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * Refusals that mean "there is nothing here for you to show", not "something
 * broke": the order moved past this handover between polls (409), or this
 * account is not the one that holds the code (403/404). Rendered as nothing.
 */
function isNothingToShow(err) {
  return err?.code === 'CODE_NOT_AVAILABLE' || err?.status === 403 || err?.status === 404;
}

/**
 * A handover code, shown to the one person who holds it.
 *
 * Used by the shop (its pickup code), a market stall (its own pickup code) and
 * the customer (the delivery code). The rider never sees this component: they
 * are the one who types the code, so they must never be the one shown it.
 *
 * The code is fetched on demand and held only in this component's state. It
 * does not ride the polled order list and it is never written to web storage -
 * see CLAUDE.md on the removed `vegdrop_orders` mirror for why a secret meant
 * for one role must not sit anywhere another app on the origin can read.
 *
 * It re-reads itself every so often while the tab is visible, because the two
 * things that change a code happen on somebody else's phone: the rider typing
 * it (it is used up) or mistyping it five times (it locks, and the holder should
 * know to issue a new one before the rider has to ask).
 *
 * @param {() => Promise<object>} load     fetches `{ code, locked, verified, attemptsRemaining }`
 * @param {() => Promise<object>} reissue  asks for a fresh code
 * @param {string} title                   already translated, e.g. "Pickup code"
 * @param {string} hint                    already translated: who to read it to
 */
export default function HandoverCodeCard({ load, reissue, title, hint }) {
  const { t } = useLanguage();
  const [state, setState] = useState({ phase: 'loading', view: null, error: '' });
  const [renewing, setRenewing] = useState(false);

  // The parent passes fresh closures every render; a refresh should call the
  // latest one without restarting the timer each time.
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      const view = await loadRef.current();
      setState({ phase: 'ready', view, error: '' });
    } catch (err) {
      if (isNothingToShow(err)) {
        setState({ phase: 'gone', view: null, error: '' });
      } else {
        // Keep showing a code already on screen through a blip: the holder may
        // be mid-sentence reading it out.
        setState((prev) => ({ ...prev, phase: prev.view ? 'ready' : 'error', error: 'load' }));
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleReissue = async () => {
    if (renewing) return;
    setRenewing(true);
    try {
      const view = await reissue();
      setState({ phase: 'ready', view, error: '' });
    } catch (err) {
      if (isNothingToShow(err)) setState({ phase: 'gone', view: null, error: '' });
      else setState((prev) => ({ ...prev, error: 'reissue' }));
    } finally {
      setRenewing(false);
    }
  };

  if (state.phase === 'gone') return null;

  if (state.phase === 'loading') {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-3 flex items-center gap-2 text-emerald-800 text-xs font-semibold">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('handover.loading')}
      </div>
    );
  }

  const errorText =
    state.error === 'load' ? t('handover.loadFailed') : state.error === 'reissue' ? t('handover.reissueFailed') : '';
  const view = state.view;

  if (!view) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-rose-800">{errorText}</p>
        <button
          type="button"
          onClick={refresh}
          className="shrink-0 text-xs font-bold text-rose-800 underline underline-offset-2"
        >
          {t('handover.retry')}
        </button>
      </div>
    );
  }

  if (view.verified) {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800 flex items-center gap-1.5">
        <CheckCircle2 className="w-4 h-4" />
        {t('handover.confirmed')}
      </p>
    );
  }

  if (view.locked) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 space-y-2">
        <div className="flex items-start gap-2">
          <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-black text-amber-900 uppercase tracking-wide">
              {title} · {t('handover.locked')}
            </p>
            <p className="text-xs text-amber-800 leading-snug">{t('handover.lockedBody')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleReissue}
          disabled={renewing}
          className="w-full py-2 rounded-lg bg-amber-600 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-60 active:scale-95 transition-transform"
        >
          {renewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t('handover.newCode')}
        </button>
        {errorText && <p className="text-[11px] font-bold text-rose-700">{errorText}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] font-black text-emerald-800 uppercase tracking-wide flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5" />
          {title}
        </p>
        <button
          type="button"
          onClick={handleReissue}
          disabled={renewing}
          className="text-[11px] font-bold text-emerald-700 flex items-center gap-1 disabled:opacity-60"
        >
          {renewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {t('handover.newCode')}
        </button>
      </div>
      <p
        className="mt-1 text-3xl font-black text-emerald-950 tracking-[0.18em] tabular-nums text-center select-all"
        aria-label={`${title}: ${view.code.split('').join(' ')}`}
      >
        {spaced(view.code)}
      </p>
      <p className="mt-1 text-[12px] text-emerald-800 text-center leading-snug">{hint}</p>
      {view.attemptsRemaining <= 2 && (
        <p className="mt-1.5 text-[11.5px] font-bold text-amber-800 text-center">
          {t('handover.triesLeft', { count: view.attemptsRemaining })}
        </p>
      )}
      {errorText && <p className="mt-1 text-[11px] font-bold text-rose-700 text-center">{errorText}</p>}
    </div>
  );
}
