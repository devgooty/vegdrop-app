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
 * Bags collected from one stall.
 *
 * Ticking the last stall is what sends the order out for delivery — there is no
 * separate "I'm leaving" step to forget.
 */
export async function collectFromStall(orderId, stallId) {
  const result = await api.post(`/rider/orders/${orderId}/collect`, { stallId });
  return result.data;
}

/** Handed over at the door. COD is marked collected at this moment. */
export async function markDelivered(orderId) {
  const result = await api.post(`/rider/orders/${orderId}/deliver`);
  return result.data;
}

/**
 * Start pushing this rider's position to the server.
 *
 * Wraps `watchPosition` and throttles the uploads — GPS fires far more often
 * than dispatch needs, and every send is a write.
 *
 * @returns {() => void} call to stop watching
 */
export function startLocationReporting({ intervalMs = 15000, onError } = {}) {
  if (!navigator.geolocation) return () => {};

  let lastSent = 0;
  let latest = null;
  let stopped = false;

  const send = async () => {
    if (stopped || !latest) return;
    const now = Date.now();
    if (now - lastSent < intervalMs) return;
    lastSent = now;
    try {
      await reportLocation(latest);
    } catch (err) {
      // A dropped heartbeat is not worth surfacing: the next one is seconds
      // away, and the rider can do nothing about it.
      if (onError) onError(err);
    }
  };

  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      latest = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      send();
    },
    () => {},
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
