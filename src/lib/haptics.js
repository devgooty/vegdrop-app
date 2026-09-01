const TAP_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="tel"]',
  'input[type="number"]',
  'input[type="email"]',
  'input[type="password"]',
  'select',
  'textarea',
  'summary',
  '[class*="cursor-pointer"]',
].join(', ');

function vibrateOnce(duration = 15) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(duration);
  }
}

/**
 * One buzz per tap on anything interactive, app-wide.
 *
 * A single delegated listener at the document root, rather than wiring an
 * onClick into every button, tab and searchbar across three apps' worth of
 * screens — that set changes constantly and a per-component approach would
 * silently miss whatever gets added after this ships. Capture phase, so a
 * component's own `stopPropagation()` can't suppress it.
 *
 * The 60ms debounce exists because a click on a `<label>` also dispatches a
 * synthetic click on the control it labels — two real click events for one
 * tap. HomeHeroBanner hit the same class of double-fire bug on scroll-driven
 * state; here a plain timestamp guard is enough since both events land in
 * the same tick.
 */
export function installTapHaptics() {
  if (typeof document === 'undefined') return () => {};

  let lastVibrateAt = 0;

  const onClick = (event) => {
    const target = event.target.closest?.(TAP_SELECTOR);
    if (!target) return;
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return;

    const now = Date.now();
    if (now - lastVibrateAt < 60) return;
    lastVibrateAt = now;
    vibrateOnce();
  };

  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
