/**
 * Live positioning, for the two places that need more than "roughly where am I".
 *
 * `currentPosition` in services/markets.js remains the right call for the
 * things it serves — which markets are near me, where shall I put the delivery
 * pin. It asks for one fix, accepts a minute-old cached one, and throws away
 * everything but the coordinates, and all three of those are correct choices
 * for a screen that just wants to sort a list.
 *
 * None of them are correct for evidence. A cached fix is where the phone last
 * had signal, not where it is; a coordinate with no accuracy attached cannot be
 * judged at all, because ±8 m and ±800 m are the same two numbers on the wire.
 * So this module never reads a cache, always carries accuracy, and stamps the
 * moment of capture — see server/services/geoFence.js for what the server then
 * does with those three facts, and for an honest account of what they prove.
 */

/** Human-readable reason a fix could not be taken. Shown verbatim to the user. */
const REASONS = {
  UNSUPPORTED: 'This device cannot report its location.',
  PERMISSION_DENIED:
    'Location access is blocked. Allow it for this site in your browser settings, then try again.',
  POSITION_UNAVAILABLE:
    'Your position could not be found. Step into the open, away from a roof, and try again.',
  TIMEOUT: 'Finding your position took too long. Try again where the sky is clearer.',
};

function reasonFor(err) {
  if (err?.code === 1) return REASONS.PERMISSION_DENIED;
  if (err?.code === 2) return REASONS.POSITION_UNAVAILABLE;
  if (err?.code === 3) return REASONS.TIMEOUT;
  return REASONS.POSITION_UNAVAILABLE;
}

/** The shape everything here resolves to. `capturedAt` is an ISO string. */
function toFix(position) {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    /**
     * The browser's own 95%-confidence radius, in metres.
     *
     * Always a number per the spec, but defended anyway: a value of null or
     * undefined would sail through the server's `Number.isFinite` check as a
     * rejection rather than crashing, and a large sentinel makes that outcome
     * explicit instead of accidental.
     */
    accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : 99999,
    capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
  };
}

/**
 * One live fix, never a cached one.
 *
 * `maximumAge: 0` is the whole point and the one option that must not be
 * relaxed for speed: with any cache window at all, a phone that was at the
 * market this morning can answer instantly with that morning's coordinates and
 * the server has no way to tell.
 *
 * Rejects rather than resolving null, unlike `currentPosition`. A caller here
 * is always about to tell the user why it did not work, and a bare null forces
 * every one of them to invent the same sentence.
 */
export function liveFix({ timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error(REASONS.UNSUPPORTED));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve(toFix(position)),
      (err) => reject(new Error(reasonFor(err))),
      { enableHighAccuracy: true, timeout, maximumAge: 0 }
    );
  });
}

/**
 * A running stream of fixes, for the boundary walk.
 *
 * `watchPosition` rather than repeated `getCurrentPosition` calls, because the
 * GPS receiver settles: the first fix after a cold start is routinely ±100 m
 * and improves to ±5 m over the following seconds as more satellites lock. A
 * poll would take a fresh cold reading each time and never converge, which is
 * precisely the effect the accuracy gate would then punish the user for.
 *
 * Returns a `stop` function. Callers MUST call it — a watch left running keeps
 * the GPS radio awake and flattens a phone battery over a market shift, which
 * is a real cost for the person walking a perimeter on their own handset.
 */
export function watchFixes({ onFix, onError, timeout = 20000 }) {
  if (!navigator.geolocation) {
    onError?.(new Error(REASONS.UNSUPPORTED));
    return () => {};
  }

  const id = navigator.geolocation.watchPosition(
    (position) => onFix(toFix(position)),
    (err) => onError?.(new Error(reasonFor(err))),
    { enableHighAccuracy: true, timeout, maximumAge: 0 }
  );

  return () => navigator.geolocation.clearWatch(id);
}

/**
 * Great-circle distance in metres, mirroring the server's haversine.
 *
 * Used only for display — "you have walked 40 m since the last point" — so the
 * two implementations never have to agree to the metre. Every decision that
 * matters is taken on the server; this exists so the walk screen can show
 * progress without a round trip per step.
 */
export function metersBetween(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How good a fix is, as a word rather than a number.
 *
 * The thresholds match the server's defaults deliberately, and the copy is
 * written so that a bad reading tells the user what to DO. "Poor signal" is a
 * verdict; "step into the open" is an instruction, and the person holding the
 * phone is standing somewhere they can act on it.
 */
export function accuracyGrade(accuracyMeters, { good = 15, usable = 40 } = {}) {
  if (!Number.isFinite(accuracyMeters)) return { tone: 'bad', label: 'No signal', hint: 'Waiting for a position…' };
  const m = Math.round(accuracyMeters);
  if (accuracyMeters <= good) return { tone: 'good', label: `±${m} m`, hint: 'Good signal.' };
  if (accuracyMeters <= usable) return { tone: 'ok', label: `±${m} m`, hint: 'Usable — a little more precision would be better.' };
  return {
    tone: 'bad',
    label: `±${m} m`,
    hint: 'Too rough to record. Step away from roofs and walls and wait a moment.',
  };
}
