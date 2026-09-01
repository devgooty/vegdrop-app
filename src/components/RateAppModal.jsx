import React, { useState } from 'react';
import { X, Star, RefreshCw, Check } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * Asking how the app is doing, without an app-store listing to send anyone to.
 *
 * There is nowhere else this rating goes — no published store page exists yet
 * for either app store, so a button that opened one would be a dead link
 * wearing a five-star icon. This asks in-app instead: pick a star count,
 * optionally say why, done. `onSubmit` is fire-and-forget from the caller's
 * side — the sheet does not need to know or care whether it lands in a
 * database or a log line, only that the person gets a thank-you either way.
 */
export default function RateAppModal({ onSubmit, onClose }) {
  const { t } = useLanguage();
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const shown = hovered || rating;

  const handleSubmit = async () => {
    if (busy || rating === 0) return;
    setBusy(true);
    try {
      await onSubmit?.({ rating, comment: comment.trim() });
      setSent(true);
      setTimeout(onClose, 1400);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-t-[2rem] sm:rounded-[2rem] w-full sm:max-w-sm p-5 shadow-2xl border border-gray-100 animate-scale-in">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-black text-[#1B4D3E] text-base">{t('rateApp.title')}</h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {sent ? (
          <div className="py-8 flex flex-col items-center gap-3 text-center">
            <span className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Check className="w-7 h-7" strokeWidth={2.75} />
            </span>
            <p className="font-black text-[#1B4D3E]">{t('rateApp.thanks')}</p>
          </div>
        ) : (
          <>
            <p className="text-[0.8rem] font-semibold text-slate-400 mb-5">{t('rateApp.subtitle')}</p>

            <div className="flex justify-center gap-2 mb-5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  onMouseEnter={() => setHovered(n)}
                  onMouseLeave={() => setHovered(0)}
                  disabled={busy}
                  aria-label={t('rateApp.starLabel', { count: n })}
                  aria-pressed={rating === n}
                  className="p-1 active:scale-90 transition-transform cursor-pointer disabled:opacity-50"
                >
                  <Star
                    className={`w-8 h-8 transition-colors ${
                      n <= shown ? 'text-amber-400 fill-amber-400' : 'text-slate-200 fill-slate-200'
                    }`}
                    strokeWidth={1.5}
                  />
                </button>
              ))}
            </div>

            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('rateApp.commentPlaceholder')}
              maxLength={300}
              rows={3}
              disabled={busy}
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 font-semibold text-sm text-slate-800 placeholder:text-slate-400 placeholder:font-medium focus:outline-none focus:border-emerald-400 focus:bg-white transition-all resize-none mb-4 disabled:opacity-50"
            />

            <button
              onClick={handleSubmit}
              disabled={busy || rating === 0}
              className="w-full flex items-center justify-center gap-2 bg-[#1B4D3E] text-white rounded-2xl py-3.5 text-sm font-black shadow-[0_6px_18px_rgba(27,77,62,0.28)] active:scale-[0.99] transition disabled:opacity-40 disabled:shadow-none disabled:active:scale-100 cursor-pointer disabled:cursor-not-allowed"
            >
              {busy
                ? <><RefreshCw className="w-4 h-4 animate-spin" /> {t('rateApp.working')}</>
                : t('rateApp.submit')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
