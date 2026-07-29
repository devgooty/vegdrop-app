/**
 * Catalog access.
 *
 * The server is authoritative for price and stock. Prices are persisted as
 * integer paise and exposed as a `price` rupee virtual, so the UI can keep
 * rendering rupees while nothing float-shaped is ever written back.
 */

import { api } from './apiClient';

/**
 * @param {{categoryId?: number, search?: string, limit?: number}} [filters]
 * @returns {Promise<Array>} products, already rupee-denominated for display
 */
export async function fetchProducts(filters = {}) {
  const params = new URLSearchParams();
  if (filters.categoryId !== undefined) params.set('categoryId', String(filters.categoryId));
  if (filters.search) params.set('search', filters.search);
  if (filters.limit) params.set('limit', String(filters.limit));

  const query = params.toString();
  const result = await api.get(`/products${query ? `?${query}` : ''}`, { auth: false });
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
