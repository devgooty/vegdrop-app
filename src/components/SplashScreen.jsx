import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import { publishBrandFlight, prefersReducedMotion } from '../lib/brandFlight';
import VegDropMark from './VegDropMark';

/** When the lockup has finished assembling and the screen may hand over. */
const HOLD_UNTIL = 2260;
/** Must stay in step with the wrapper's `duration-500` fade below. */
const FADE_MS = 500;
/**
 * The other endings: rather than fading over the next screen, the lockup comes
 * apart and leaves one piece of itself behind for that screen to pick up.
 *
 * `login` keeps the wordmark, because the login screen opens on the same
 * logotype. `home` keeps the droplet, because the home screen's header badge
 * does. Which piece survives decides which one is published, so the two live
 * together here rather than being spelled out again at each use.
 *
 * Both are shorter than the fade because nothing is waiting on them — the next
 * screen is not revealed by these endings, it continues them. Each `ms` must
 * stay in step with the matching `.vd-splash-handoff-*` rules in src/index.css.
 */
const HANDOFF = {
  login: { key: 'wordmark', ms: 380 },
  home: { key: 'mark', ms: 400 },
};

/**
 * When this launch's animation started, shared by every instance of it.
 *
 * There is never just one splash instance per launch. AppRouter shows one while
 * a role app's chunk downloads, and the app inside that chunk renders its own —
 * a different position in the tree, so React unmounts the first and mounts the
 * second, and CSS animations start from zero on mount. Left alone that makes
 * the drop fall, snap back and fall again.
 *
 * On `window` rather than in a module variable on purpose. A module variable is
 * only shared if the bundler keeps this module in one chunk for both importers,
 * which is a fact about the build rather than a guarantee; two copies would
 * mean two clocks and the second instance restarting from zero. The document is
 * the real scope of "when did this launch begin", so that is where it lives.
 */
function launchStart() {
  if (typeof window === 'undefined') return 0;
  if (window.__vdSplashT0 == null) window.__vdSplashT0 = performance.now();
  return window.__vdSplashT0;
}

/** Impact droplets. Each n has its own vector and lag in src/index.css. */
const SPARKS = [1, 2, 3, 4, 5, 6];

/**
 * What the sky is doing, so the launch screen is not the same picture at 6am
 * and at 10pm.
 *
 * There are four skies and only three greetings, deliberately. "Good night" is
 * a farewell in English and both `शुभ रात्रि` and `శుభ రాత్రి` are read the same
 * way — saying it to someone who has just opened the app to order vegetables is
 * telling them goodbye on arrival. Late hours therefore keep the evening
 * greeting and change only the picture, which is the half that can say "it is
 * night" without saying anything wrong.
 *
 * Read from the device clock: no network, no permission, nothing to fail. A
 * wrong clock costs a wrong picture and nothing else.
 */
function readSky(hour) {
  if (hour >= 5 && hour < 12) return { art: 'dawn', greet: 'splash.greetMorning' };
  if (hour >= 12 && hour < 17) return { art: 'day', greet: 'splash.greetAfternoon' };
  if (hour >= 17 && hour < 21) return { art: 'dusk', greet: 'splash.greetEvening' };
  return { art: 'night', greet: 'splash.greetEvening' };
}

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
export default function SplashScreen({ onComplete, edition, handoff }) {
  const { t, language } = useLanguage();
  /** null while the screen is up, then which of the two exits is playing. */
  const [exit, setExit] = useState(null);
  const finishedRef = useRef(false);
  const rootRef = useRef(null);
  const wordmarkRef = useRef(null);
  const markRef = useRef(null);
  /** How far into the sequence this instance actually started. Set at paint. */
  const offsetRef = useRef(0);

  /**
   * Wind this instance's animations forward to where the launch already is.
   *
   * The previous version computed the offset during render and fed it to CSS as
   * a negative `animation-delay`. That was measurably wrong: an animation does
   * not begin when React renders it, it begins when the browser paints it, and
   * for the second instance those were ~200ms apart while the 200 KB app chunk
   * evaluated. The sequence jumped back by that difference — which is precisely
   * how long the drop appeared to fall a second time.
   *
   * Seeking with the Web Animations API instead removes the guess. This runs in
   * a layout effect, so it is measured and applied after the DOM exists but
   * before the frame is painted, and `currentTime` counts from the start of an
   * animation's delay — so one value applied to every animation lands the whole
   * sequence, ripples and sheen included, exactly where the last instance was.
   */
  useLayoutEffect(() => {
    const offset = performance.now() - launchStart();
    offsetRef.current = offset;
    if (offset <= 0 || !rootRef.current) return;

    for (const animation of rootRef.current.getAnimations({ subtree: true })) {
      try {
        animation.currentTime = offset;
      } catch {
        /* A finished or idle animation may refuse a seek; it is already where
           it needs to be. */
      }
    }
  }, []);

  /**
   * Held in a ref so the timer below does not depend on its identity. Every
   * call site passes an inline arrow, which is a new function on each render of
   * the parent — as a dependency it cleared and re-armed the timeout on every
   * one of those renders, so a parent that re-rendered faster than the hold
   * would have kept the splash up indefinitely.
   */
  const onCompleteRef = useRef(onComplete);
  /**
   * Read through a ref for the same reason, and it matters more here: the
   * customer app derives `handoff` from a session restore that can land at any
   * point during the hold, so as a dependency it would re-arm the timeout in
   * the middle of the countdown.
   */
  const handoffRef = useRef(handoff);
  useEffect(() => {
    onCompleteRef.current = onComplete;
    handoffRef.current = handoff;
  });

  const handleFinish = useCallback(() => {
    if (!onCompleteRef.current || finishedRef.current) return;
    finishedRef.current = true;

    /*
      Three ways to leave.

      The ordinary one fades the whole screen out over whatever is behind it.
      The other two hand a piece of the lockup to the screen that follows. For
      the login screen the furniture comes apart around the wordmark — greeting
      and taglines gone, plate dissolved off the words, droplet drained back
      down the way it fell in — leaving the wordmark alone on white. For the
      home screen it is the reverse: the plate closes the way it opened, which
      walks the droplet back to the middle of the screen on its own, and the
      droplet is what is left standing.

      The rect is published at the end rather than here, because that second
      exit moves what it is handing over. Measuring first would name a place the
      droplet has since left.
    */
    const carried = prefersReducedMotion() ? null : HANDOFF[handoffRef.current];

    setExit(carried ? handoffRef.current : 'fade');
    // Unmount only once that ending has actually played out.
    setTimeout(() => {
      if (carried) {
        publishBrandFlight(
          carried.key,
          carried.key === 'mark' ? markRef.current : wordmarkRef.current,
        );
      }
      onCompleteRef.current?.();
    }, carried ? carried.ms : FADE_MS);
  }, []);

  // Only whether there is somewhere to hand over to, never which function it
  // is — see the ref above.
  const canFinish = Boolean(onComplete);

  // Counted from the launch, not from this instance's mount, so a slow chunk
  // does not add its own download time to how long the splash sits on screen.
  useEffect(() => {
    if (!canFinish) return undefined;
    const timer = setTimeout(handleFinish, Math.max(0, HOLD_UNTIL - offsetRef.current));
    return () => clearTimeout(timer);
  }, [canFinish, handleFinish]);

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
    language === 'en' ? 'text-[11.5px] uppercase tracking-[0.22em]' : 'text-[12.5px] tracking-normal';

  // Read once per instance rather than per render, so the two instances of a
  // single launch cannot disagree across a midnight or a 5am boundary.
  const [sky] = useState(() => readSky(new Date().getHours()));

  return (
    <div
      /* The handoff exits deliberately change nothing on the root: this cream
         is the same cream both screens behind it use as their page background,
         so the only thing that should move is what is drawn on top of it. */
      className={`fixed inset-0 z-[9999] flex justify-center bg-[#F8F5EF] transition-all duration-500 ease-out ${
        exit === 'fade' ? 'opacity-0 pointer-events-none blur-md scale-[1.02]' : 'opacity-100 blur-0 scale-100'
      } ${exit && exit !== 'fade' ? `vd-splash-handoff vd-splash-handoff-${exit} pointer-events-none` : ''}`}
      ref={rootRef}
      role="status"
      aria-live="polite"
      aria-label="VegDrop"
    >
      <div
        className="vd-splash-field w-full max-w-md h-full relative overflow-hidden flex flex-col items-center justify-center"
        data-sky={sky.art}
      >
        {/* First child of the field on purpose — it has to cover the cream
            and its grain while staying under everything below. Invisible
            unless the screen is handing the wordmark over; see
            `.vd-splash-blanch` in src/index.css. */}
        <span className="vd-splash-blanch" aria-hidden="true" />

        <span className="vd-splash-ring vd-splash-ring-1" aria-hidden="true" />
        <span className="vd-splash-ring vd-splash-ring-2" aria-hidden="true" />

        {/* The greeting sits in the empty third above the lockup, and arrives
            before the drop does — the screen is greeting you, then showing you
            whose app it is, rather than the other way round. */}
        <div className="vd-splash-greet absolute top-[22%] left-0 right-0 flex items-center justify-center gap-3 px-8">
          <SkyMark art={sky.art} />
          {/* Larger than the tagline at the foot of the screen, and second only
              to the wordmark. It is the one line here addressed to a person
              rather than about the product, so it should not be the smallest
              thing on the screen. Muted sage rather than the brand green keeps
              it from competing with the lockup at this size. */}
          <span className="text-[20.5px] font-bold text-[#5E6B5A]">{t(sky.greet)}</span>
        </div>

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
            <span className="vd-splash-drop" ref={markRef}>
              <VegDropMark />
            </span>
          </span>

          <span className="vd-splash-plate">
            <span className="vd-splash-plate-fill" aria-hidden="true" />
            <span className="vd-splash-wordmark" ref={wordmarkRef}>
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
          <p className="vd-splash-tag vd-splash-tag-1 text-[16.5px] font-bold text-[#1B4D3E]">
            {t('splash.tagline1')}
          </p>
          <p className="vd-splash-tag vd-splash-tag-2 text-[16.5px] font-bold text-[#2D6A4F]">
            {t('splash.tagline2')}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The little sky beside the greeting.
 *
 * Four states off one 24-unit grid so they stay optically the same size next to
 * the text. `dawn` and `dusk` are the same sun at the same height with the
 * horizon rule under it — what separates them is which way the rays lean and
 * the colour, because a sunrise and a sunset differ in warmth and direction,
 * not in shape.
 */
function SkyMark({ art }) {
  const warm = art === 'dusk' ? '#D97706' : '#E8A33D';

  if (art === 'night') {
    return (
      <svg viewBox="0 0 24 24" className="w-[1.5rem] h-[1.5rem] shrink-0" aria-hidden="true">
        {/* A crescent cut out of a disc rather than drawn as an arc — an arc
            has two tapering points that go muddy at 18px. */}
        <path
          d="M19.2 15.2A8.2 8.2 0 0 1 8.9 4.9 8.2 8.2 0 1 0 19.2 15.2Z"
          fill="#7C8AA6"
        />
        <circle cx="18.4" cy="5.6" r="1.15" fill="#A8B4C9" />
        <circle cx="20.6" cy="9.4" r="0.7" fill="#A8B4C9" />
      </svg>
    );
  }

  const rising = art === 'dawn';
  const overhead = art === 'day';

  return (
    <svg viewBox="0 0 24 24" className="w-[1.5rem] h-[1.5rem] shrink-0" aria-hidden="true">
      <circle cx="12" cy={overhead ? 12 : 13} r={overhead ? 4.6 : 4.9} fill={warm} />
      <g stroke={warm} strokeWidth="1.7" strokeLinecap="round">
        {overhead ? (
          <>
            <path d="M12 3.4v2.1M12 18.5v2.1M3.4 12h2.1M18.5 12h2.1" />
            <path d="M5.9 5.9l1.5 1.5M16.6 16.6l1.5 1.5M18.1 5.9l-1.5 1.5M7.4 16.6l-1.5 1.5" />
          </>
        ) : (
          // Rays only above the horizon, and leaning the way the sun is going.
          <>
            <path d={rising ? 'M12 3.6v2' : 'M12 3.6v2'} />
            <path d={rising ? 'M4.9 7.1l1.6 1.3' : 'M6.5 8.4L4.9 7.1'} />
            <path d={rising ? 'M19.1 7.1l-1.6 1.3' : 'M17.5 8.4l1.6-1.3'} />
          </>
        )}
      </g>
      {!overhead && (
        <path
          d="M2.6 19.4h18.8"
          stroke={warm}
          strokeWidth="1.7"
          strokeLinecap="round"
          opacity="0.75"
        />
      )}
    </svg>
  );
}
