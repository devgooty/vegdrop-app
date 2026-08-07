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
