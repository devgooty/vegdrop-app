'use strict';

const express = require('express');
const config = require('../config/env');
const User = require('../models/User');
const { SELF_SERVICE_ROLES } = require('../models/User');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const {
  otpRequestLimiter,
  otpVerifyLimiter,
  otpStartIpLimiter,
} = require('../middleware/rateLimit');
const otp = require('../services/otp');
const tokens = require('../services/tokens');

const router = express.Router();

/**
 * Authentication — passwordless, one factor: a code sent over WhatsApp.
 *
 * There is no password anywhere in this system. Possession of the phone number
 * IS the credential, which is why the code is addressed to the phone and never
 * to an email address (an email transport would be a second, weaker way in).
 *
 * Sign-in and sign-up are deliberately the SAME two calls:
 *
 *   POST /auth/otp/start   { phone, name? }        -> 202 + challengeId
 *   POST /auth/otp/verify  { challengeId, code }   -> 200 + session
 *
 * Merging them is what keeps the flow from becoming an account-enumeration
 * oracle. If sign-in and sign-up were separate, "no account for this number"
 * would be an observable difference; here `start` answers identically either
 * way, and `verify` signs in an existing account or creates a new one without
 * the response revealing which happened.
 *
 * Invariants enforced here:
 *  1. A role is NEVER read from a request body. A self-created account is always
 *     a `customer`; privileged roles are provisioned out of band via
 *     PATCH /api/users/:id/role.
 *  2. Codes are server-generated and server-verified. The client never decides
 *     anything about identity.
 *  3. The phone a session is issued for comes from the stored challenge, never
 *     from the verify request body — otherwise anyone holding a challenge id
 *     could redirect it at another number.
 */

/** Fallback display name when someone signs up without supplying one. */
function placeholderName(phone) {
  return `Customer ${String(phone).slice(-4)}`;
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
// Sign in / sign up: one flow, one factor
// ---------------------------------------------------------------------------

router.post(
  '/otp/start',
  // Keyed on the target number: bounds how often any one phone can be messaged.
  otpRequestLimiter,
  // Keyed on the caller: bounds how many *different* strangers one source can
  // make the bot message. Without this, the per-phone limit above is no
  // constraint at all on someone walking a list of numbers, and unsolicited
  // messages are exactly what gets a WhatsApp number banned.
  otpStartIpLimiter,
  validate({
    body: z
      .object({
        phone: fields.phone,
        // Used only when this number has no account yet. Supplying it for an
        // existing account is ignored, so it cannot be used to overwrite the
        // name on someone else's account.
        name: fields.nonEmptyString(120).optional(),
        // `role` is intentionally absent. .strict() rejects it if supplied,
        // which turns a privilege-escalation attempt into a 400.
      })
      .strict(),
  }),
  async (req, res) => {
    const { phone, name } = req.valid.body;

    const user = await User.findOne({ phone });

    const challenge = await otp.issueChallenge({
      purpose: 'login',
      destination: phone,
      user,
      // Held server-side for the life of the challenge; never returned.
      payload: user ? null : { name: name || null },
    });

    // 202 whether or not that number has an account, and whether or not the
    // account is active. Authentication is not complete and no token is issued.
    return res.status(202).json({ ...challenge, next: 'verify' });
  }
);

router.post(
  '/otp/verify',
  otpVerifyLimiter,
  validate({
    body: z.object({ challengeId: fields.nonEmptyString(80), code: fields.otpCode }).strict(),
  }),
  async (req, res) => {
    const { challengeId, code } = req.valid.body;
    const challenge = await otp.verifyChallenge({ challengeId, code, purpose: 'login' });

    // Returning an account: the challenge was bound to it when it was issued.
    if (challenge.user) {
      const user = await User.findById(challenge.user);
      if (!user) throw new ApiError(401, 'Unable to complete sign-in.', 'INVALID_CREDENTIALS');

      // Safe to be specific now: whoever holds this code owns the number, so
      // this discloses nothing to a third party.
      if (user.status !== 'active') {
        throw new ApiError(403, 'This account is not active. Contact support.', 'ACCOUNT_INACTIVE');
      }

      user.lastLoginAt = new Date();
      if (!user.phoneVerifiedAt) user.phoneVerifiedAt = new Date();
      await user.save();

      return res.json(await establishSession(user, req, res));
    }

    // First sign-in for this number: create the account. The phone comes from
    // the stored challenge, never from the request, so a challenge id cannot be
    // pointed at a number its holder does not control.
    const phone = challenge.destination;
    const { name } = challenge.payload || {};

    let user;
    try {
      user = await User.create({
        name: name || placeholderName(phone),
        phone,
        // Hardcoded, not derived from input. Self sign-up cannot yield a
        // privileged account under any request shape.
        role: SELF_SERVICE_ROLES[0],
        phoneVerifiedAt: new Date(),
        lastLoginAt: new Date(),
      });
    } catch (err) {
      // Two challenges for the same new number can be verified concurrently.
      // The unique index on `phone` settles it; the loser adopts the winner's
      // account rather than failing a sign-in that legitimately succeeded.
      if (err?.code !== 11000) throw err;
      user = await User.findOne({ phone });
      if (!user) throw err;
    }

    return res.status(201).json(await establishSession(user, req, res));
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

// ---------------------------------------------------------------------------
// Changing the phone number
// ---------------------------------------------------------------------------

/**
 * The phone number is the credential, so moving it is the single most dangerous
 * thing an account can do — it is exactly how a borrowed session becomes
 * permanent ownership. It therefore does NOT live in PATCH /api/users/:id with
 * the rest of the profile; it requires proving control of the NEW number, and
 * it signs every other device out when it lands.
 */
router.post(
  '/phone/start',
  requireAuth,
  otpRequestLimiter,
  otpStartIpLimiter,
  validate({ body: z.object({ phone: fields.phone }).strict() }),
  async (req, res) => {
    const { phone } = req.valid.body;

    if (phone === req.user.phone) {
      throw new ApiError(400, 'That is already your number.', 'PHONE_UNCHANGED');
    }

    const taken = await User.findOne({ phone }).select('_id').lean();
    if (taken) {
      throw new ApiError(409, 'That number is already in use.', 'DUPLICATE');
    }

    // Addressed to the NEW number: the point is to prove the account holder can
    // receive codes there, since that is what sign-in will depend on afterwards.
    const challenge = await otp.issueChallenge({
      purpose: 'phone_change',
      destination: phone,
      user: req.user,
      payload: { newPhone: phone },
    });

    return res.status(202).json({ ...challenge, next: 'verify' });
  }
);

router.post(
  '/phone/verify',
  requireAuth,
  otpVerifyLimiter,
  validate({
    body: z.object({ challengeId: fields.nonEmptyString(80), code: fields.otpCode }).strict(),
  }),
  async (req, res) => {
    const { challengeId, code } = req.valid.body;
    const challenge = await otp.verifyChallenge({ challengeId, code, purpose: 'phone_change' });

    // The challenge is bound to the account that started it. Without this, one
    // user's verified challenge id could be redeemed by another session.
    if (!challenge.user || !challenge.user.equals(req.user._id)) {
      throw new ApiError(403, 'This verification does not belong to your account.', 'FORBIDDEN');
    }

    const newPhone = challenge.payload?.newPhone;
    if (!newPhone) throw new ApiError(400, 'This verification is no longer valid.', 'OTP_INVALID');

    const user = await User.findById(req.user._id);
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    user.phone = newPhone;
    user.phoneVerifiedAt = new Date();
    // Anyone signed in on another device authenticated against the OLD number.
    // Cut them off rather than let a session outlive the credential it was
    // issued against.
    user.tokenVersion += 1;

    try {
      await user.save();
    } catch (err) {
      // Someone else claimed the number between start and verify.
      if (err?.code === 11000) {
        throw new ApiError(409, 'That number is already in use.', 'DUPLICATE');
      }
      throw err;
    }

    await tokens.revokeAllForUser(user._id);

    // Keep the device that did this signed in, with a token matching the new
    // tokenVersion.
    return res.json(await establishSession(user, req, res));
  }
);

// There is no password-change endpoint, because there is no password. The
// equivalent "lock everyone else out" action is POST /auth/logout-all above.

module.exports = router;
