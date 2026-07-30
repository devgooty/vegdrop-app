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
  const record = await RefreshToken.findOne({ tokenHash });

  if (!record) return { ok: false, reason: 'unknown' };

  if (record.revokedAt) {
    await revokeFamily(record.family, 'reuse_detected');
    return { ok: false, reason: 'reuse_detected' };
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, record };
}

async function markRotated(record, replacementToken) {
  record.revokedAt = new Date();
  record.replacedByHash = sha256(replacementToken);
  await record.save();
}

async function revokeFamily(family, _reason) {
  await RefreshToken.updateMany(
    { family, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

async function revokeAllForUser(userId) {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

async function revokeByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return;
  await RefreshToken.updateOne(
    { tokenHash: sha256(rawToken), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
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
