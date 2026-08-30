/**
 * Where the customer wants their order left.
 *
 * ONE RULE: "not set" must read as not set.
 *
 * Four call sites used to spell this as
 * `localStorage.getItem(...) || 'Koramangala, Bengaluru, Karnataka - 560034'`,
 * which meant a customer who had never entered an address saw a real-looking
 * Bengaluru address in the header and on the basket, and an order placed from
 * Hyderabad was addressed to a street its rider would never visit. The fallback
 * was not a default — it was a fabrication presented as the customer's own.
 *
 * `savedCustomerAddress()` returns null when nothing has been entered, and the
 * screens prompt for one instead of inventing it. The coordinate half lives in
 * services/markets.js (`savedCustomerCoords`), written by the same picker.
 */

const ADDRESS_KEY = 'vegdrop_customer_location';
const COORDS_KEY = 'vegdrop_customer_coords';

/** The address the customer entered, or null if they never did. */
export function savedCustomerAddress() {
  try {
    const raw = localStorage.getItem(ADDRESS_KEY);
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed || null;
  } catch {
    // Private-mode Safari throws on localStorage rather than returning null.
    return null;
  }
}

/**
 * Record an address, and the point it resolved to when one is known.
 *
 * Coordinates are what `MarketPicker` reads to find markets that can reach the
 * customer, so an address saved without them still leaves the shop unable to
 * work out who can deliver — that is why the picker sends both together.
 */
export function saveCustomerAddress(address, coords = null) {
  const trimmed = typeof address === 'string' ? address.trim() : '';
  if (!trimmed) return;

  try {
    localStorage.setItem(ADDRESS_KEY, trimmed);
    if (typeof coords?.lat === 'number' && typeof coords?.lng === 'number') {
      localStorage.setItem(COORDS_KEY, JSON.stringify({ lat: coords.lat, lng: coords.lng }));
    }
  } catch {
    // Nothing to do: the address stays in component state for this session.
  }
}

/** Forget the saved address and its coordinates, returning to "not set". */
export function clearCustomerAddress() {
  try {
    localStorage.removeItem(ADDRESS_KEY);
    localStorage.removeItem(COORDS_KEY);
  } catch {
    // Private-mode Safari throws on localStorage; nothing to clean up then.
  }
}
