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

import { api, adoptSession, clearSession, refreshSession } from './apiClient';

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
 * Does this mobile number already have an account?
 *
 * Used to decide whether to show the sign-in code screen or the registration
 * form. Note what this costs: unlike every other call here, the answer differs
 * for a known and an unknown identifier, so it can be used to test whether
 * someone is a customer. The server prices that with the tightest rate limit in
 * the app — 20 per hour — so treat a `LOOKUP_RATE_LIMITED` error as expected
 * rather than exceptional, and never call this on keystroke.
 *
 * `app` scopes which account "exists" means. One contact can now back a
 * separate customer, shopkeeper and delivery account, so a bare identifier is
 * ambiguous — the shopkeeper app asking must not learn about a customer
 * account on the same number and route into signing in as it. Pass the
 * `appType` this LoginPage was rendered with; the three values match the
 * server's `APP_ROLE_SCOPE` exactly, so nothing here decides anything.
 *
 * @returns {Promise<{exists: boolean, type: 'phone'}>}
 */
export async function lookupIdentifier({ identifier, app }) {
  const appToSend = app === 'developer' ? undefined : app;
  return api.post('/auth/lookup', { identifier, ...(appToSend ? { app: appToSend } : {}) }, { auth: false });
}

/**
 * Step 1 of signing in. A mobile number, and only a mobile number.
 *
 * The code goes to the phone. It used to be copied to a verified email as well,
 * which made account security the weaker of the two channels; if WhatsApp
 * cannot reach the user, reverse OTP is the way through, not a mailbox.
 *
 * `app` scopes the resolved account exactly as it does on `lookupIdentifier` —
 * see there. Always pass the same one used for the lookup that preceded this,
 * or the two can disagree about which account is being signed into.
 */
export async function startIdentifierAuth({ identifier, app }) {
  const appToSend = app === 'developer' ? undefined : app;
  return api.post('/auth/otp/start', { identifier, ...(appToSend ? { app: appToSend } : {}) }, { auth: false });
}

/**
 * Step 1 of registration. The mobile number, and that is all that is asked for.
 *
 * No email address: an account is created without one, and anyone who wants
 * stall notices adds it from their profile afterwards through `updateUser`.
 *
 * `phone.delivered === false` means WhatsApp could not be reached. That is not
 * an error and no longer means the number goes unproved — offer reverse OTP
 * instead, and pass its token to `verifyRegistration` as `phoneToken`.
 *
 * @returns {Promise<{phone: {challengeId: string|null, destination: string, delivered: boolean}}>}
 */
export async function startRegistration({ phone, name }) {
  const payload = { phone };
  if (name) payload.name = name;
  return api.post('/auth/register/start', payload, { auth: false });
}

/**
 * Step 2 of registration. Supply either the outbound pair
 * (`phoneChallengeId` + `phoneCode`) or a reverse-OTP `phoneToken` — exactly
 * one, never both and never neither. The number is the only thing proved here.
 * @returns {Promise<object>} the authenticated user
 */
export async function verifyRegistration({ phoneChallengeId, phoneCode, phoneToken, name }) {
  const payload = {};
  if (phoneToken) {
    payload.phoneToken = phoneToken;
    // Only the reverse path needs this: there is no stored challenge holding
    // what was typed at /start. Cosmetic, and proved by nothing.
    if (name) payload.name = name;
  } else {
    payload.phoneChallengeId = phoneChallengeId;
    payload.phoneCode = phoneCode;
  }
  const result = await api.post('/auth/register/verify', payload, { auth: false });
  adoptSession(result);
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
 * @returns {Promise<{phone: {challengeId: string|null, destination: string, delivered: boolean}}>}
 */
export async function startVendorRegistration({ phone, name }) {
  const payload = { phone };
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
export async function verifyVendorRegistration({ phoneChallengeId, phoneCode, phoneToken, name }) {
  const payload = {};
  if (phoneToken) {
    payload.phoneToken = phoneToken;
    // Only the reverse path needs this: there is no stored challenge holding
    // what was typed at /start. Cosmetic, and proved by nothing.
    if (name) payload.name = name;
  } else {
    payload.phoneChallengeId = phoneChallengeId;
    payload.phoneCode = phoneCode;
  }
  const result = await api.post('/auth/vendor/register/verify', payload, { auth: false });
  adoptSession(result);
  return { user: result.user, nextStep: result.nextStep };
}

// --- Delivery agent registration ---------------------------------------------
//
// Same dual-OTP shape again, and again the endpoint is the only thing that
// selects the role. Unlike a vendor, a rider created here can go on duty right
// away — there is no KYC equivalent standing between the new account and a
// real pickup, so there is no `nextStep` to hand back.

/**
 * Step 1 of delivery agent registration. Both contacts are required, each
 * proved with its own code.
 * @returns {Promise<{phone: {challengeId: string|null, destination: string, delivered: boolean}}>}
 */
export async function startRiderRegistration({ phone, name }) {
  const payload = { phone };
  if (name) payload.name = name;
  return api.post('/auth/delivery/register/start', payload, { auth: false });
}

/**
 * Step 2 of delivery agent registration. Creates a `delivery` account and
 * establishes the session.
 * @returns {Promise<object>} the authenticated user
 */
export async function verifyRiderRegistration({ phoneChallengeId, phoneCode, phoneToken, name }) {
  const payload = {};
  if (phoneToken) {
    payload.phoneToken = phoneToken;
    // Only the reverse path needs this: there is no stored challenge holding
    // what was typed at /start. Cosmetic, and proved by nothing.
    if (name) payload.name = name;
  } else {
    payload.phoneChallengeId = phoneChallengeId;
    payload.phoneCode = phoneCode;
  }
  const result = await api.post('/auth/delivery/register/verify', payload, { auth: false });
  adoptSession(result);
  return result.user;
}

/**
 * Step 2. Exchanges the code for a session, creating the account if the number
 * is new.
 * @returns {Promise<object>} the authenticated user
 */
export async function verifyPhoneAuth({ challengeId, code }) {
  const result = await api.post('/auth/otp/verify', { challengeId, code }, { auth: false });
  adoptSession(result);
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
  adoptSession(result);
  return result.user;
}

// There is no startEmailChange/verifyEmailChange any more.
//
// They existed because an address on the account received copies of every login
// code, which made attaching one a security action needing proof of control.
// Nothing is delivered to an email now, so an address is an ordinary profile
// field again — set it through `updateUser` like a name.

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
 * Advisory check for the single sign-in box.
 *
 * It used to accept an email address as well. It does not any more: a code goes
 * only to a phone, so an address would resolve an account nobody could then
 * prove they own.
 * @returns {string|null} a problem description, or null when acceptable
 */
export function describeIdentifierProblem(identifier) {
  return describePhoneProblem(String(identifier ?? '').trim());
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
