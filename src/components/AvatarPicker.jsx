import React, { useState } from 'react';
import { X, Camera, Trash2, Check, RefreshCw } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { useToast } from './Toast';
import { AVATAR_PRESETS } from '../data/avatars';
import AvatarArt, { hasAvatarArt } from './AvatarArt';
import { toAvatarJpeg } from '../services/imageCapture';

/**
 * Choosing a profile picture: one of the built-in avatars, or a photo.
 *
 * Both write through the same endpoint because they are two answers to one
 * question — picking either replaces whatever was there. The caller adopts the
 * user record the server returns rather than guessing at the new state, so a
 * refused write leaves the screen showing what is actually stored.
 */
export default function AvatarPicker({ user, currentPhoto, onSelectPreset, onUploadPhoto, onClear, onClose }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const hasPicture = Boolean(currentPhoto) || Boolean(user.avatar?.preset);

  const run = async (action) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      onClose();
    } catch (err) {
      toast.error(err.message || t('avatar.failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    // Let the same file be chosen again after a failure.
    event.target.value = '';
    if (!file) return;

    // A camera original is several megabytes and the limit is 40 KB, so this
    // has to happen before anything reaches the network.
    await run(async () => onUploadPhoto(await toAvatarJpeg(file)));
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-t-[2rem] sm:rounded-[2rem] w-full sm:max-w-sm p-5 shadow-2xl border border-gray-100 max-h-[85vh] overflow-y-auto animate-scale-in">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-black text-[#1B4D3E] text-base">{t('avatar.title')}</h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2.5 mb-5">
          {AVATAR_PRESETS.map((preset, index) => {
            const isCurrent = user.avatar?.preset === preset.key && !currentPhoto;
            return (
              <button
                key={preset.key}
                onClick={() => run(() => onSelectPreset(preset.key))}
                disabled={busy}
                aria-label={preset.key}
                aria-pressed={isCurrent}
                className={`relative aspect-square rounded-2xl overflow-hidden flex items-end justify-center text-2xl transition-all active:scale-95 cursor-pointer disabled:opacity-50 ${
                  isCurrent
                    ? 'ring-2 ring-emerald-500 ring-offset-2'
                    : 'ring-1 ring-slate-200/70 hover:ring-slate-300'
                }`}
                style={{ background: `linear-gradient(145deg, ${preset.from} 0%, ${preset.to} 100%)` }}
              >
                {hasAvatarArt(preset.key) ? (
                  // Staggered by grid position, so twelve mascots read as twelve
                  // characters rather than one mechanism moving in lockstep.
                  <AvatarArt avatarKey={preset.key} delay={index * 240} className="w-[92%] h-[92%]" />
                ) : (
                  <span className="mb-2" aria-hidden="true">{preset.emoji}</span>
                )}
                {isCurrent && (
                  <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-sm">
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="space-y-2">
          <label className={`block ${busy ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}>
            <input type="file" accept="image/*" onChange={handleFile} className="hidden" disabled={busy} />
            <span className="flex items-center justify-center gap-2 w-full bg-white border-2 border-dashed border-slate-300 rounded-2xl py-3 text-sm font-bold text-[#1B4D3E] active:scale-[0.99] transition">
              {busy
                ? <><RefreshCw className="w-4 h-4 animate-spin" /> {t('avatar.working')}</>
                : <><Camera className="w-4 h-4" /> {t('avatar.upload')}</>}
            </span>
          </label>

          {hasPicture && (
            <button
              onClick={() => run(onClear)}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 text-rose-600/80 hover:text-rose-700 text-xs font-bold py-2 rounded-xl transition-colors cursor-pointer hover:bg-rose-50/60 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" /> {t('avatar.remove')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
