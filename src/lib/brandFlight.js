/**
 * Carrying the wordmark from the launch screen onto the login screen.
 *
 * The splash ends on a lockup — droplet, plate, "VegDrop" — and the customer
 * login opens on the same wordmark: same face, same weight, same tracking, same
 * two-pixel letterpress under each half (see `.vd-splash-wordmark` and
 * `.si-hero-wordmark` in index.css, which are deliberately kept in step). Only
 * the size and the place on screen differ. Cutting between them redraws a mark
 * the eye is already resting on, which reads as two screens that happen to
 * share a logo; moving it reads as one screen becoming the next.
 *
 * The two halves cannot hand over directly. Each app renders the splash or the
 * login, never both, so the splash has already unmounted by the time the login
 * mounts and there is no frame in which the two wordmarks coexist. This module
 * is that seam: the splash publishes where its wordmark was standing as it
 * leaves, and the login — if it mounts soon enough afterwards — claims that
 * position and plays its own wordmark from there into place. FLIP: measure
 * both, invert the difference onto the arriving element, animate the inversion
 * away.
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

/** How long the wordmark takes to fly to its new home. */
export const FLIGHT_MS = 560;

/** The flight plus the tail of the arrival the page plays around it. */
export const ARRIVAL_MS = 720;

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
 * Record where the leaving wordmark is standing. Called by the splash at the
 * moment it starts its exit, not at unmount: the exit dissolves the plate and
 * drains the droplet away but leaves the wordmark exactly where it was, so this
 * one rect stays true for the whole handoff.
 */
export function publishBrandFlight(el) {
  if (typeof window === 'undefined' || !el) return false;

  const { left, top, width, height } = el.getBoundingClientRect();
  // A zero box means the element is display:none or not laid out — there is no
  // position to carry, and publishing one would land the flight at the origin.
  if (!width || !height) return false;

  window.__vdBrandFlight = { left, top, width, height, at: performance.now() };
  return true;
}

/** Single use: a position is claimed once or it is stale. */
function takeBrandOrigin() {
  if (typeof window === 'undefined') return null;
  const pending = window.__vdBrandFlight;
  window.__vdBrandFlight = null;
  if (!pending) return null;
  return performance.now() - pending.at <= MAX_AGE_MS ? pending : null;
}

/**
 * Fly `el` in from wherever the last screen left the wordmark.
 *
 * Returns the running `Animation` so the caller can wait on it, or null when
 * there is nothing to carry — no publisher, a stale one, reduced motion, or a
 * target that happens to already be where the origin was. Callers should treat
 * null as "arrive normally", never as an error.
 *
 * Call it from a layout effect. It measures, so it needs the DOM laid out; and
 * it must apply before the frame is painted or the wordmark shows for one frame
 * at its destination before jumping back to the origin to start.
 */
export function claimBrandFlight(el) {
  if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return null;

  // Only a real target consumes the origin, so a login screen with no wordmark
  // of its own (the shopkeeper and delivery heroes paint theirs into the
  // artwork) cannot swallow a flight meant for one that has.
  const from = takeBrandOrigin();
  if (!from) return null;

  const to = el.getBoundingClientRect();
  if (!to.width || !from.width) return null;

  // Both wordmarks are the same string in the same face, so the width ratio is
  // the size ratio — no separate vertical scale, which would stretch the
  // letterforms if either line-height ever drifted.
  const scale = from.width / to.width;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);

  // Already there. A zero-length flight is not free: it still costs the page
  // its staggered arrival, for a move nobody can see.
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02) return null;

  return el.animate(
    [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'none' }],
    {
      duration: FLIGHT_MS,
      // Fast out of the gate and a long settle — the mark should look like it
      // is arriving somewhere, not sliding on a rail.
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      // Without this the element paints at its destination for the frame
      // between `animate()` and the animation's own start time, which is the
      // single-frame flicker this whole approach exists to avoid.
      fill: 'backwards',
    },
  );
}
