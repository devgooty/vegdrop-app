/**
 * Catalog suggestions — promote a shopkeeper's custom listing into the shared
 * platform catalog after a market owner or developer accepts it.
 */

import { api } from './apiClient';

/** @param {string} listingId */
export async function createCatalogSuggestion(listingId) {
  const result = await api.post('/catalog-suggestions', { listingId });
  return result.data;
}

/** @param {{ status?: 'pending' | 'accepted' | 'rejected' }} [filters] */
export async function fetchCatalogSuggestions(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  const q = params.toString();
  const result = await api.get(`/catalog-suggestions${q ? `?${q}` : ''}`);
  return result.data;
}

/** @param {string} id @param {{ categoryId: number }} body */
export async function acceptCatalogSuggestion(id, { categoryId }) {
  const result = await api.post(`/catalog-suggestions/${id}/accept`, { categoryId });
  return result.data;
}

/** @param {string} id @param {{ reason?: string }} [body] */
export async function rejectCatalogSuggestion(id, { reason } = {}) {
  const result = await api.post(`/catalog-suggestions/${id}/reject`, {
    ...(reason ? { reason } : {}),
  });
  return result.data;
}
