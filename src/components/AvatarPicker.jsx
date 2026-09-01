import React, { useState } from 'react';
import { X, Camera, Check, RefreshCw, Sparkles } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { useToast } from './Toast';
import {
  PERSON_PRESETS,
  PRODUCE_PRESETS,
  SKIN_TONES,
  HAIR_COLORS,
  DEFAULT_SKIN_TONE,
  DEFAULT_HAIR_COLOR,
  avatarPreset,
  avatarIsEditable,
} from '../data/avatars';
import AvatarArt, { hasAvatarArt } from './AvatarArt';
import { toAvatarJpeg } from '../services/imageCapture';

/**
 * Choosing a profile picture: one of the built-in avatars, or a photo.
 *
 * Nothing here writes until Save. Tapping a tile used to be the write, which
 * stopped working the moment the people arrived: picking a face and then a skin
 * tone for it would have been two saves of a half-finished avatar, and the
 * first closed the sheet before the second could be made. So the whole sheet is
 * a draft and the single write at the end is what was assembled.
 *
 * The three ways of answering are TABS rather than one long column, and that is
 * a correctness fix as much as a visual one: stacked, the fourteen tiles and
 * two swatch rows pushed Save off the bottom of a phone screen, so the one
 * control the sheet now depends on was the one thing you could not see. Each
 * tab is about a screenful, and Save sits under all of them.
 *
 * Both kinds of picture still go through the same endpoint, because they are
 * two answers to one question — saving either replaces whatever was there. The
 * caller adopts the user record the server returns rather than guessing at the
 * new state, so a refused write leaves the screen showing what is stored.
 */
export default function AvatarPicker({ user, currentPhoto, onSave, onClose }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  /**
   * The pending picture. `kind` is which of the two mutually exclusive answers
   * is being given, so switching from a photo to an avatar and back is a local
   * change of mind rather than a pair of writes that each undo the other.
   */
  const [draft, setDraft] = useState(() => ({
    kind: currentPhoto ? 'photo' : user.avatar?.preset ? 'preset' : 'none',
    preset: user.avatar?.preset || null,
    skinTone: user.avatar?.skinTone || DEFAULT_SKIN_TONE,
    hair: user.avatar?.hair || DEFAULT_HAIR_COLOR,
    image: currentPhoto || null,
  }));

  /** Opens on whatever is already being worn, rather than on a fixed tab. */
  const [tab, setTab] = useState(() => {
    if (currentPhoto) return 'photo';
    return avatarIsEditable(user.avatar?.preset) ? 'people' : 'produce';
  });

  const edit = (patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const previewPreset = draft.kind === 'preset' ? avatarPreset(draft.preset) : null;
  const isEditable = draft.kind === 'preset' && avatarIsEditable(draft.preset);

  /**
   * Remounts the preview on every change of choice, which is what replays the
   * pop. Keyed on the whole answer and not just the preset, so changing a skin
   * tone gets the same acknowledgement as changing the face.
   */
  const previewKey = `${draft.kind}:${draft.preset}:${draft.skinTone}:${draft.hair}`;

  /**
   * Somewhere to start for anyone who does not want to assemble a face.
   *
   * Deliberately whole-cast rather than people-only: a vegetable is a perfectly
   * good answer here, and a shuffle that never offered one would quietly say
   * otherwise.
   */
  const handleSurprise = () => {
    const all = [...PERSON_PRESETS, ...PRODUCE_PRESETS];
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const preset = pick(all);

    edit({
      kind: 'preset',
      preset: preset.key,
      skinTone: pick(SKIN_TONES).key,
      hair: pick(HAIR_COLORS).key,
    });
    setTab(avatarIsEditable(preset.key) ? 'people' : 'produce');
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    // Let the same file be chosen again after a failure.
    event.target.value = '';
    if (!file) return;

    setBusy(true);
    try {
      // A camera original is several megabytes and the limit is 40 KB, so this
      // has to happen before anything is held, let alone sent.
      edit({ kind: 'photo', image: await toAvatarJpeg(file) });
    } catch (err) {
      toast.error(err.message || t('avatar.failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (busy) return;

    // Nothing to write — the sheet was opened and closed again.
    if (draft.kind === 'none' || (draft.kind === 'photo' && draft.image === currentPhoto)) {
      onClose();
      return;
    }

    setBusy(true);
    try {
      await onSave(
        draft.kind === 'photo'
          ? { image: draft.image }
          : {
              preset: draft.preset,
              // Sent only for a picture that has them. A tomato carrying a skin
              // tone would be a stored value nothing can ever render.
              ...(isEditable ? { skinTone: draft.skinTone, hair: draft.hair } : {}),
            }
      );
      onClose();
    } catch (err) {
      toast.error(err.message || t('avatar.failed'));
    } finally {
      setBusy(false);
    }
  };

  const tile = (preset, { large = false } = {}) => {
    const isCurrent = draft.kind === 'preset' && draft.preset === preset.key;
    return (
      <button
        key={preset.key}
        onClick={() => edit({ kind: 'preset', preset: preset.key })}
        disabled={busy}
        aria-label={preset.key}
        aria-pressed={isCurrent}
        className={`relative ${large ? 'aspect-[3/2]' : 'aspect-square'} rounded-2xl overflow-hidden flex items-end justify-center text-2xl transition-all duration-200 active:scale-95 cursor-pointer disabled:opacity-50 ${
          isCurrent
            ? 'ring-2 ring-emerald-500 ring-offset-2 shadow-[0_6px_16px_rgba(16,122,87,0.22)]'
            : 'ring-1 ring-slate-200/70 hover:ring-slate-300 hover:-translate-y-0.5'
        }`}
        style={{ background: `linear-gradient(145deg, ${preset.from} 0%, ${preset.to} 100%)` }}
      >
        {hasAvatarArt(preset.key) ? (
          // Staggered by roster position, so the set reads as a cast of
          // characters rather than one mechanism moving in lockstep.
          <AvatarArt
            avatarKey={preset.key}
            options={draft}
            delay={avatarPreset(preset.key).index * 240}
            className={large ? 'h-[96%]' : 'w-[92%] h-[92%]'}
          />
        ) : (
          <span className="mb-2" aria-hidden="true">{preset.emoji}</span>
        )}
        {isCurrent && (
          <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-sm">
            <Check className="w-3 h-3" strokeWidth={3} />
          </span>
        )}
      </button>
    );
  };

  const swatchRow = (label, options, current, onPick) => (
    <div>
      <p className="text-[0.65rem] font-black uppercase tracking-wider text-slate-400 mb-1.5">{label}</p>
      <div className="flex gap-2.5">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onPick(option.key)}
            disabled={busy}
            aria-label={option.key}
            aria-pressed={current === option.key}
            className={`w-8 h-8 rounded-full transition-all duration-200 active:scale-90 cursor-pointer disabled:opacity-50 ${
              current === option.key
                ? 'ring-2 ring-emerald-500 ring-offset-2 scale-110'
                : 'ring-1 ring-black/10 hover:scale-105'
            }`}
            style={{ background: `linear-gradient(145deg, ${option.hex} 0%, ${option.shade} 100%)` }}
          />
        ))}
      </div>
    </div>
  );

  const TABS = [
    { id: 'people', label: t('avatar.people') },
    { id: 'produce', label: t('avatar.produce') },
    { id: 'photo', label: t('avatar.photo') },
  ];

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-t-[2rem] sm:rounded-[2rem] w-full sm:max-w-sm shadow-2xl border border-gray-100 max-h-[88vh] flex flex-col animate-scale-in overflow-hidden">
        {/*
          A band of the chosen avatar's own colours behind the preview, so the
          top of the sheet belongs to the picture rather than being white space
          above it. It changes with the pick, which is half of the feedback.
        */}
        <div
          className="relative px-5 pt-4 pb-3 transition-[background] duration-500"
          style={{
            background: previewPreset
              ? `linear-gradient(160deg, ${previewPreset.from} 0%, ${previewPreset.to} 130%)`
              : 'linear-gradient(160deg, #F1F5F9 0%, #E2E8F0 130%)',
          }}
        >
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-black text-[#123B2F] text-base leading-tight">{t('avatar.title')}</h3>
              <p className="text-[0.7rem] font-semibold text-[#123B2F]/55 mt-0.5">{t('avatar.subtitle')}</p>
            </div>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="p-1.5 rounded-xl text-[#123B2F]/40 hover:text-[#123B2F] hover:bg-white/50 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex flex-col items-center -mt-2">
            <div className="relative w-24 h-24">
              <div className="vd-avatar-halo absolute -inset-2 rounded-full bg-white/70" />
              <div
                key={previewKey}
                className="vd-avatar-pop relative w-24 h-24 rounded-full overflow-hidden ring-4 ring-white shadow-[0_10px_28px_rgba(15,60,45,0.22)]"
              >
                {draft.kind === 'photo' && draft.image ? (
                  <img src={draft.image} alt="" className="w-full h-full object-cover bg-emerald-50" />
                ) : previewPreset ? (
                  <div
                    className="w-full h-full flex items-center justify-center overflow-hidden"
                    style={{ background: `linear-gradient(145deg, ${previewPreset.from} 0%, ${previewPreset.to} 100%)` }}
                  >
                    {hasAvatarArt(previewPreset.key) ? (
                      <AvatarArt
                        avatarKey={previewPreset.key}
                        options={draft}
                        className="w-[86%] h-[86%] translate-y-[6%]"
                      />
                    ) : (
                      <span className="text-4xl" aria-hidden="true">{previewPreset.emoji}</span>
                    )}
                  </div>
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] flex items-center justify-center font-extrabold text-white text-3xl">
                    {(user.name || '?').charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handleSurprise}
              disabled={busy}
              className="mt-2.5 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white/85 hover:bg-white text-[#123B2F] text-[0.7rem] font-black shadow-[0_2px_10px_rgba(15,60,45,0.14)] active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-500" /> {t('avatar.surprise')}
            </button>
          </div>
        </div>

        <div className="px-5 pt-4">
          <div className="flex p-1 bg-slate-100 rounded-2xl" role="tablist">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className={`flex-1 py-2 rounded-xl text-[0.72rem] font-black transition-all cursor-pointer ${
                  tab === entry.id
                    ? 'bg-white text-[#1B4D3E] shadow-[0_2px_8px_rgba(15,60,45,0.12)]'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {tab === 'people' && (
            <div className="space-y-3">
              {/*
                Two tiles, so they are drawn at the size two tiles deserve —
                in the four-up grid the produce uses they sat beside two empty
                cells, which read as a row that had failed to load.
              */}
              <div className="grid grid-cols-2 gap-3">
                {PERSON_PRESETS.map((preset) => tile(preset, { large: true }))}
              </div>

              {isEditable ? (
                <div className="space-y-3 p-3 rounded-2xl bg-slate-50/80 border border-slate-100">
                  {swatchRow(t('avatar.skin'), SKIN_TONES, draft.skinTone, (key) => edit({ skinTone: key }))}
                  {swatchRow(t('avatar.hair'), HAIR_COLORS, draft.hair, (key) => edit({ hair: key }))}
                </div>
              ) : (
                <p className="text-[0.72rem] font-semibold text-slate-400 text-center px-4">
                  {t('avatar.peopleHint')}
                </p>
              )}
            </div>
          )}

          {tab === 'produce' && (
            <div className="grid grid-cols-4 gap-2.5">
              {PRODUCE_PRESETS.map((preset) => tile(preset))}
            </div>
          )}

          {tab === 'photo' && (
            <label className={`block ${busy ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}>
              <input type="file" accept="image/*" onChange={handleFile} className="hidden" disabled={busy} />
              <span className="flex flex-col items-center justify-center gap-2 w-full bg-slate-50/70 border-2 border-dashed border-slate-300 rounded-2xl py-9 active:scale-[0.99] transition hover:border-emerald-400 hover:bg-emerald-50/40">
                <span className="w-11 h-11 rounded-full bg-white shadow-sm flex items-center justify-center">
                  <Camera className="w-5 h-5 text-[#1B4D3E]" />
                </span>
                <span className="text-sm font-black text-[#1B4D3E]">{t('avatar.upload')}</span>
                <span className="text-[0.68rem] font-semibold text-slate-400">{t('avatar.photoHint')}</span>
              </span>
            </label>
          )}
        </div>

        {/*
          Outside the scrolling area, so the one control the sheet depends on is
          never the thing below the fold.
        */}
        <div className="px-5 pb-5 pt-1 border-t border-slate-100">
          <button
            onClick={handleSave}
            disabled={busy || !dirty}
            className="w-full flex items-center justify-center gap-2 bg-[#1B4D3E] text-white rounded-2xl py-3.5 text-sm font-black shadow-[0_6px_18px_rgba(27,77,62,0.28)] active:scale-[0.99] transition disabled:opacity-40 disabled:shadow-none disabled:active:scale-100 cursor-pointer disabled:cursor-not-allowed"
          >
            {busy
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> {t('avatar.working')}</>
              : <><Check className="w-4 h-4" strokeWidth={3} /> {t('avatar.save')}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
