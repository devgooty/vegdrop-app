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
    /**
     * When a stall in this market last photographed the real thing, or null.
     *
     * The photo itself is a separate request — `freshPhotoUrl` below — so the
     * catalog stays a small JSON response instead of carrying a couple of
     * hundred inlined images.
     */
    freshPhotoAt: item.freshPhotoAt || null,
    freshPhotoUrl: item.freshPhotoAt
      ? `/api/markets/${item.marketId}/products/${item.id}/fresh-photo`
      : null,
    // Shown under the product name on the card, as asked.
    marketId: item.marketId,
    marketName: item.marketName,
    // Market listings carry no per-item stock — availability is the market's
    // price sheet plus whichever stall answers. Kept non-zero so the existing
    // "sold out" styling does not fire on every card.
    stock: 99,
  }));
}

/**
 * What this market has charged lately, per product.
 *
 * A series contains a point only where the price actually CHANGED, so a steady
 * line comes back as one point and must be drawn as a step, not interpolated —
 * the price was that number until the next point, it did not drift toward it.
 * A product absent from `series` has never been repriced in the window; that is
 * an empty state to show, not a gap to fill in.
 *
 * @param {string} marketId
 * @param {{days?: number, productIds?: string[]}} [options]
 * @returns {Promise<{windowDays: number, since: string, series: Record<string, Array>}>}
 */
export async function fetchMarketPriceHistory(marketId, { days, productIds } = {}) {
  const params = new URLSearchParams();
  if (days) params.set('days', String(days));
  if (productIds?.length) params.set('productIds', productIds.join(','));

  const query = params.toString();
  const result = await api.get(
    `/markets/${marketId}/price-history${query ? `?${query}` : ''}`,
    { auth: false }
  );
  return result.data;
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

/**
 * Sign off lines whose price has not moved today.
 *
 * The counterpart to saving, not a variant of it. Saving says "this is the new
 * number"; this says "yesterday's number still stands", which is what most of
 * a price sheet does on most days. It writes no history — a price that did not
 * change must not appear on the customer's chart as though it had.
 *
 * Omit `productIds` to confirm the whole sheet.
 */
export async function confirmMarketPrices(marketId, productIds) {
  const result = await api.post(`/markets/${marketId}/prices/confirm`, {
    ...(productIds?.length ? { productIds } : {}),
  });
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

/**
 * Suspend a trader, or move them to a different pitch.
 *
 * Only `isActive` and `stallNumber`. The shutter (`isOpen`) and auto-accept are
 * the shopkeeper's own settings and are not the market owner's to write.
 *
 * @param {{isActive?: boolean, stallNumber?: string}} changes
 */
export async function updateMarketStall(marketId, stallId, changes) {
  const result = await api.patch(`/markets/${marketId}/stalls/${stallId}`, changes);
  return result.data;
}

/**
 * Open a market.
 *
 * Whoever creates it runs it: the server assigns `owner` from the session for a
 * market_owner and ignores any `ownerId` in the body, so this cannot be used to
 * plant a market under someone else's account.
 *
 * `slug` has to be unique across the platform, so a collision comes back as a
 * duplicate-key failure rather than silently attaching to an existing market.
 */
export async function createMarket({
  name,
  slug,
  address,
  lat,
  lng,
  serviceRadiusMeters,
  contactPhone,
  boundary,
}) {
  const result = await api.post('/markets', {
    name,
    slug,
    address,
    lat,
    lng,
    ...(serviceRadiusMeters === undefined ? {} : { serviceRadiusMeters }),
    ...(contactPhone ? { contactPhone } : {}),
    /**
     * The walked perimeter. Each node carries its own accuracy, because the
     * server refuses a sloppy one by index — "point 4 was taken with only 80 m
     * of precision" — and it can only do that if it is told per point.
     */
    ...(boundary?.length ? { boundary } : {}),
  });
  return result.data;
}

/**
 * Redraw a market's boundary.
 *
 * Separate from `updateMarket` for the reason given on the route: this payload
 * is the output of physically walking somewhere, not something typed into a
 * settings form, and folding it in would make an absent boundary ambiguous
 * between "unchanged" and "delete it".
 */
export async function saveMarketBoundary(marketId, nodes) {
  const result = await api.put(`/markets/${marketId}/boundary`, { nodes });
  return result.data;
}

/**
 * Change how the market itself is set up.
 *
 * Send `lat` and `lng` together or not at all — the server refuses one without
 * the other rather than moving a market to a half-specified point.
 */
export async function updateMarket(marketId, changes) {
  const result = await api.patch(`/markets/${marketId}`, changes);
  return result.data;
}

/**
 * The markets this account runs.
 *
 * Each carries `pendingRequests`, so the dashboard can badge the queue without
 * a second request per market.
 */
export async function fetchMyMarkets() {
  const result = await api.get('/markets/mine');
  return result.data;
}

/** Shopkeepers waiting on a decision. Pass a status to see decided ones. */
export async function fetchStallRequests(marketId, { status } = {}) {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const result = await api.get(`/markets/${marketId}/stall-requests${query}`);
  return result.data;
}

/**
 * Let a shopkeeper in.
 *
 * `stallNumber` is required and is the market owner's decision, not the
 * applicant's: the number they proposed is a guess, and only the owner knows
 * which pitches are actually free.
 */
export async function approveStallRequest(marketId, requestId, { stallNumber, autoAccept } = {}) {
  const result = await api.post(`/markets/${marketId}/stall-requests/${requestId}/approve`, {
    stallNumber,
    ...(autoAccept === undefined ? {} : { autoAccept }),
  });
  return result.data;
}

export async function rejectStallRequest(marketId, requestId, { reason } = {}) {
  const result = await api.post(`/markets/${marketId}/stall-requests/${requestId}/reject`, {
    ...(reason ? { reason } : {}),
  });
  return result.data;
}

/**
 * What happened in this market lately.
 *
 * Money is in paise, as everywhere on the server. Divide at the point of
 * display, never before — rounding the per-stall figures early stops them
 * adding up to the total.
 */
export async function fetchMarketAnalytics(marketId, { days } = {}) {
  const query = days ? `?days=${days}` : '';
  const result = await api.get(`/markets/${marketId}/analytics${query}`);
  return result.data;
}

// --- The shopkeeper's side of joining ---------------------------------------

/** Every market a shopkeeper could apply to. */
export async function fetchJoinableMarkets() {
  const result = await api.get('/markets');
  return result.data;
}

export async function requestToJoinMarket(
  marketId,
  { name, stallNumber, contactPhone, presence } = {}
) {
  const result = await api.post(`/markets/${marketId}/join`, {
    ...(name ? { name } : {}),
    ...(stallNumber ? { stallNumber } : {}),
    ...(contactPhone ? { contactPhone } : {}),
    ...(presence ? { presence } : {}),
  });
  return result.data;
}

/**
 * Is this stall number free?
 *
 * `available: false` is information, not a veto — the owner settles the real
 * number at approval and may well place the applicant somewhere else. The
 * screen says so rather than blocking, because an applicant who genuinely
 * trades at a number our records show as let is exactly the case a human needs
 * to look at.
 */
export async function checkStallNumber(marketId, stallNumber) {
  const result = await api.get(
    `/markets/${marketId}/stall-number-check?stallNumber=${encodeURIComponent(stallNumber)}`
  );
  return result.data;
}

/**
 * "Am I standing in this market?", before committing to an application.
 *
 * Resolves for both verdicts — `{ ok: false, message }` is an answer, not a
 * failure, and the route returns 200 for it deliberately. Only a genuine
 * transport or auth problem rejects.
 */
export async function checkPresenceAtMarket(marketId, presence) {
  const result = await api.post(`/markets/${marketId}/presence-check`, { presence });
  return result.data;
}

/** Where the caller's own application stands, or null if they never applied. */
export async function fetchMyJoinRequest() {
  const result = await api.get('/markets/me/join');
  return result.data;
}

export async function withdrawJoinRequest() {
  await api.delete('/markets/me/join');
}
