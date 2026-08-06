/**
 * Catalog access.
 *
 * The server is authoritative for price and stock. Prices are persisted as
 * integer paise and exposed as a `price` rupee virtual, so the UI can keep
 * rendering rupees while nothing float-shaped is ever written back.
 */

import { api } from './apiClient';

/**
 * @param {{categoryId?: number, search?: string, limit?: number, shopId?: string}} [filters]
 *   `shopId` narrows to one independent shop's own listings; omit it for the
 *   whole catalog, which is what the market and legacy paths read.
 * @returns {Promise<Array>} products, already rupee-denominated for display
 */
export async function fetchProducts(filters = {}) {
  const params = new URLSearchParams();
  if (filters.categoryId !== undefined) params.set('categoryId', String(filters.categoryId));
  if (filters.search) params.set('search', filters.search);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.shopId) params.set('shopId', String(filters.shopId));
  if (filters.mine) params.set('mine', 'true');

  const query = params.toString();
  // `mine` is identity-scoped, so it has to carry the session; everything else
  // is the public catalog and deliberately does not.
  const result = await api.get(`/products${query ? `?${query}` : ''}`, { auth: !!filters.mine });
  return result.data;
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
