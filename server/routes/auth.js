'use strict';

const express = require('express');
const config = require('../config/env');
const User = require('../models/User');
const { SELF_SERVICE_ROLES } = require('../models/User');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const {
  authLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  registrationLimiter,
} = require('../middleware/rateLimit');
const passwords = require('../services/password');
const otp = require('../services/otp');
const tokens = require('../services/tokens');

const router = express.Router();

/**
 * Authentication.
 *
 * Invariants enforced here:
 *  1. A role is NEVER read from a request body. Self-registration always
 *     produces a `customer`; privileged roles are provisioned out of band.
 *  2. Password verification happens only on the server. There is no client-side
 *     comparison path and no offline bypass.
 *  3. The OTP second factor is server-generated and server-verified.
 *  4. Unknown-account and wrong-password failures are indistinguishable in both
 *     response shape and timing.
 */

// A structurally valid hash used to burn equivalent CPU when the account does
// not exist, so response time does not reveal whether an identifier is
// registered. Computed once, lazily.
let decoyHashPromise = null;
function decoyHash() {
  if (!decoyHashPromise) {
    decoyHashPromise = passwords.hash(`decoy-${Date.now()}-${Math.random()}`);
  }
  return decoyHashPromise;
}

/**
 * Choose where a verification code is addressed.
 *
 * `auto` prefers email when the account has one. That is wrong whenever the only
 * configured transport is a phone one (WhatsApp), because the code would be
 * addressed to an email nothing can deliver — so OTP_CHANNEL=phone forces the
 * phone number. Phone is always present; email is optional.
 */
function otpDestinationFor({ email, phone }) {
  if (config.otp.channel === 'phone') return phone;
  if (config.otp.channel === 'email') return email || phone;
  return email || phone;
}

/** Split a login identifier into the field it should be matched against. */
function normalizeIdentifier(raw) {
  const clean = String(raw).trim().toLowerCase();
  if (clean.includes('@')) return { field: 'email', value: clean };

  const digits = clean.replace(/[\s()+-]/g, '').replace(/^(?:91|0)/, '');
  // Exact match only. The previous implementation used .includes() with a
  // 4-character floor, so "9876" could authenticate against another account.
  if (/^[6-9]\d{9}$/.test(digits)) return { field: 'phone', value: digits };

  return { field: null, value: clean };
}

async function findUserByIdentifier(raw) {
  const { field, value } = normalizeIdentifier(raw);
  if (!field) return null;
  // An exact equality query on a single field: no $or over attacker-shaped input.
  return User.findOne({ [field]: value }).select('+passwordHash +failedLoginAttempts +lockedUntil');
}

function sessionPayload(user, accessToken) {
  return {
    accessToken,
    expiresIn: config.jwt.accessTtlSeconds,
    user: user.toPublicJSON(),
  };
}

async function establishSession(user, req, res) {
  const accessToken = tokens.signAccessToken(user);
  const refresh = await tokens.issueRefreshToken(user, req);
  tokens.setRefreshCookie(res, refresh.token, refresh.expiresAt);
  return sessionPayload(user, accessToken);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

router.post(
  '/register/start',
  registrationLimiter,
  validate({
    body: z
      .object({
        name: fields.nonEmptyString(120),
        phone: fields.phone,
        email: fields.email.optional(),
        password: fields.password,
        // `role` is intentionally absent. .strict() rejects it if supplied,
        // which turns a privilege-escalation attempt into a 400.
      })
      .strict(),
  }),
  async (req, res) => {
    const { name, phone, email, password } = req.valid.body;

    // Throws a 400 with specifics when the password is too weak.
    passwords.assertPasswordShape(password);

    const existing = await User.findOne(email ? { $or: [{ phone }, { email }] } : { phone })
      .select('_id')
      .lean();

    // Do not confirm that an account exists. Issue a challenge either way and
    // let the verify step fail silently for duplicates.
    if (existing) {
      const challenge = await otp.issueChallenge({
        purpose: 'register',
        destination: otpDestinationFor({ email, phone }),
        payload: { duplicate: true },
      });
      return res.status(202).json({ ...challenge, next: 'verify' });
    }

    const passwordHash = await passwords.hash(password);

    const challenge = await otp.issueChallenge({
      purpose: 'register',
      destination: otpDestinationFor({ email, phone }),
      // Held server-side for the duration of the challenge; never returned.
      payload: { name, phone, email: email || null, passwordHash },
    });

    return res.status(202).json({ ...challenge, next: 'verify' });
  }
);

router.post(
  '/register/verify',
  otpVerifyLimiter,
  validate({
    body: z.object({ challengeId: fields.nonEmptyString(80), code: fields.otpCode }).strict(),
  }),
  async (req, res) => {
    const { challengeId, code } = req.valid.body;
    const challenge = await otp.verifyChallenge({ challengeId, code, purpose: 'register' });

    const data = challenge.payload || {};
    if (data.duplicate) {
      throw new ApiError(409, 'An account already exists for those details. Try signing in instead.', 'ACCOUNT_EXISTS');
    }

    const user = await User.create({
      name: data.name,
      phone: data.phone,
      email: data.email || undefined,
      passwordHash: data.passwordHash,
      // Hardcoded, not derived from input. Self-registration cannot yield a
      // privileged account under any request shape.
      role: SELF_SERVICE_ROLES[0],
      emailVerifiedAt: challenge.channel === 'email' ? new Date() : null,
      phoneVerifiedAt: challenge.channel === 'sms' ? new Date() : null,
      lastLoginAt: new Date(),
    });

    return res.status(201).json(await establishSession(user, req, res));
  }
);

// ---------------------------------------------------------------------------
// Login: password, then a server-issued second factor
// ---------------------------------------------------------------------------

router.post(
  '/login',
  authLimiter,
  otpRequestLimiter,
  validate({
    body: z.object({ identifier: fields.identifier, password: fields.password }).strict(),
  }),
  async (req, res) => {
    const { identifier, password } = req.valid.body;
    const user = await findUserByIdentifier(identifier);

    // Identical work and identical response whether or not the account exists.
    const stored = user ? user.passwordHash : await decoyHash();
    const { valid, needsRehash } = await passwords.verify(password, stored);

    const genericFailure = new ApiError(401, 'Incorrect credentials.', 'INVALID_CREDENTIALS');

    if (!user) throw genericFailure;

    if (user.isLocked) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new ApiError(
        423,
        `Account temporarily locked after repeated failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
        'ACCOUNT_LOCKED'
      );
    }

    if (user.status !== 'active') {
      throw new ApiError(403, 'This account is not active. Contact support.', 'ACCOUNT_INACTIVE');
    }

    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const update = { failedLoginAttempts: attempts };
      if (attempts >= config.auth.maxFailedLogins) {
        update.lockedUntil = new Date(Date.now() + config.auth.lockoutSeconds * 1000);
        update.failedLoginAttempts = 0;
      }
      await User.updateOne({ _id: user._id }, { $set: update });
      throw genericFailure;
    }

    // Transparently upgrade legacy bcrypt hashes to scrypt on successful login.
    if (needsRehash) {
      await User.updateOne({ _id: user._id }, { $set: { passwordHash: await passwords.hash(password) } });
    }

    await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, lockedUntil: null } });

    const challenge = await otp.issueChallenge({
      purpose: 'login',
      destination: otpDestinationFor({ email: user.email, phone: user.phone }),
      user,
    });

    // 202: authentication is not complete. No token is issued at this stage.
    return res.status(202).json({ ...challenge, next: 'verify' });
  }
);

router.post(
  '/login/verify',
  otpVerifyLimiter,
  validate({
    body: z.object({ challengeId: fields.nonEmptyString(80), code: fields.otpCode }).strict(),
  }),
  async (req, res) => {
    const { challengeId, code } = req.valid.body;
    const challenge = await otp.verifyChallenge({ challengeId, code, purpose: 'login' });

    const user = await User.findById(challenge.user);
    if (!user || user.status !== 'active') {
      throw new ApiError(401, 'Unable to complete sign-in.', 'INVALID_CREDENTIALS');
    }

    user.lastLoginAt = new Date();
    if (challenge.channel === 'email' && !user.emailVerifiedAt) user.emailVerifiedAt = new Date();
    if (challenge.channel === 'sms' && !user.phoneVerifiedAt) user.phoneVerifiedAt = new Date();
    await user.save();

    return res.json(await establishSession(user, req, res));
  }
);

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

router.post('/refresh', async (req, res) => {
  const presented = req.cookies?.[config.cookies.refreshName];
  const result = await tokens.consumeRefreshToken(presented);

  if (!result.ok) {
    tokens.clearRefreshCookie(res);
    const message =
      result.reason === 'reuse_detected'
        ? 'Session security check failed. Please sign in again.'
        : 'Session expired. Please sign in again.';
    throw new ApiError(401, message, 'REFRESH_INVALID');
  }

  const user = await User.findById(result.record.user);
  if (!user || user.status !== 'active') {
    await tokens.revokeFamily(result.record.family, 'inactive_user');
    tokens.clearRefreshCookie(res);
    throw new ApiError(401, 'Account is not active.', 'ACCOUNT_INACTIVE');
  }

  // Rotate: the presented token is retired and replaced within the same family.
  const next = await tokens.issueRefreshToken(user, req, result.record.family);
  await tokens.markRotated(result.record, next.token);
  tokens.setRefreshCookie(res, next.token, next.expiresAt);

  return res.json(sessionPayload(user, tokens.signAccessToken(user)));
});

router.post('/logout', async (req, res) => {
  await tokens.revokeByToken(req.cookies?.[config.cookies.refreshName]);
  tokens.clearRefreshCookie(res);
  return res.status(204).end();
});

router.post('/logout-all', requireAuth, async (req, res) => {
  await tokens.revokeAllForUser(req.user._id);
  // Invalidates every outstanding access token immediately.
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  tokens.clearRefreshCookie(res);
  return res.status(204).end();
});

router.get('/me', requireAuth, async (req, res) => {
  return res.json({ user: req.user.toPublicJSON() });
});

router.post(
  '/password',
  requireAuth,
  authLimiter,
  validate({
    body: z
      .object({ currentPassword: fields.password, newPassword: fields.password })
      .strict(),
  }),
  async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;

    const user = await User.findById(req.user._id).select('+passwordHash');
    const { valid } = await passwords.verify(currentPassword, user.passwordHash);
    if (!valid) throw new ApiError(401, 'Current password is incorrect.', 'INVALID_CREDENTIALS');

    passwords.assertPasswordShape(newPassword);
    if (currentPassword === newPassword) {
      throw new ApiError(400, 'New password must be different from the current one.', 'WEAK_PASSWORD');
    }

    user.passwordHash = await passwords.hash(newPassword);
    user.passwordChangedAt = new Date();
    // Force every other device to re-authenticate.
    user.tokenVersion += 1;
    await user.save();

    await tokens.revokeAllForUser(user._id);

    // Keep the current device signed in with a fresh session.
    return res.json(await establishSession(user, req, res));
  }
);

module.exports = router;
