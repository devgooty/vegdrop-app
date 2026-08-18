/**
 * Independent shops — shopkeepers who sell from their own premises.
 *
 * The other half of `markets.js`. A shopkeeper who has joined a market is
 * reached through that market and never appears here; this covers the ones with
 * nobody's stall and their own address.
 */

import { api } from './apiClient';

/**
 * Shops that can reach a point, nearest first.
 *
 * @param {{lat: number, lng: number, radius?: number}} where
 * @returns {Promise<Array<{id, name, address, distanceMeters, distanceKm, deliverable, isOpen}>>}
 */
export async function fetchNearbyShops({ lat, lng, radius }) {
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  if (radius) params.set('radius', String(radius));

  const result = await api.get(`/shops/nearby?${params.toString()}`);
  return result.data.map((shop) => ({
    ...shop,
    // "1.2 km away" reads better than 1243 metres. Same shape markets use, so
    // the two cards can be styled alike.
    distanceKm: Math.round((shop.distanceMeters / 1000) * 10) / 10,
  }));
}

/**
 * Which nearby shops can fill this basket, best first.
 *
 * `fetchNearbyShops` answers "who is close"; this answers "who can actually
 * serve me", which is the question that matters once there is a basket. Checkout
 * requires every line to belong to the one shop being ordered from, so a shop
 * missing a single item cannot take the order at all — which is why coverage
 * outranks distance in the server's ordering.
 *
 * `items` are SHARED-CATALOG ids. Each shop keeps its own product rows, so the
 * same tomato is a different document at every shop; `shop.lines` maps each
 * catalog item to that shop's own product id, and that is what checkout must be
 * given. Use `linesForShop` below rather than sending the catalog ids.
 *
 * @param {{lat, lng, radius?, items: Array<{productId, quantity}>}} query
 * @returns {Promise<Array<{id, name, address, distanceMeters, distanceKm,
 *   deliverable, isOpen, covered, total, canFillBasket, lines}>>}
 */
export async function fetchShopsForBasket({ lat, lng, radius, items }) {
  const result = await api.post('/shops/nearby/coverage', {
    lat,
    lng,
    ...(radius ? { radius } : {}),
    items,
  });
  return result.data.map((shop) => ({
    ...shop,
    distanceKm: Math.round((shop.distanceMeters / 1000) * 10) / 10,
  }));
}

/**
 * Translate a basket of catalog items into one shop's own product ids.
 *
 * Returns null when the shop cannot supply every line. That is deliberately not
 * a partial list: an order placed with missing lines is refused by checkout as a
 * whole, so handing back "most of it" would only move the failure later.
 *
 * @returns {Array<{productId: string, quantity: number}> | null}
 */
export function linesForShop(shop) {
  if (!shop?.canFillBasket) return null;
  return shop.lines.map(({ productId, quantity }) => ({ productId, quantity }));
}

/**
 * The caller's own shop.
 *
 * Carries `hasStall` and `kycVerified` as well as the pin, so the dashboard can
 * say WHY a shop is not listed rather than leaving the shopkeeper guessing.
 */
export async function fetchMyShop() {
  const result = await api.get('/shops/me');
  return result.data;
}

/** Set or move the pin. Idempotent — the shop is where it is. */
export async function saveShopLocation({ lat, lng, name, address }) {
  const result = await api.put('/shops/me/location', {
    lat,
    lng,
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
  });
  return result.data;
}

/** Shutter switch, display details, delivery range. */
export async function updateMyShop(fields) {
  const result = await api.patch('/shops/me', fields);
  return result.data;
}

/**
 * What this shop is owed, what has been paid, and when the rest lands.
 *
 * The stall equivalent lives in services/stalls.js and hits /stalls/me/earnings,
 * which is gated on having a stall — an independent shopkeeper gets 404 there,
 * which is why this exists separately rather than being shared.
 */
export async function fetchShopEarnings() {
  const result = await api.get('/shops/me/earnings');
  return result.data;
}

/**
 * Take the held money now instead of waiting out the hold.
 *
 * Releases everything pending, not just the minimum — a partial payout would
 * leave dust that could never be withdrawn again.
 *
 * @throws {ApiRequestError} 409 BELOW_MINIMUM when there is not enough yet
 */
export async function withdrawShopEarnings() {
  const result = await api.post('/shops/me/earnings/withdraw');
  return result.data;
}

/**
 * The nearest online delivery partner right now, answered from wherever this
 * shopkeeper actually trades (their own pin, or their stall's market).
 *
 * Ambient, not tied to any order — `null` just means nobody is within the
 * 5 km courtesy radius at the moment, not that anything is wrong.
 */
export async function fetchNearbyRider() {
  const result = await api.get('/shops/me/nearby-rider');
  return result.data;
}
