/**
 * Catalog access.
 *
 * The server is authoritative for price and stock. Prices are persisted as
 * integer paise and exposed as a `price` rupee virtual, so the UI can keep
 * rendering rupees while nothing float-shaped is ever written back.
 */

import { api } from './apiClient';

/**
 * @param {{categoryId?: number, search?: string, limit?: number, shopId?: string,
 *   mine?: boolean, catalogOnly?: boolean}} [filters]
 *   `shopId` narrows to one independent shop's own listings; `catalogOnly` to
 *   the shared `owner: null` rows a shop's listing can be linked to; omit both
 *   for the whole catalog, which is what the market and legacy paths read.
 * @returns {Promise<Array>} products, already rupee-denominated for display
 */
export async function fetchProducts(filters = {}) {
  const params = new URLSearchParams();
  if (filters.categoryId !== undefined) params.set('categoryId', String(filters.categoryId));
  if (filters.search) params.set('search', filters.search);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.shopId) params.set('shopId', String(filters.shopId));
  if (filters.mine) params.set('mine', 'true');
  if (filters.catalogOnly) params.set('catalogOnly', 'true');

  const query = params.toString();
  // `mine` is identity-scoped, so it has to carry the session; everything else
  // is the public catalog and deliberately does not.
  const result = await api.get(`/products${query ? `?${query}` : ''}`, { auth: !!filters.mine });
  return result.data;
}

/**
 * Collapses per-stall duplicates of the same produce to one card.
 *
 * A market's shared catalog row (`owner: null`) and every stall's own linked
 * listing (`owner: <stall>`, `catalogItem` pointing back to that shared row —
 * see CLAUDE.md, Sourcing) are separate Product documents for the same
 * produce. Any screen that lists "everything in this category" or "everything
 * matching this search" therefore shows the same vegetable three or four
 * times over — once per stall that carries it, each its own, mostly
 * unreviewed row. That reads as a broken feed, not as "three stalls sell
 * this."
 *
 * Keyed on `catalogItem`, falling back to the row's own id when it is null —
 * a shop-owned listing that was never linked (see `migrateProductCatalogItem`
 * in the sourcing docs) has no proven relationship to any other row, so it
 * has to stay its own card rather than being guessed into a merge.
 *
 * The highest-rated row per key wins, as a proxy for the listing a shopper
 * would actually pick — unreviewed stall duplicates default to 0 and lose to
 * the platform catalog row wherever one with real reviews exists. Order is
 * preserved from the input rather than grouped, so a caller's own sort
 * (price, discount, rating) survives unchanged among the surviving rows.
 */
export function dedupeByCatalogItem(products) {
  const keyOf = (item) => item.catalogItem || item.id;
  const bestByKey = new Map();
  for (const item of products) {
    const key = keyOf(item);
    const existing = bestByKey.get(key);
    if (!existing || (item.rating ?? 0) > (existing.rating ?? 0)) {
      bestByKey.set(key, item);
    }
  }
  const emitted = new Set();
  const ordered = [];
  for (const item of products) {
    const key = keyOf(item);
    if (bestByKey.get(key) === item && !emitted.has(key)) {
      emitted.add(key);
      ordered.push(item);
    }
  }
  return ordered;
}

/** Requires shopkeeper, market_owner, or developer. */
export async function updateStock(productId, stock) {
  const result = await api.patch(`/products/${productId}/stock`, { stock });
  return result.data;
}

export async function updateProduct(productId, fields) {
  const result = await api.patch(`/products/${productId}`, fields);
  return result.data;
}

export async function createProduct(product) {
  const result = await api.post('/products', product);
  return result.data;
}
