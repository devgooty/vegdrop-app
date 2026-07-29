/**
 * Authentication flows.
 *
 * Every function here is a thin wrapper over a server endpoint. There is
 * deliberately no password comparison, no role derivation, and no OTP checking
 * in this file — all three used to happen in the browser, which meant the
 * credentials were readable in the bundle and the checks were trivially
 * bypassable from devtools.
 *
 * Both login and registration are two-step: the first call returns a challenge,
 * the second exchanges a verification code for a session. No token exists until
 * the second step succeeds.
 */

import { api, setAccessToken, clearSession, refreshSession } from './apiClient';

/**
 * Step 1 of sign-in. Verifies the password server-side and dispatches a code.
 * @returns {Promise<{challengeId: string, channel: 'email'|'sms', destination: string, expiresAt: string}>}
 */
export async function startLogin({ identifier, password }) {
  return api.post('/auth/login', { identifier, password }, { auth: false });
}

/**
 * Step 2 of sign-in. Exchanges the code for a session.
 * @returns {Promise<object>} the authenticated user
 */
export async function verifyLogin({ challengeId, code }) {
  const result = await api.post('/auth/login/verify', { challengeId, code }, { auth: false });
  setAccessToken(result.accessToken);
  return result.user;
}

/**
 * Step 1 of registration. The server holds the pending account until the code
 * is verified, so nothing is persisted for an unverified contact detail.
 *
 * Note there is no `role` parameter. Self-registration always produces a
 * customer; the API rejects a request that tries to supply one.
 */
export async function startRegistration({ name, phone, email, password }) {
  const payload = { name, phone, password };
  if (email) payload.email = email;
  return api.post('/auth/register/start', payload, { auth: false });
}

export async function verifyRegistration({ challengeId, code }) {
  const result = await api.post('/auth/register/verify', { challengeId, code }, { auth: false });
  setAccessToken(result.accessToken);
  return result.user;
}

/**
 * Restore a session on app start from the httpOnly refresh cookie.
 * @returns {Promise<object|null>} the user, or null when not signed in
 */
export async function restoreSession() {
  return refreshSession();
}

export async function getCurrentUser() {
  const result = await api.get('/auth/me');
  return result.user;
}

export async function logout() {
  try {
    await api.post('/auth/logout', undefined, { auth: false });
  } finally {
    // Drop local state even if the network call failed — the user asked to
    // leave, and the server-side token expires on its own.
    clearSession();
  }
}

/** Sign out everywhere, invalidating every outstanding token for this account. */
export async function logoutEverywhere() {
  try {
    await api.post('/auth/logout-all');
  } finally {
    clearSession();
  }
}

export async function changePassword({ currentPassword, newPassword }) {
  const result = await api.post('/auth/password', { currentPassword, newPassword });
  setAccessToken(result.accessToken);
  return result.user;
}

/**
 * Client-side password guidance. Advisory only, to give immediate feedback —
 * the server enforces the real policy and its answer is the one that counts.
 * @returns {string|null} a problem description, or null when acceptable
 */
export function describePasswordProblem(password, minLength = 10) {
  if (typeof password !== 'string' || password.length === 0) return 'Enter a password.';
  if (password.length < minLength) return `Use at least ${minLength} characters.`;
  if (/^\s|\s$/.test(password)) return 'Cannot start or end with a space.';
  if (/^(.)\1+$/.test(password)) return 'Cannot be a single repeated character.';
  return null;
}
