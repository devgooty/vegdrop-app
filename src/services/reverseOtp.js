/**
 * Reverse OTP — proving a number by sending US a message.
 *
 * The ordinary flow (services/auth.js) has the server message the user a code
 * they read back. This shows the user a code and has them message it to our
 * inbox from their own phone. The number is proved by who the message came
 * FROM, which the inbound channel attests.
 *
 * Two consequences worth knowing before changing anything here:
 *
 *   - The code IS returned by `start`, unlike an outbound one. It has to be —
 *     the user reads it off the screen. It is not a secret from them, only from
 *     anyone who cannot also send from their number.
 *   - Nothing in this file decides whether a verification succeeded. `status`
 *     reports what the server observed; `complete` is what mints a session.
 */

import { api, setAccessToken } from './apiClient';

/**
 * Ask for a code and the prefilled links that carry it.
 *
 * `purpose` scopes the challenge to one flow, so a token raised for signing in
 * can never be spent completing a registration. `app` decides which of a
 * contact's per-role accounts is meant, exactly as it does for the outbound
 * flow.
 *
 * @returns {Promise<{token: string, code: string, expiresAt: string, channels: object}>}
 */
export async function startReverseOtp({ phone, purpose = 'login', app, name }) {
  return api.post(
    '/auth/reverse/start',
    { phone, purpose, ...(app ? { app } : {}), ...(name ? { name } : {}) },
    { auth: false }
  );
}

/** Start a reverse verification of a NEW number for the signed-in account. */
export async function startReverseOtpPhoneChange({ phone }) {
  return api.post('/auth/reverse/start/phone', { phone });
}

/**
 * Where the verification has got to.
 *
 * States: `pending`, `verified`, `mismatch` (right code, wrong sender),
 * `bad_code` (a message arrived but carried no code we know), `expired`.
 *
 * A plain read — polling it never signs anyone in.
 */
export async function getReverseOtpStatus(token, { signal } = {}) {
  return api.get(`/auth/reverse/status?token=${encodeURIComponent(token)}`, { auth: false, signal });
}

/**
 * Spend a verified token for a session. Single use.
 *
 * The token is adopted here, exactly as `verifyPhoneAuth` does in
 * services/auth.js. Skipping it does not obviously break anything — the refresh
 * cookie is set too, so the next 401 silently recovers the session — which is
 * precisely why it is easy to miss: sign-in "works", but every request between
 * completing and the first refresh fails first.
 *
 * @returns {Promise<object>} the authenticated user
 */
export async function completeReverseOtp(token) {
  const result = await api.post('/auth/reverse/complete', { token }, { auth: false });
  setAccessToken(result.accessToken);
  return result.user;
}

/**
 * Spend a verified token to move the signed-in account onto its new number.
 *
 * Adopting the new token matters more here than for sign-in: completing a phone
 * change revokes every token issued against the old number, including the one
 * this client is holding. Without this the session is left definitively dead
 * rather than merely stale.
 *
 * @returns {Promise<object>} the updated user
 */
export async function completeReverseOtpPhoneChange(token) {
  const result = await api.post('/auth/reverse/complete/phone', { token });
  setAccessToken(result.accessToken);
  return result.user;
}

/**
 * iOS or not.
 *
 * Used for one thing: choosing between the two `sms:` link forms. RFC 5724
 * specifies `?body=`, which every current build honours, but some older iOS
 * releases only accepted `&body=` — and the two separators cannot both appear
 * in one href. Detection is a last resort here rather than a habit; the
 * copy-the-code fallback is what actually rescues a device neither form opens.
 */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports itself as a Mac, distinguishable only by touch support.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** The `sms:` link this device is most likely to open. */
export function smsLinkFor(channel) {
  if (!channel) return null;
  return isIOS() && channel.linkLegacy ? channel.linkLegacy : channel.link;
}
