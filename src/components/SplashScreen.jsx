import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLanguage } from '../i18n/LanguageContext';

/** When the lockup has finished assembling and the screen may hand over. */
const HOLD_UNTIL = 2450;
/** Must stay in step with the wrapper's `duration-700` fade below. */
const FADE_MS = 700;

/**
 * Module load — in practice the moment the page's JavaScript starts, since
 * AppRouter imports this eagerly.
 *
 * There is never one splash instance per launch. AppRouter shows one while a
 * role app's chunk downloads, and the app that chunk contains then renders its
 * own — a different position in the tree, so React unmounts the first and
 * mounts the second. CSS animations restart on mount, which put a visible
 * hitch mid-fall: the drop fell, snapped back, and fell again.
 *
 * Every instance therefore dates its animations from here rather than from its
 * own mount, by way of a negative `--vd-elapsed` offset on each delay. The
 * second instance picks the sequence up exactly where the first left it, and
 * the countdown to hand-over is measured from here too, so a slow chunk no
 * longer adds its download time to how long the splash sits on screen.
 */
const BOOT = performance.now();

/** Impact droplets. Each n has its own vector and lag in src/index.css. */
const SPARKS = [1, 2, 3, 4, 5, 6];

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

  /** How far into the sequence this instance is starting. Read once. */
  const [elapsed] = useState(() => performance.now() - BOOT);

  /**
   * Held in a ref so the timer below does not depend on its identity. Every
   * call site passes an inline arrow, which is a new function on each render of
   * the parent — as a dependency it cleared and re-armed the timeout on every
   * one of those renders, so a parent that re-rendered faster than the hold
   * would have kept the splash up indefinitely.
   */
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  const handleFinish = useCallback(() => {
    if (!onCompleteRef.current || finishedRef.current) return;
    finishedRef.current = true;

    setIsFading(true);
    // Unmount only once the fade has actually played out.
    setTimeout(() => onCompleteRef.current?.(), FADE_MS);
  }, []);

  // Only whether there is somewhere to hand over to, never which function it
  // is — see the ref above.
  const canFinish = Boolean(onComplete);

  useEffect(() => {
    if (!canFinish) return undefined;
    const timer = setTimeout(handleFinish, Math.max(0, HOLD_UNTIL - elapsed));
    return () => clearTimeout(timer);
  }, [canFinish, handleFinish, elapsed]);

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
      className={`fixed inset-0 z-[9999] flex justify-center bg-[#F8F5EF] transition-all duration-700 ease-out ${
        isFading ? 'opacity-0 pointer-events-none blur-md scale-[1.02]' : 'opacity-100 blur-0 scale-100'
      }`}
      role="status"
      aria-live="polite"
      aria-label="VegDrop"
      // Negative, so every keyframe delay in src/index.css resolves to where
      // the sequence already is rather than to zero. See BOOT above.
      style={{ '--vd-elapsed': `-${Math.round(elapsed)}ms` }}
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
            {/* Both before the droplet, so they sit behind it. */}
            <span className="vd-splash-pad" aria-hidden="true" />
            {SPARKS.map((n) => (
              <span key={n} className={`vd-splash-spark vd-splash-spark-${n}`} aria-hidden="true" />
            ))}
            <span className="vd-splash-drop">
              <VegDropMark />
            </span>
          </span>

          <span className="vd-splash-plate">
            <span className="vd-splash-plate-fill" aria-hidden="true" />
            <span className="vd-splash-wordmark">
              <span className="vd-splash-wordmark-veg text-[#1B4D3E]">Veg</span>
              <span className="vd-splash-wordmark-drop text-[#C8372D]">Drop</span>
            </span>
            <span className="vd-splash-sheen" aria-hidden="true" />
          </span>

          {/* Brand green rather than the app's muted #8A7E6B: at 10px this
              line has to carry, and the warm grey only reaches 3.3:1 on cream.
              Same reasoning as .si-otp.is-filled's colour note. */}
          <span className={`vd-splash-sub font-bold text-[#2D6A4F] ${subCase}`}>
            <span className="vd-splash-rule" aria-hidden="true" />
            {t(subKey)}
            <span className="vd-splash-rule" aria-hidden="true" />
          </span>
        </div>

        <div className="absolute bottom-[16%] left-0 right-0 px-8 text-center">
          <p className="vd-splash-tag vd-splash-tag-1 text-[15px] font-bold text-[#1B4D3E]">
            {t('splash.tagline1')}
          </p>
          <p className="vd-splash-tag vd-splash-tag-2 text-[15px] font-bold text-[#2D6A4F]">
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
 * The PNG is the wrong tool at this size — it is a 512px raster of a flat shape
 * blown up to fill half a phone, where the edges of the lens and the leaves go
 * soft. Drawn here it stays sharp at any scale and carries the logo's own green
 * rather than an approximation of it, which is what lets the mark sit on the
 * app's cream without being restyled for the occasion.
 */
function VegDropMark() {
  return (
    <svg viewBox="0 0 64 64" className="w-[4.75rem] h-[4.75rem]" aria-hidden="true">
      <defs>
        <linearGradient id="vd-drop-body" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#3FBE73" />
          <stop offset="55%" stopColor="#1F9D4D" />
          <stop offset="100%" stopColor="#12793C" />
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

        {/* Body clip, so the modelling passes below can be drawn as plain
            shapes and cut to the silhouette instead of each one having to trace
            the teardrop's own curves. */}
        <clipPath id="vd-body-clip">
          <path d="M32 4 C32 4 12 26 12 41 C12 52.05 20.95 61 32 61 C43.05 61 52 52.05 52 41 C52 26 32 4 32 4 Z" />
        </clipPath>

        {/* The broad soft catchlight down the upper left. A gradient, not a
            shape with an edge — an edge here reads as a second object sitting
            on the droplet. */}
        <radialGradient id="vd-drop-gloss" cx="32%" cy="26%" r="52%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#FFFFFF" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>

        {/* Occlusion at the bottom edge. Without it the droplet is evenly lit
            all the way round and reads flat however bright the top is. */}
        <radialGradient id="vd-drop-depth" cx="50%" cy="88%" r="46%">
          <stop offset="0%" stopColor="#0A5B30" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#0A5B30" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Teardrop: a circle of r=20 at (32,41), closed off with two long
          curves that meet at the apex. */}
      <path
        d="M32 4 C32 4 12 26 12 41 C12 52.05 20.95 61 32 61 C43.05 61 52 52.05 52 41 C52 26 32 4 32 4 Z"
        fill="url(#vd-drop-body)"
      />

      {/* Modelling, in light-over-dark order, all cut to the silhouette. */}
      <g clipPath="url(#vd-body-clip)">
        <rect x="0" y="0" width="64" height="64" fill="url(#vd-drop-depth)" />
        <rect x="0" y="0" width="64" height="64" fill="url(#vd-drop-gloss)" />
        {/* A bright edge along the lit side, drawn by offsetting a stroked copy
            of the silhouette up and left and keeping only what lands inside.
            Same light source as the gloss and the specular pin, and most of
            what makes the body read as glass rather than as filled vector. */}
        <path
          d="M32 4 C32 4 12 26 12 41 C12 52.05 20.95 61 32 61 C43.05 61 52 52.05 52 41 C52 26 32 4 32 4 Z"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.32"
          strokeWidth="1.6"
          transform="translate(-0.9 -1.1)"
        />
      </g>

      {/* A hairline of shadow under the lens rim, so the white circle sits IN
          the droplet rather than on top of it. */}
      <circle cx="32" cy="43.5" r="13" fill="#0A5B30" opacity="0.18" />
      <circle cx="32" cy="43" r="13" fill="#FFFFFF" />

      {/* Mirrored about x=32, so the pair sits square in the lens. */}
      <g clipPath="url(#vd-lens-clip)">
        <path d="M32 52 C24.5 49.5 21.5 43 23 35.5 C29.5 38.5 32.5 45 32 52 Z" fill="url(#vd-leaf-left)" />
        <path d="M32 52 C39.5 49.5 42.5 43 41 35.5 C34.5 38.5 31.5 45 32 52 Z" fill="url(#vd-leaf-right)" />
        {/* Midribs. At 4.75rem they are barely there; at the 2.15× opening pose
            they are what keeps the leaves from reading as two plain wedges. */}
        <path d="M32 51.5 C30.8 45 28.4 40.2 24.6 36.9" stroke="#FFFFFF" strokeOpacity="0.5" strokeWidth="0.7" fill="none" strokeLinecap="round" />
        <path d="M32 51.5 C33.2 45 35.6 40.2 39.4 36.9" stroke="#FFFFFF" strokeOpacity="0.42" strokeWidth="0.7" fill="none" strokeLinecap="round" />
      </g>

      {/* Specular pin — the small hard glint that sells a wet surface, sitting
          inside the broad gloss above. Narrow and well off-centre; anything
          rounder reads as a smudge once the mark is scaled up to fill the
          screen. */}
      <ellipse cx="23.5" cy="25" rx="2.3" ry="4.6" fill="#FFFFFF" opacity="0.72" transform="rotate(-22 23.5 25)" />
    </svg>
  );
}
