'use strict';

const express = require('express');
const config = require('../config/env');
const User = require('../models/User');
const { SELF_SERVICE_ROLES } = require('../models/User');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { reverseOtpStartLimiter, reverseOtpStatusLimiter } = require('../middleware/rateLimit');
const reverseOtp = require('../services/reverseOtp');
const tokens = require('../services/tokens');
const {
  placeholderName,
  APP_ROLE_SCOPE,
  appMayCreateAccount,
  findByIdentifier,
  establishSession,
} = require('../services/authSession');

const router = express.Router();

/**
 * Reverse OTP routes — the user proves a number by messaging US.
 *
 *   POST /auth/reverse/start          { phone, purpose, app?, name? } -> code + links
 *   GET  /auth/reverse/status?token=                                  -> state
 *   POST /auth/reverse/complete       { token }                       -> session
 *   POST /auth/reverse/complete/phone { token }                       -> session (auth'd)
 *
 * WHY STATUS AND COMPLETE ARE SEPARATE
 *
 * The status poll is a plain read, called hundreds of times per verification.
 * Minting a session from it would make a GET set a refresh cookie — neither
 * idempotent nor safe against being triggered cross-site — and would fire on
 * whichever poll happened to land first rather than when the client asked. The
 * read stays a read; spending the token is an explicit POST.
 *
 * REGISTRATION IS NOT COMPLETED HERE. Creating the account is
 * /auth/register/verify's job (and its vendor and delivery siblings), so the
 * reverse token is handed there as `phoneToken` rather than spent on /complete.
 * /complete would mint a session without going through that route, which is
 * what stamps the role and (for vendors) the KYC-inert flag.
 */

const PURPOSES = ['login', 'registration', 'vendor_registration', 'delivery_registration', 'phone_change'];

/**
 * Purposes whose token /complete will spend. Registration is absent on purpose:
 * its token belongs to the register-verify routes, which are what create the
 * account under the right role. Redeeming it here would mint a customer session
 * for a vendor or rider sign-up.
 */
const COMPLETABLE_PURPOSES = ['login'];

/**
 * The text the user's messaging app is prefilled with.
 *
 * The code is the only part that matters; the prose is there so the message
 * makes sense to a human scrolling their own sent items later, and so it is
 * obvious what they are about to send before they send it.
 */
function messageFor(code) {
  return `Verify my number for VegDrop: ${code}`;
}

/**
 * Which channels to offer, with links already built.
 *
 * Only channels that are actually configured appear. Rendering a button that
 * opens a chat with nobody would produce a message that is never received and a
 * screen that waits forever — worse than not offering the option.
 */
function buildChannels(code) {
  const text = messageFor(code);
  const encoded = encodeURIComponent(text);
  const channels = { whatsapp: null, sms: null };

  if (config.reverseOtp.whatsapp.configured) {
    channels.whatsapp = {
      to: config.reverseOtp.whatsapp.inboxNumber,
      // wa.me wants digits only — no +, no spaces, no dashes.
      link: `https://wa.me/${config.reverseOtp.whatsapp.inboxNumber}?text=${encoded}`,
      message: text,
      assurance: 'high',
    };
  }

  if (config.reverseOtp.sms.configured) {
    const to = config.reverseOtp.sms.inboxNumber;
    channels.sms = {
      to,
      /**
       * RFC 5724 says `?body=`, and every current Android and iOS build honours
       * it. Some older iOS releases only accepted `&body=`, and the two
       * separators cannot both live in one href — so both forms are returned and
       * the client picks. The copy-the-code fallback in the UI is what actually
       * rescues anything neither form opens.
       */
      link: `sms:${to}?body=${encoded}`,
      linkLegacy: `sms:${to}&body=${encoded}`,
      message: text,
      /**
       * Deliberately flagged lower than WhatsApp. Meta signs its webhooks and
       * reports the sender from its own records; the SMS relay reports whatever
       * a handset read out of an SMS header, on a network where sender IDs can
       * be forged. Same flow, weaker evidence — said out loud rather than left
       * for someone to discover.
       */
      assurance: 'low',
    };
  }

  return channels;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

router.post(
  '/start',
  reverseOtpStartLimiter,
  validate({
    body: z
      .object({
        phone: fields.phone,
        purpose: z.enum(PURPOSES),
        app: z.enum(['customer', 'shopkeeper', 'delivery']).optional(),
        // Used only if this number turns into a new account. Ignored for an
        // existing one, so it cannot rename somebody else.
        name: fields.nonEmptyString(120).optional(),
        // `role` is intentionally absent; .strict() turns supplying it into a 400.
      })
      .strict(),
  }),
  async (req, res) => {
    const { phone, purpose, app = null, name } = req.valid.body;

    if (!reverseOtp.anyChannelConfigured()) {
      throw new ApiError(
        503,
        'This verification method is not available right now.',
        'REVERSE_OTP_NOT_CONFIGURED'
      );
    }

    /**
     * `phone_change` is an authenticated operation and has its own start route
     * below — it needs the session to bind the challenge to, and to refuse a
     * number already taken. Reaching it here would mint an unbound challenge.
     */
    if (purpose === 'phone_change') {
      throw new ApiError(400, 'Use the profile flow to change your number.', 'VALIDATION_ERROR');
    }

    /**
     * A challenge is issued for ANY number, whether or not it has an account.
     *
     * This is the same rule as /otp/start: if an unknown number were refused,
     * the difference would be observable and this would become a looser-limited
     * duplicate of /auth/lookup. What differs by account is what /complete will
     * do — see the `app` gate there.
     */
    const user =
      purpose === 'login' ? await findByIdentifier(phone, app ? APP_ROLE_SCOPE[app] : undefined) : null;

    const challenge = await reverseOtp.issueChallenge({
      purpose,
      phone,
      app,
      user,
      payload: user ? null : { name: name || null },
    });

    /**
     * The code IS returned here, unlike an outbound one. It has to be — the user
     * reads it off this screen and sends it to us. It is not a secret from them;
     * it is a secret from anyone who cannot also send from their number.
     */
    return res.status(201).json({
      token: challenge.token,
      code: challenge.code,
      expiresAt: challenge.expiresAt,
      channels: buildChannels(challenge.code),
    });
  }
);

/**
 * Starting a reverse phone change. Separate from /start because it is
 * authenticated and enforces the same two preconditions as /auth/phone/start:
 * the number must differ from the current one, and must be free for this role.
 */
router.post(
  '/start/phone',
  requireAuth,
  reverseOtpStartLimiter,
  validate({ body: z.object({ phone: fields.phone }).strict() }),
  async (req, res) => {
    const { phone } = req.valid.body;

    if (phone === req.user.phone) {
      throw new ApiError(400, 'That is already your number.', 'PHONE_UNCHANGED');
    }

    // Scoped to this account's own role, matching the compound (phone, role)
    // index the write is actually checked against — see /auth/phone/start.
    const taken = await User.findOne({ phone, role: req.user.role }).select('_id').lean();
    if (taken) {
      throw new ApiError(409, 'That number is already in use by an account with your role.', 'DUPLICATE');
    }

    const challenge = await reverseOtp.issueChallenge({
      purpose: 'phone_change',
      // The NEW number: the point is to prove the account holder can send from
      // the number sign-in will depend on afterwards.
      phone,
      user: req.user,
      payload: { newPhone: phone },
    });

    return res.status(201).json({
      token: challenge.token,
      code: challenge.code,
      expiresAt: challenge.expiresAt,
      channels: buildChannels(challenge.code),
    });
  }
);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

router.get(
  '/status',
  reverseOtpStatusLimiter,
  validate({ query: z.object({ token: fields.nonEmptyString(80) }).strict() }),
  async (req, res) => {
    const status = await reverseOtp.getStatus(req.valid.query.token);
    return res.json(status);
  }
);

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

router.post(
  '/complete',
  validate({ body: z.object({ token: fields.nonEmptyString(80) }).strict() }),
  async (req, res) => {
    const challenge = await reverseOtp.consumeVerified(req.valid.body.token, {
      purpose: COMPLETABLE_PURPOSES,
    });

    /**
     * Covers every way this can legitimately fail — no such token, not yet
     * verified, already spent, expired, or raised for a flow that finishes
     * elsewhere. One answer for all of them: the client polls status for the
     * real state, and a caller who does not hold the token learns nothing.
     */
    if (!challenge) {
      throw new ApiError(400, 'This verification is no longer valid.', 'REVERSE_OTP_INVALID');
    }

    // Returning account: the challenge was bound to it when it was issued.
    if (challenge.user) {
      const user = await User.findById(challenge.user);
      if (!user) throw new ApiError(401, 'Unable to complete sign-in.', 'INVALID_CREDENTIALS');

      if (user.status !== 'active') {
        throw new ApiError(403, 'This account is not active. Contact support.', 'ACCOUNT_INACTIVE');
      }

      user.lastLoginAt = new Date();
      if (!user.phoneVerifiedAt) user.phoneVerifiedAt = new Date();
      await user.save();

      return res.json(await establishSession(user, req, res));
    }

    /**
     * No account, and the app that asked is not allowed to mint one.
     *
     * `app` comes off the STORED challenge, never off this request — otherwise
     * omitting it would be enough to turn a shopkeeper sign-in into a customer
     * account. Shopkeeper and delivery accounts are only ever created through
     * their own registration routes, which hardcode the role; see the long
     * comment at /otp/start.
     */
    if (!appMayCreateAccount(challenge.app)) {
      throw new ApiError(401, 'Unable to complete sign-in.', 'INVALID_CREDENTIALS');
    }

    // First sign-in for this number. The phone comes from the stored challenge,
    // never from the request, so holding a token cannot point it at a number its
    // holder does not control.
    const phone = challenge.phone;
    const { name } = challenge.payload || {};

    let user;
    try {
      user = await User.create({
        name: name || placeholderName(phone),
        phone,
        // Hardcoded, not derived from input.
        role: SELF_SERVICE_ROLES[0],
        phoneVerifiedAt: new Date(),
        lastLoginAt: new Date(),
      });
    } catch (err) {
      // Two challenges for the same new number can complete concurrently. The
      // unique (phone, role) index settles it; the loser adopts the winner's
      // account rather than failing a sign-in that legitimately succeeded.
      if (err?.code !== 11000) throw err;
      user = await User.findOne({ phone, role: SELF_SERVICE_ROLES[0] });
      if (!user) throw err;
    }

    return res.status(201).json(await establishSession(user, req, res));
  }
);

/**
 * Completing a reverse phone change.
 *
 * `requireAuth` is router-level middleware rather than a check inside the
 * handler: without it `req.user` is undefined for an unauthenticated caller and
 * the ownership comparison below would throw before it could refuse.
 */
router.post(
  '/complete/phone',
  requireAuth,
  validate({ body: z.object({ token: fields.nonEmptyString(80) }).strict() }),
  async (req, res) => {
    const token = req.valid.body.token;

    /**
     * Inspected before it is spent.
     *
     * Consuming first and checking ownership afterwards would mean a stranger
     * presenting a token they somehow obtained still destroys it: they get a
     * 403, and the rightful owner's verification is gone with no way back except
     * starting over. Refusing without consuming leaves it intact.
     */
    const pending = await reverseOtp.findRedeemable(token, { purpose: 'phone_change' });

    if (!pending) {
      throw new ApiError(400, 'This verification is no longer valid.', 'REVERSE_OTP_INVALID');
    }

    // Bound to the account that started it. Without this, one user's verified
    // token could be redeemed by another session.
    if (!pending.user || String(pending.user) !== String(req.user._id)) {
      throw new ApiError(403, 'This verification does not belong to your account.', 'FORBIDDEN');
    }

    const newPhone = pending.payload?.newPhone;
    if (!newPhone) throw new ApiError(400, 'This verification is no longer valid.', 'REVERSE_OTP_INVALID');

    /**
     * Now spend it, with the owner in the filter so the check above cannot go
     * stale between the read and the write, and so a double submission gets a
     * document back exactly once.
     */
    const challenge = await reverseOtp.consumeVerified(token, {
      purpose: 'phone_change',
      user: req.user._id,
    });

    if (!challenge) {
      throw new ApiError(400, 'This verification is no longer valid.', 'REVERSE_OTP_INVALID');
    }

    const user = await User.findById(req.user._id);
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    user.phone = newPhone;
    user.phoneVerifiedAt = new Date();
    // Other devices authenticated against the OLD number. Cut them off rather
    // than let a session outlive the credential it was issued against.
    user.tokenVersion += 1;

    try {
      await user.save();
    } catch (err) {
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

module.exports = router;
