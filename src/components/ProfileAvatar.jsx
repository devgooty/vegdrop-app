import React from 'react';
import { avatarPreset } from '../data/avatars';
import AvatarArt, { hasAvatarArt } from './AvatarArt';

/**
 * How an account is pictured, in one place.
 *
 * Three states in a fixed order — uploaded photo, built-in avatar, initial —
 * and the last is a fallback rather than a fourth option: an account that has
 * chosen nothing, and one carrying a preset key this build does not recognise,
 * both land there. Keeping the order here means the account screen and the
 * picker cannot disagree about what someone's avatar currently is.
 */
export default function ProfileAvatar({ name, avatar, photo, className = '', emojiClassName = '' }) {
  const preset = avatarPreset(avatar?.preset);

  if (photo) {
    return (
      <img
        src={photo}
        alt=""
        className={`object-cover bg-emerald-50 ${className}`}
      />
    );
  }

  if (preset) {
    return (
      <div
        className={`flex items-center justify-center overflow-hidden ${className}`}
        style={{ background: `linear-gradient(145deg, ${preset.from} 0%, ${preset.to} 100%)` }}
      >
        {hasAvatarArt(preset.key) ? (
          // Overflows its box a little on purpose: the mascot's feet sit on the
          // bottom edge rather than floating in the middle of the circle, which
          // is what stops it reading as a sticker dropped into a badge.
          <AvatarArt
            avatarKey={preset.key}
            delay={preset.index * 240}
            className="w-[86%] h-[86%] translate-y-[6%]"
          />
        ) : (
          <span className={emojiClassName} aria-hidden="true">{preset.emoji}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] flex items-center justify-center font-extrabold text-white shadow-[inset_4px_4px_8px_rgba(0,0,0,0.6),inset_-4px_-4px_8px_rgba(255,255,255,0.1)] ${className}`}
    >
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}
