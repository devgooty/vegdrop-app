/**
 * User administration.
 *
 * Every function here is authorized server-side. Listing and deleting require
 * an admin role; profile updates are permitted for the account owner or an
 * admin. Note there is no `updateRole` in the general update path — role
 * changes are a separate, deliberately conspicuous endpoint.
 */

import { api } from './apiClient';

/** Admin only (market_owner, developer). */
export async function fetchUsers(filters = {}) {
  const params = new URLSearchParams();
  if (filters.role) params.set('role', filters.role);
  if (filters.status) params.set('status', filters.status);
  if (filters.limit) params.set('limit', String(filters.limit));

  const query = params.toString();
  const result = await api.get(`/users${query ? `?${query}` : ''}`);
  return result.data;
}

export async function fetchUser(userId) {
  const result = await api.get(`/users/${userId}`);
  return result.data;
}

/**
 * Update name, email, or phone. Changing a contact channel clears its verified
 * flag server-side, so it must be re-verified before it can receive codes.
 */
export async function updateUser(userId, fields) {
  const result = await api.patch(`/users/${userId}`, fields);
  return result.data;
}

/** Admin only. Invalidates the target's sessions immediately. */
export async function updateUserRole(userId, role) {
  const result = await api.patch(`/users/${userId}/role`, { role });
  return result.data;
}

export async function updateUserStatus(userId, status) {
  const result = await api.patch(`/users/${userId}/status`, { status });
  return result.data;
}

/** Admin only. Soft delete — order history and ledger entries are preserved. */
export async function deleteUser(userId) {
  await api.delete(`/users/${userId}`);
}

/**
 * The uploaded profile photo's bytes.
 *
 * A separate call because the profile read deliberately carries only a pointer
 * to it — see `toPublicJSON` in server/models/User.js.
 */
export async function fetchUserAvatar(userId) {
  const result = await api.get(`/users/${userId}/avatar`);
  return result.data.image;
}

/**
 * Set the picture. Exactly one of `preset` or `image` — the server refuses
 * both, because they are two ways of answering the same question.
 */
export async function setUserAvatar(userId, choice) {
  const result = await api.put(`/users/${userId}/avatar`, choice);
  return result.data;
}

/** Back to initials. */
export async function clearUserAvatar(userId) {
  const result = await api.delete(`/users/${userId}/avatar`);
  return result.data;
}
