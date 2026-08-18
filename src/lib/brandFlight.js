/**
 * Carrying the wordmark from the launch screen onto the login screen.
 *
 * The splash ends on a lockup — droplet, plate, "VegDrop" — and whatever comes
 * next opens on half of it. The login screen carries the same wordmark: same
 * face, same weight, same tracking, same two-pixel letterpress under each half
 * (see `.vd-splash-wordmark` and `.si-hero-wordmark` in index.css, which are
 * deliberately kept in step). The home screen carries the same droplet, in the
 * header badge, since both now render `VegDropMark`. Only the size and the
 * place on screen differ. Cutting between them redraws a mark the eye is
 * already resting on, which reads as two screens that happen to share a logo;
 * moving it reads as one screen becoming the next.
 *
 * The two halves cannot hand over directly. Each app renders the splash or the
 * screen behind it, never both, so the splash has already unmounted by the time
 * the next one mounts and there is no frame in which the two marks coexist.
 * This module is that seam: the splash publishes where its mark was standing as
 * it leaves, and the arriving screen — if it mounts soon enough afterwards —
 * claims that position and plays its own copy from there into place. FLIP:
 * measure both, invert the difference onto the arriving element, animate the
 * inversion away.
 *
 * Keyed, because the two handoffs carry different things and must not be able
 * to settle each other's: a login screen that somehow mounted after a home
 * handoff would otherwise fly its wordmark in from wherever the droplet was.
 *
 * Deliberately not `document.startViewTransition`. It is the shorter way to
 * write this and the wrong tool for it here: it snapshots the whole page and
 * cross-fades everything not explicitly named, which is precisely the abrupt
 * redraw of the produce rows and the form that the staged arrival avoids; it
 * needs the before and after to be one synchronous DOM update, which under
 * React 18 means wrapping the swap in `flushSync`; and it still needs this
 * fallback written out for anything that does not support it. Inverting one
 * element costs less and behaves identically everywhere.
 *
 * Held on `window` for the same reason `__vdSplashT0` in SplashScreen.jsx is:
 * the publisher sits in the entry chunk and the claimant in a lazily-loaded
 * one, so a module-scoped variable is only shared if the bundler happens to
 * keep this module in a single place — a fact about the build rather than a
 * guarantee, and two copies would mean a flight that is published into one and
 * claimed from the other. "Where the mark was last seen" is a fact about the
 * document, so that is where it lives.
 */

/** How long a mark takes to fly to its new home, unless a caller says otherwise. */
export const FLIGHT_MS = 560;

/** Fast out of the gate and a long settle — arriving somewhere, not sliding on a rail. */
const FLIGHT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * A frame gap at or under this is taken as evidence the browser is keeping up.
 * Generously above 16.7ms, because the job is to tell a working frame from a
 * 90ms one, not to hold out for a perfect 60Hz.
 */
const SMOOTH_FRAME_MS = 26;

/** How long to wait for that evidence before going anyway. */
const SETTLE_CAP_MS = 280;

/**
 * The longest flight, plus whatever it may spend waiting to start, plus the
 * tail of any arrival played around it.
 */
export const ARRIVAL_MS = 1400;

/**
 * Hold the mark at its origin until the browser can actually draw it moving.
 *
 * The arriving screen's first layout and paint land in exactly the frames the
 * flight would be starting in, and that frame is long: 94ms on the shop,
 * measured on production. Against a front-loaded curve one dropped frame like
 * that swallows more than half the journey, so the mark appears to teleport and
 * then ease the last little way — the opposite of what carrying it is for.
 *
 * So the flight waits for evidence that frames are flowing: the first pair of
 * consecutive ones close enough together to be a real frame. Adaptive rather
 * than a fixed delay, because the wait a fast device needs is nearly nothing
 * and the wait a slow one needs is longer than anything worth hard-coding.
 * Capped, because a device that never manages a smooth frame must still get its
 * mark home.
 *
 * The waiting costs nothing to look at: `fill: 'backwards'` holds the mark
 * exactly where the last screen left it, which is the frame already on screen.
 */
function playWhenSmooth(animation, onStart) {
  const startedAt = performance.now();
  let previous = startedAt;

  const check = () => {
    const now = performance.now();
    if (now - previous <= SMOOTH_FRAME_MS || now - startedAt >= SETTLE_CAP_MS) {
      animation.play();
      if (onStart) onStart();
      return;
    }
    previous = now;
    requestAnimationFrame(check);
  };

  requestAnimationFrame(check);
}

/**
 * How long a published position stays claimable.
 *
 * Long enough to cover the splash's own exit and a slow login mount behind it;
 * short enough that reaching the login screen any other way — signing out,
 * tapping Login from the shop an hour later — cannot inherit a flight from a
 * launch that finished long ago and fling the wordmark in from wherever the
 * splash happened to leave it.
 */
const MAX_AGE_MS = 1400;

/**
 * Every part of this is decoration, so all of it is declined together: the
 * splash checks this before publishing and does its ordinary fade instead, and
 * the claim below refuses even if something did publish. Two gates rather than
 * one because the two ends are in different components and either could gain a
 * caller later.
 */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Record where the leaving mark is standing, under the key that says which mark
 * it is — `wordmark` for the login screen, `mark` for the home screen's badge.
 *
 * Called at the END of the splash's exit rather than the start, because one of
 * the two exits moves the thing it is handing over: closing the plate lets the
 * lockup row re-centre, which walks the droplet back to the middle of the
 * screen. Measuring first and animating afterwards would publish a position the
 * mark has since left.
 */
export function publishBrandFlight(key, el) {
  if (typeof window === 'undefined' || !el) return false;

  const { left, top, width, height } = el.getBoundingClientRect();
  // A zero box means the element is display:none or not laid out — there is no
  // position to carry, and publishing one would land the flight at the origin.
  if (!width || !height) return false;

  window.__vdBrandFlight = { key, left, top, width, height, at: performance.now() };
  return true;
}

/** Single use: a position is claimed once, by its own key, or it is stale. */
function takeBrandOrigin(key) {
  if (typeof window === 'undefined') return null;
  const pending = window.__vdBrandFlight;
  if (!pending) return null;

  if (performance.now() - pending.at > MAX_AGE_MS) {
    window.__vdBrandFlight = null;
    return null;
  }
  // Left in place on a key mismatch rather than cleared: this claimant is not
  // the one it was published for, and the one it WAS published for may still be
  // on its way. It expires on its own either way.
  if (pending.key !== key) return null;

  window.__vdBrandFlight = null;
  return pending;
}

/**
 * Fly `el` in from wherever the last screen left the mark named by `key`.
 *
 * Returns the running `Animation` so the caller can wait on it, or null when
 * there is nothing to carry — no publisher, a different one, a stale one,
 * reduced motion, or a target that happens to already be where the origin was.
 * Callers should treat null as "arrive normally", never as an error.
 *
 * `options.measure` names a different element to take the size and centre from
 * while still animating `el`. The home screen's badge needs it: what the splash
 * published is a bare droplet, and the badge is a green squircle with a droplet
 * inside it at about two thirds the width. Scaling the badge to the droplet's
 * size would land a mark two thirds too small. Measuring the glyph and moving
 * its frame works because the two are concentric — scaling the badge about its
 * own centre scales the glyph about that same centre.
 *
 * `options.duration` is how a longer journey asks for more room, and
 * `options.onStart` fires when the flight actually begins moving — which is not
 * when this returns; see `playWhenSmooth`.
 *
 * Call it from a layout effect. It measures, so it needs the DOM laid out; and
 * it must apply before the frame is painted, or the mark shows for one frame at
 * its destination before jumping back to the origin to start.
 */
export function claimBrandFlight(key, el, options = {}) {
  if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return null;

  // Only a real target consumes the origin, so a login screen with no wordmark
  // of its own (the shopkeeper and delivery heroes paint theirs into the
  // artwork) cannot swallow a flight meant for one that has.
  const from = takeBrandOrigin(key);
  if (!from) return null;

  const to = (options.measure || el).getBoundingClientRect();
  if (!to.width || !from.width) return null;

  // Same drawing at both ends, so the width ratio is the size ratio — no
  // separate vertical scale, which would stretch the mark if either end's
  // proportions ever drifted.
  const scale = from.width / to.width;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);

  // Already there. A zero-length flight is not free: it still costs the page
  // its staggered arrival, for a move nobody can see.
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02) return null;

  const animation = el.animate(
    [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'none' }],
    {
      duration: options.duration || FLIGHT_MS,
      easing: FLIGHT_EASING,
      // Without this the element paints at its destination for the frame
      // between `animate()` and the animation's own start time, which is the
      // single-frame flicker this whole approach exists to avoid. It is also
      // what makes the wait below invisible.
      fill: 'backwards',
    },
  );

  animation.pause();
  playWhenSmooth(animation, options.onStart);
  return animation;
}
