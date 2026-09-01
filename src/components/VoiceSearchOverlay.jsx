import React, { useEffect } from 'react';
import { Mic, X } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * YouTube-style voice panel. Recognition is started by the parent on the
 * same tap that opens this — this file only draws the screen.
 */
export default function VoiceSearchOverlay({
  open,
  status = 'idle',
  liveText = '',
  onClose,
  onMicTap,
  // Overridable so a non-search caller (the notepad's voice-add) doesn't
  // announce itself as "Search by voice" to a screen reader.
  micLabel,
  // Same reason, for the on-screen status copy: the built-in strings all say
  // "search" ("Voice search needs Chrome or Edge…"), which is wrong wherever
  // this overlay isn't searching. Keyed by the same status names as the
  // headline map below; a status with no override falls back to the header
  // copy, so Header's own usage (which passes nothing) is unaffected.
  headlineOverrides = {},
}) {
  const { t } = useLanguage();
  const label = micLabel || t('header.voiceSearch');

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const listening = status === 'listening';
  const canRetry = status === 'nospeech' || status === 'failed' || status === 'network' || status === 'permission';

  const headline = {
    listening: t('header.voiceSpeakNow'),
    heard: liveText || t('header.voiceSpeakNow'),
    nospeech: t('header.voiceNoSpeech'),
    permission: headlineOverrides.permission || t('header.voicePermission'),
    network: headlineOverrides.network || t('header.voiceNetwork'),
    unsupported: headlineOverrides.unsupported || t('header.voiceUnsupported'),
    failed: headlineOverrides.failed || t('header.voiceFailed'),
    idle: t('header.voiceSpeakNow'),
  }[status] || t('header.voiceSpeakNow');

  return (
    <div
      className="vd-voice-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <button
        type="button"
        className="vd-voice-overlay-close"
        onClick={onClose}
        aria-label={t('header.voiceClose')}
      >
        <X className="w-5 h-5" />
      </button>

      <div className="vd-voice-overlay-row">
        <p className="vd-voice-overlay-title">{headline}</p>

        <button
          type="button"
          className={`vd-voice-mic ${listening ? 'is-listening' : ''}`}
          onClick={() => {
            if (canRetry) {
              onMicTap?.();
              return;
            }
            onClose?.();
          }}
          aria-label={listening ? t('header.voiceStop') : label}
        >
          <span className="vd-voice-mic-halo" aria-hidden="true" />
          {listening && <span className="vd-voice-mic-ring" aria-hidden="true" />}
          <span className="vd-voice-mic-core">
            <Mic className="w-8 h-8 text-white" strokeWidth={2.25} />
          </span>
        </button>
      </div>

      {listening && liveText ? (
        <p className="vd-voice-overlay-live">“{liveText}”</p>
      ) : null}
    </div>
  );
}
