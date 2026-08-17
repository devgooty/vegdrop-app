import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLanguage } from '../i18n/LanguageContext';

/** When the lockup has finished assembling and the screen may hand over. */
const HOLD_UNTIL = 2450;
/** Must stay in step with the wrapper's `duration-700` fade below. */
const FADE_MS = 700;

/**
 * The launch screen, shared by all three apps.
 *
 * This used to be a 1.5 MB `public/splash.mp4` playing full-bleed. It is now
 * drawn with SVG and CSS keyframes (see `.vd-splash-*` in src/index.css), which
 * removes the largest asset on the critical path and, more importantly, removes
 * a class of bug the video could not avoid: muted autoplay is a request a
 * browser is free to refuse — iOS low-power mode, data saver, enterprise policy
 * — and a refused video sits on its first frame while firing no event at all.
 * The old code needed a hard timeout purely to survive that. Keyframes cannot
 * be declined, so the timer below is only the schedule, not a rescue.
 *
 * `onComplete` is optional, and its absence means something specific.
 * AppRouter renders this as the Suspense fallback while a role app's chunk
 * downloads, where there is nothing to hand over to — so with no `onComplete`
 * the screen assembles and then holds, sheen running, until the chunk resolves
 * and React swaps it out. Passing a no-op instead would fade it to transparent
 * over a page that has not rendered yet, which is a blank screen.
 */
export default function SplashScreen({ onComplete, edition }) {
  const { t, language } = useLanguage();
  const [isFading, setIsFading] = useState(false);
  const finishedRef = useRef(false);

  const handleFinish = useCallback(() => {
    if (!onComplete || finishedRef.current) return;
    finishedRef.current = true;

    setIsFading(true);
    // Unmount only once the fade has actually played out.
    setTimeout(onComplete, FADE_MS);
  }, [onComplete]);

  useEffect(() => {
    if (!onComplete) return undefined;
    const timer = setTimeout(handleFinish, HOLD_UNTIL);
    return () => clearTimeout(timer);
  }, [handleFinish, onComplete]);

  // Which app opened. The customer app carries the brand line; the two staff
  // apps say which one they are, because a rider and a shopkeeper install two
  // icons that would otherwise launch into an identical screen.
  const subKey =
    edition === 'shopkeeper'
      ? 'splash.shopkeeper'
      : edition === 'delivery'
        ? 'splash.delivery'
        : 'splash.brandline';

  // Telugu and Devanagari have no capital forms, and wide tracking pulls their
  // conjuncts apart, so the small-caps treatment is English-only. They also
  // carry vowel marks above and below the line that 10px throws away, hence the
  // extra pixel.
  const subCase =
    language === 'en' ? 'text-[10px] uppercase tracking-[0.22em]' : 'text-[11px] tracking-normal';

  return (
    <div
      className={`fixed inset-0 z-[9999] flex justify-center transition-all duration-700 ease-out ${
        isFading ? 'opacity-0 pointer-events-none blur-md scale-[1.02]' : 'opacity-100 blur-0 scale-100'
      }`}
      role="status"
      aria-live="polite"
      aria-label="VegDrop"
    >
      <div className="vd-splash-field w-full max-w-md h-full relative overflow-hidden flex flex-col items-center justify-center">
        <span className="vd-splash-ring vd-splash-ring-1" aria-hidden="true" />
        <span className="vd-splash-ring vd-splash-ring-2" aria-hidden="true" />

        {/*
          The lockup row is centred, and the plate opens from zero width. That
          is what walks the mark leftwards into its final place — no second
          animation, and the pair stays optically centred at every frame.
        */}
        <div className="relative flex items-center">
          <span className="vd-splash-mark">
            <span className="vd-splash-drop">
              <VegDropMark />
            </span>
          </span>

          <span className="vd-splash-plate">
            <span className="vd-splash-plate-fill" aria-hidden="true" />
            <span className="vd-splash-wordmark">
              <span className="text-[#1B4D3E]">Veg</span>
              <span className="text-[#C8372D]">Drop</span>
            </span>
            <span className="vd-splash-sheen" aria-hidden="true" />
          </span>

          <span className={`vd-splash-sub font-bold text-emerald-200/90 ${subCase}`}>
            {t(subKey)}
          </span>
        </div>

        <div className="absolute bottom-[16%] left-0 right-0 px-8 text-center">
          <p className="vd-splash-tag vd-splash-tag-1 text-[15px] font-bold text-white/95">
            {t('splash.tagline1')}
          </p>
          <p className="vd-splash-tag vd-splash-tag-2 text-[15px] font-bold text-emerald-300/85">
            {t('splash.tagline2')}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The droplet from `public/logo.png`, redrawn as vector.
 *
 * The PNG is the wrong tool at this size — it is a 512px raster of a flat
 * shape, and it cannot be recoloured for a dark field. Here the droplet is
 * lightened well past the logo's green so it holds contrast against the deep
 * green background, while the white lens and the two leaves inside it stay
 * exactly as the brand mark has them.
 */
function VegDropMark() {
  return (
    <svg viewBox="0 0 64 64" className="w-[4.75rem] h-[4.75rem]" aria-hidden="true">
      <defs>
        <linearGradient id="vd-drop-body" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#6EE7A8" />
          <stop offset="55%" stopColor="#34C97A" />
          <stop offset="100%" stopColor="#189B57" />
        </linearGradient>
        <linearGradient id="vd-leaf-left" x1="0%" y1="100%" x2="60%" y2="0%">
          <stop offset="0%" stopColor="#8CC63F" />
          <stop offset="100%" stopColor="#C3EC6E" />
        </linearGradient>
        <linearGradient id="vd-leaf-right" x1="100%" y1="100%" x2="40%" y2="0%">
          <stop offset="0%" stopColor="#3E9B45" />
          <stop offset="100%" stopColor="#6BC153" />
        </linearGradient>
        {/* The leaves are clipped to the lens rather than trusted to stay
            inside it. Drawn free they overshot its edge and sat half on white,
            half on the droplet's own green — which read as a printing
            misregistration rather than as a mark. */}
        <clipPath id="vd-lens-clip">
          <circle cx="32" cy="43" r="13" />
        </clipPath>
      </defs>

      {/* Teardrop: a circle of r=20 at (32,41), closed off with two long
          curves that meet at the apex. */}
      <path
        d="M32 4 C32 4 12 26 12 41 C12 52.05 20.95 61 32 61 C43.05 61 52 52.05 52 41 C52 26 32 4 32 4 Z"
        fill="url(#vd-drop-body)"
      />

      {/* The white lens the leaves sit in, exactly as the logo has it. */}
      <circle cx="32" cy="43" r="13" fill="#FFFFFF" />

      {/* Mirrored about x=32, so the pair sits square in the lens. */}
      <g clipPath="url(#vd-lens-clip)">
        <path d="M32 52 C24.5 49.5 21.5 43 23 35.5 C29.5 38.5 32.5 45 32 52 Z" fill="url(#vd-leaf-left)" />
        <path d="M32 52 C39.5 49.5 42.5 43 41 35.5 C34.5 38.5 31.5 45 32 52 Z" fill="url(#vd-leaf-right)" />
      </g>

      {/* Specular highlight — the one thing the flat PNG has no room for, and
          what stops the droplet reading as a sticker on a dark field. Narrow
          and well off-centre; anything rounder reads as a smudge once the mark
          is scaled up to fill the screen. */}
      <ellipse cx="23.5" cy="25" rx="2.5" ry="5" fill="#FFFFFF" opacity="0.3" transform="rotate(-22 23.5 25)" />
    </svg>
  );
}
