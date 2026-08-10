/**
 * The rider's side: get offered a pickup, walk the stalls, leave the market.
 *
 * Dispatch picks whoever is nearest the market, so `reportLocation` is not
 * optional decoration — a rider who never reports a position is invisible to
 * the engine no matter what their duty status says.
 */

import { api } from './apiClient';

/**
 * Send the current position.
 *
 * The delivery app has been running `watchPosition` while online all along and
 * throwing the result away. The server treats a position older than a couple of
 * minutes as gone, because an app killed by the OS never gets to say goodbye —
 * so this needs to keep flowing, not fire once.
 */
export async function reportLocation({ lat, lng }) {
  const result = await api.post('/rider/location', { lat, lng });
  return result.data;
}

export async function setDutyStatus(dutyStatus) {
  const result = await api.patch('/rider/duty', { dutyStatus });
  return result.data;
}

/**
 * What this rider should be looking at.
 *
 * @returns {Promise<{assigned: Array, offers: Array}>} `offers` are pickups
 *   being offered right now — either picked for this rider specifically, or
 *   fallen through to the open pool. `assigned` is already theirs.
 */
export async function fetchRiderOrders() {
  const result = await api.get('/rider/orders');
  return result.data;
}

/** @throws {ApiRequestError} 409 OFFER_GONE when another rider got there first */
export async function acceptPickup(orderId) {
  const result = await api.post(`/rider/orders/${orderId}/accept`);
  return result.data;
}

export async function declinePickup(orderId) {
  const result = await api.post(`/rider/orders/${orderId}/decline`);
  return result.data;
}

/**
 * Bags collected from one stall, proved by the code on the shopkeeper's screen.
 *
 * Ticking the last stall is what sends the order out for delivery — there is no
 * separate "I'm leaving" step to forget.
 *
 * The code is not a formality. It is the only evidence the rider is actually at
 * the stall, and entering the first one correctly is what unlocks the
 * customer's name, phone and pin on the returned job — see `customerUnlocked`.
 * There is no client-side check of it anywhere, deliberately: the expected value
 * is never sent to this app.
 *
 * @throws {ApiRequestError} 400 `PICKUP_CODE_INVALID`, 429 `PICKUP_ATTEMPTS_EXCEEDED`
 */
export async function collectFromStall(orderId, stallId, code) {
  const result = await api.post(`/rider/orders/${orderId}/collect`, { stallId, code });
  return result.data;
}

/** Handed over at the door. COD is marked collected at this moment. */
export async function markDelivered(orderId) {
  const result = await api.post(`/rider/orders/${orderId}/deliver`);
  return result.data;
}

/**
 * Why this rider is not reaching dispatch, in a form a screen can render.
 *
 * `kind` separates the two failures that look identical from the outside and
 * are not: `geolocation` means we never learned where the rider is, so dispatch
 * cannot see them at all; `report` means we know, but a heartbeat did not land,
 * which the next one seconds later usually fixes.
 */
export class RiderLocationError extends Error {
  constructor(kind, message, cause = null) {
    super(message);
    this.name = 'RiderLocationError';
    this.kind = kind; // 'geolocation' | 'report'
    this.cause = cause;
  }
}

/** Browser geolocation failure codes, as something readable. */
function describeGeolocationError(err) {
  // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
  switch (err?.code) {
    case 1:
      return 'Location permission is blocked, so no market can offer you a pickup. Allow location for this site, then go online again.';
    case 2:
      return 'Your device cannot get a location fix right now. Until it does, markets cannot offer you pickups.';
    case 3:
      return 'Still waiting for a GPS fix. Markets cannot offer you pickups until your position comes through.';
    default:
      return 'Your position is not reaching us, so markets cannot offer you pickups.';
  }
}

/**
 * Start pushing this rider's position to the server.
 *
 * Wraps `watchPosition` and throttles the uploads — GPS fires far more often
 * than dispatch needs, and every send is a write.
 *
 * `onPosition` receives every fix, unthrottled, because the two consumers want
 * different rates: the server needs a heartbeat every fifteen seconds, while the
 * map wants the rider's dot to move as smoothly as the hardware allows. Running
 * a second `watchPosition` for the map would mean two GPS subscriptions draining
 * the same battery to learn the same thing.
 *
 * A GEOLOCATION FAILURE IS REPORTED, NOT SWALLOWED. `watchPosition`'s error
 * callback used to be `() => {}` and the missing-API case returned a silent
 * no-op, so a rider who had denied the permission sat "online" reading "you
 * will be offered the nearest one as soon as a market has an order ready" —
 * which was never going to happen, because dispatch matches on
 * `rider.lastLocation` and theirs was never set. The panel needs to be able to
 * say so.
 *
 * @param {{intervalMs?: number, onError?: Function, onPosition?: Function}} [options]
 *   `onError` receives a {@link RiderLocationError}.
 * @returns {() => void} call to stop watching
 */
export function startLocationReporting({ intervalMs = 15000, onError, onPosition } = {}) {
  if (!navigator.geolocation) {
    if (onError) {
      onError(
        new RiderLocationError(
          'geolocation',
          'This browser cannot share a location, so markets cannot offer you pickups.'
        )
      );
    }
    return () => {};
  }

  let lastSent = 0;
  let latest = null;
  let stopped = false;

  const send = async () => {
    if (stopped || !latest) return;
    const now = Date.now();
    if (now - lastSent < intervalMs) return;
    lastSent = now;
    try {
      // Only lat and lng go over the wire. The accuracy and heading kept above
      // are for the map; POST /rider/location validates with `.strict()`, so
      // sending them would fail the whole heartbeat with a 400.
      await reportLocation({ lat: latest.lat, lng: latest.lng });
    } catch (err) {
      // A dropped heartbeat is not worth alarming anyone about: the next one is
      // seconds away. Reported all the same, tagged so the panel can treat it
      // more gently than a position it never had.
      if (onError) {
        onError(new RiderLocationError('report', 'Could not send your position just now. Retrying.', err));
      }
    }
  };

  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      latest = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading,
      };
      if (onPosition) onPosition(latest);
      send();
    },
    (err) => {
      if (onError) {
        onError(new RiderLocationError('geolocation', describeGeolocationError(err), err));
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );

  // GPS can go quiet when the rider is standing still; a timer keeps the
  // position fresh so they do not silently age out of dispatch while waiting.
  const timer = setInterval(send, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
    navigator.geolocation.clearWatch(watchId);
  };
}
