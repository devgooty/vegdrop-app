/**
 * Authentication flows — passwordless.
 *
 * Every function here is a thin wrapper over a server endpoint. There is
 * deliberately no role derivation and no OTP checking in this file — both used
 * to happen in the browser, which meant the checks were trivially bypassable
 * from devtools.
 *
 * Sign-in and sign-up are the same two calls: request a code, then exchange it
 * for a session. The server decides whether that means signing an existing
 * account in or creating a new one, and the responses are identical either way
 * so the client cannot be used to test which phone numbers are registered.
 * No token exists until the second step succeeds.
 */

import { api, setAccessToken, clearSession, refreshSession } from './apiClient';

/**
 * Step 1. Sends a verification code over WhatsApp to the number given.
 *
 * `name` is used only if this number has no account yet; it is ignored for an
 * existing one. There is no `role` parameter — a self-created account is always
 * a customer, and the API rejects a request that tries to supply one.
 *
 * @returns {Promise<{challengeId: string, channel: string, destination: string, expiresAt: string}>}
 */
export async function startPhoneAuth({ phone, name }) {
  const payload = { phone };
  if (name) payload.name = name;
  return api.post('/auth/otp/start', payload, { auth: false });
}

/**
 * Step 2. Exchanges the code for a session, creating the account if the number
 * is new.
 * @returns {Promise<object>} the authenticated user
 */
export async function verifyPhoneAuth({ challengeId, code }) {
  const result = await api.post('/auth/otp/verify', { challengeId, code }, { auth: false });
  setAccessToken(result.accessToken);
  return result.user;
}

/**
 * Step 1 of moving the account to a new number. Sends a code to the NEW number,
 * because the point is to prove the holder can receive codes there — that is
 * what sign-in will depend on afterwards.
 */
export async function startPhoneChange({ phone }) {
  return api.post('/auth/phone/start', { phone });
}

/**
 * Step 2 of moving the account. Signs every other device out, since they
 * authenticated against the old number, and returns a fresh session for this one.
 * @returns {Promise<object>} the updated user
 */
export async function verifyPhoneChange({ challengeId, code }) {
  const result = await api.post('/auth/phone/verify', { challengeId, code });
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

/**
 * Advisory 10-digit check so the user gets feedback before a round trip. The
 * server's `fields.phone` is the authoritative rule.
 * @returns {string|null} a problem description, or null when acceptable
 */
export function describePhoneProblem(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  // Strip a country/trunk prefix by length, never by pattern: 9111111111 is a
  // real 10-digit mobile, not "91" plus eight digits. Mirrors `fields.phone`.
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === 0) return 'Enter your mobile number.';
  if (!/^[6-9]\d{9}$/.test(digits)) return 'Enter a valid 10-digit mobile number.';
  return null;
}
