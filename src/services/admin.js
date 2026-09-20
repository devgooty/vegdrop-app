/**
 * Admin Console API helpers.
 *
 * These endpoints are role-gated server-side for `admin` and `developer`.
 */

import { api } from './apiClient';

export async function fetchSharePolicy() {
  const result = await api.get('/admin/share-policy');
  return result.policy;
}

export async function saveSharePolicy(body) {
  const result = await api.put('/admin/share-policy', body);
  return result.policy;
}

export async function fetchAdminMarkets() {
  const result = await api.get('/admin/markets');
  return result.data;
}

export async function fetchMarketSharePolicy(id) {
  return api.get(`/admin/markets/${id}/share-policy`);
}

export async function saveMarketSharePolicy(id, body) {
  return api.put(`/admin/markets/${id}/share-policy`, body);
}

export async function clearMarketSharePolicy(id) {
  return api.delete(`/admin/markets/${id}/share-policy`);
}
