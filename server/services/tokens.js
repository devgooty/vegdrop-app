'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const RefreshToken = require('../models/RefreshToken');

/**
 * Two-token session model.
 *
 * Access token: short-lived signed JWT, returned in the response body and held
 * in memory by the client. Stateless, so it is never revocable on its own — the
 * `tv` (token version) claim is checked against the user record on every request
 * so role changes, suspension and forced logout take effect immediately.
 *
 * Refresh token: long-lived opaque random string delivered in an httpOnly,
 * SameSite=Strict cookie. Opaque rather than a JWT because it must be revocable;
 * only its SHA-256 hash is persisted.
 */

const REFRESH_BYTES = 48;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toHexString(),
      role: user.role,
      tv: user.tokenVersion,
    },
    config.jwt.accessSecret,
    {
      algorithm: 'HS256',
      expiresIn: config.jwt.accessTtlSeconds,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      jwtid: crypto.randomUUID(),
    }
  );
}

/**
 * @returns {object|null} decoded claims, or null if the token is invalid,
 *   expired, or signed with the wrong algorithm/issuer/audience.
 */
function verifyAccessToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    return jwt.verify(token, config.jwt.accessSecret, {
      // Pinning the algorithm blocks the `alg: none` and HS/RS confusion classes.
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  } catch {
    return null;
  }
}

function requestFingerprint(req) {
  return {
    userAgent: typeof req?.headers?.['user-agent'] === 'string'
      ? req.headers['user-agent'].slice(0, 400)
      : null,
    ip: typeof req?.ip === 'string' ? req.ip.slice(0, 64) : null,
  };
}

/**
 * Mint a refresh token. Omit `family` to start a new one (i.e. a fresh login).
 * @returns {Promise<{ token: string, family: string, expiresAt: Date }>}
 */
async function issueRefreshToken(user, req, family = null) {
  const token = crypto.randomBytes(REFRESH_BYTES).toString('base64url');
  const resolvedFamily = family || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlSeconds * 1000);
  const { userAgent, ip } = requestFingerprint(req);

  await RefreshToken.create({
    tokenHash: sha256(token),
    user: user._id,
    family: resolvedFamily,
    expiresAt,
    userAgent,
    ip,
  });

  return { token, family: resolvedFamily, expiresAt };
}

/**
 * Exchange a refresh token for a new pair, rotating the old one out.
 *
 * If the presented token was already rotated away, it is assumed stolen: the
 * entire family is revoked, forcing re-authentication on every device that
 * descended from that login.
 *
 * @returns {Promise<{ ok: true, record } | { ok: false, reason: string }>}
 */
async function consumeRefreshToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    return { ok: false, reason: 'missing' };
  }

  const tokenHash = sha256(rawToken);
  const now = new Date();

  /**
   * Retire the token in the same operation that checks it is live.
   *
   * This was findOne → check → (later) save. Two refreshes presenting one
   * cookie — two tabs, or the customer and shopkeeper apps side by side, which
   * the client cannot dedupe across — both passed the check and both minted a
   * successor, forking the session. Now exactly one request retires it.
   */
  const record = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, rotatedAt: now } },
    { returnDocument: 'after' }
  );
  if (record) return { ok: true, record, graceReplay: false };

  const existing = await RefreshToken.findOne({ tokenHash });
  if (!existing) return { ok: false, reason: 'unknown' };

  if (!existing.revokedAt && existing.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  /**
   * Presented again moments after it was rotated: the loser of the race above,
   * or — the case the mobile app hits — a refresh whose response was lost on a
   * flaky network, so the client never received the successor and retried with
   * what it had. Treating either as theft revoked the whole family and signed a
   * legitimate user out. Within the grace window it is answered with a sibling
   * token in the same family instead.
   *
   * The window is the cost: a thief replaying a stolen token within it is not
   * caught by reuse detection. It is short for that reason, it never applies to
   * a family that has been revoked (logout, reuse, suspension), and it only
   * applies to a token retired by rotation — never one revoked outright.
   */
  if (
    existing.rotatedAt &&
    !existing.familyRevokedAt &&
    existing.expiresAt.getTime() > now.getTime() &&
    now.getTime() - existing.rotatedAt.getTime() <= REUSE_GRACE_MS
  ) {
    return { ok: true, record: existing, graceReplay: true };
  }

  if (existing.revokedAt) {
    await revokeFamily(existing.family, 'reuse_detected');
    return { ok: false, reason: 'reuse_detected' };
  }

  return { ok: false, reason: 'expired' };
}

/** How long a just-rotated token is still accepted. See consumeRefreshToken. */
const REUSE_GRACE_MS = 30 * 1000;

async function markRotated(record, replacementToken) {
  await RefreshToken.updateOne({ _id: record._id }, { $set: { replacedByHash: sha256(replacementToken) } });
}

/**
 * Revoking marks EVERY token in the scope, already-rotated ones included, with
 * `familyRevokedAt` — that is what stops the rotation grace window from reviving
 * a family that was deliberately ended. A pipeline update, so a token already
 * revoked keeps its original `revokedAt`.
 */
function revokeWhere(filter) {
  const now = new Date();
  return RefreshToken.updateMany(
    { ...filter, familyRevokedAt: null },
    [{ $set: { familyRevokedAt: now, revokedAt: { $ifNull: ['$revokedAt', now] } } }],
    { updatePipeline: true }
  );
}

async function revokeFamily(family, _reason) {
  await revokeWhere({ family });
}

async function revokeAllForUser(userId) {
  await revokeWhere({ user: userId });
}

/**
 * Logout ends the whole family, not only the presented token: a family is one
 * sign-in on one device, and the grace window can have given it siblings.
 */
async function revokeByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return;
  const record = await RefreshToken.findOne({ tokenHash: sha256(rawToken) }).select('family').lean();
  if (record) await revokeFamily(record.family, 'logout');
}

function setRefreshCookie(res, token, expiresAt) {
  res.cookie(config.cookies.refreshName, token, {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
    path: config.cookies.path,
    expires: expiresAt,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(config.cookies.refreshName, {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
    path: config.cookies.path,
  });
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  markRotated,
  revokeFamily,
  revokeAllForUser,
  revokeByToken,
  setRefreshCookie,
  clearRefreshCookie,
  sha256,
};
