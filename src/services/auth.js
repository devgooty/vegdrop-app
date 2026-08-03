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
 * Does this mobile number or email already have an account?
 *
 * Used to decide whether to show the sign-in code screen or the registration
 * form. Note what this costs: unlike every other call here, the answer differs
 * for a known and an unknown identifier, so it can be used to test whether
 * someone is a customer. The server prices that with the tightest rate limit in
 * the app — 20 per hour — so treat a `LOOKUP_RATE_LIMITED` error as expected
 * rather than exceptional, and never call this on keystroke.
 *
 * @returns {Promise<{exists: boolean, type: 'phone'|'email'}>}
 */
export async function lookupIdentifier({ identifier }) {
  return api.post('/auth/lookup', { identifier }, { auth: false });
}

/**
 * Step 1 of signing in with either a mobile number or an email address.
 *
 * One code is issued and delivered to every verified contact the account has, so
 * whichever the user typed, the same code arrives on WhatsApp and by email.
 */
export async function startIdentifierAuth({ identifier }) {
  return api.post('/auth/otp/start', { identifier }, { auth: false });
}

/**
 * Step 1 of registration. Both contacts are required, and each receives its OWN
 * code — proving one must not prove the other.
 *
 * `phone.delivered === false` means WhatsApp could not be reached. That is not an
 * error: registration continues on the email code alone, and the number is kept
 * against the account unverified. Hide the WhatsApp code input in that case.
 *
 * @returns {Promise<{email: {challengeId: string, destination: string, delivered: boolean},
 *                    phone: {challengeId: string|null, destination: string, delivered: boolean}}>}
 */
export async function startRegistration({ phone, email, name }) {
  const payload = { phone, email };
  if (name) payload.name = name;
  return api.post('/auth/register/start', payload, { auth: false });
}

/**
 * Step 2 of registration. Omit the phone pair when WhatsApp delivery failed.
 * @returns {Promise<object>} the authenticated user
 */
export async function verifyRegistration({ emailChallengeId, emailCode, phoneChallengeId, phoneCode }) {
  const payload = { emailChallengeId, emailCode };
  if (phoneChallengeId && phoneCode) {
    payload.phoneChallengeId = phoneChallengeId;
    payload.phoneCode = phoneCode;
  }
  const result = await api.post('/auth/register/verify', payload, { auth: false });
  setAccessToken(result.accessToken);
  return result.user;
}

// --- Vendor registration -----------------------------------------------------
//
// Same dual-OTP shape as customer registration above — this app has no
// passwords, so there is no separate "set a password" step. The only
// difference is the endpoint, which is what selects the `shopkeeper` role on
// the server; nothing here or in the request body chooses it.

/**
 * Step 1 of vendor registration. Both contacts are required, each proved with
 * its own code.
 * @returns {Promise<{email: {challengeId: string, destination: string, delivered: boolean},
 *                    phone: {challengeId: string|null, destination: string, delivered: boolean}}>}
 */
export async function startVendorRegistration({ phone, email, name }) {
  const payload = { phone, email };
  if (name) payload.name = name;
  return api.post('/auth/vendor/register/start', payload, { auth: false });
}

/**
 * Step 2 of vendor registration. Creates a `shopkeeper` account and
 * establishes the session — `nextStep: 'kyc'` tells the caller to open the KYC
 * form rather than the (empty) dashboard, since the new account can list
 * nothing until it verifies a settlement account.
 * @returns {Promise<{user: object, nextStep: string}>}
 */
export async function verifyVendorRegistration({ emailChallengeId, emailCode, phoneChallengeId, phoneCode }) {
  const payload = { emailChallengeId, emailCode };
  if (phoneChallengeId && phoneCode) {
    payload.phoneChallengeId = phoneChallengeId;
    payload.phoneCode = phoneCode;
  }
  const result = await api.post('/auth/vendor/register/verify', payload, { auth: false });
  setAccessToken(result.accessToken);
  return { user: result.user, nextStep: result.nextStep };
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
/**
 * Advisory check for the single sign-in box, which accepts either kind of
 * contact. The server's `fields.identifier` is the authoritative rule.
 * @returns {string|null} a problem description, or null when acceptable
 */
export function describeIdentifierProblem(identifier) {
  const raw = String(identifier ?? '').trim();
  if (raw.length === 0) return 'Enter your mobile number or email address.';
  if (raw.includes('@')) return describeEmailProblem(raw);
  return describePhoneProblem(raw);
}

/** @returns {string|null} a problem description, or null when acceptable */
export function describeEmailProblem(email) {
  const raw = String(email ?? '').trim();
  if (raw.length === 0) return 'Enter your email address.';
  // Deliberately loose: the server validates properly, and a strict client-side
  // pattern rejects addresses that are actually valid.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return 'Enter a valid email address.';
  return null;
}

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
