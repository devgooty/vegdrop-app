/**
 * Markets — the vegetable markets a customer picks between.
 *
 * A market's catalog is its OWN price sheet, not the platform catalog. Two
 * markets can list the same tomato at different prices, and the price the
 * customer sees is whichever market they are browsing.
 */

import { api } from './apiClient';

/**
 * Markets that can reach a point, nearest first.
 *
 * @param {{lat: number, lng: number, radius?: number}} where
 * @returns {Promise<Array<{id, name, address, distanceMeters, deliverable, openStalls, isOpen}>>}
 */
export async function fetchNearbyMarkets({ lat, lng, radius }) {
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  if (radius) params.set('radius', String(radius));

  const result = await api.get(`/markets/nearby?${params.toString()}`);
  return result.data.map((market) => ({
    ...market,
    // Handy for the card: "1.2 km away" reads better than 1243 metres.
    distanceKm: Math.round((market.distanceMeters / 1000) * 10) / 10,
  }));
}

/**
 * What a market is selling today.
 *
 * Shaped to match what the existing product cards already render, so the same
 * components work whether the source is the platform catalog or a market.
 */
export async function fetchMarketCatalog(marketId, { categoryId, search } = {}) {
  const params = new URLSearchParams();
  if (categoryId !== undefined) params.set('categoryId', String(categoryId));
  if (search) params.set('search', search);

  const query = params.toString();
  const result = await api.get(`/markets/${marketId}/catalog${query ? `?${query}` : ''}`);

  return result.data.map((item) => ({
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    weight: item.weight,
    image: item.image,
    isOrganic: item.isOrganic,
    rating: item.rating,
    reviews: item.reviews,
    price: item.price,
    // Shown under the product name on the card, as asked.
    marketId: item.marketId,
    marketName: item.marketName,
    // Market listings carry no per-item stock — availability is the market's
    // price sheet plus whichever stall answers. Kept non-zero so the existing
    // "sold out" styling does not fire on every card.
    stock: 99,
  }));
}

export async function fetchMarket(marketId) {
  const result = await api.get(`/markets/${marketId}`);
  return result.data;
}

/** Read the caller's position once, for the nearby query. Resolves to null if refused. */
export function currentPosition({ timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 }
    );
  });
}

/**
 * The coordinates the address picker already saved.
 *
 * `HomeHeroBanner` has been writing these to local storage since the map picker
 * was added; nothing read them back until now.
 */
export function savedCustomerCoords() {
  try {
    const raw = localStorage.getItem('vegdrop_customer_coords');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.lat !== 'number' || typeof parsed?.lng !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

// --- Market owner administration -------------------------------------------

export async function fetchMarketPrices(marketId) {
  const result = await api.get(`/markets/${marketId}/prices`);
  return result.data;
}

/** @param {Array<{productId: string, price: number, isAvailable?: boolean}>} prices rupees */
export async function saveMarketPrices(marketId, prices) {
  const result = await api.put(`/markets/${marketId}/prices`, { prices });
  return result.data;
}

export async function fetchMarketStalls(marketId) {
  const result = await api.get(`/markets/${marketId}/stalls`);
  return result.data;
}

export async function createStall(marketId, stall) {
  const result = await api.post(`/markets/${marketId}/stalls`, stall);
  return result.data;
}
