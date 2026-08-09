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
  lookupLimiter,
} = require('../middleware/rateLimit');
const otp = require('../services/otp');
const notify = require('../services/notify');
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

/**
 * Extra destinations that receive a copy of a login code.
 *
 * VERIFIED ADDRESSES ONLY, and the reason is the whole design.
 *
 * Once a code is delivered somewhere, that somewhere becomes a way in. An email
 * set through PATCH /api/users/:id is self-asserted, so copying codes to one
 * would turn a briefly-borrowed session into permanent ownership: set the
 * address, then receive every future code. That is exactly the attack closed by
 * removing `phone` from that endpoint, and `email` has since been removed from
 * it for the same reason — /auth/email/start|verify is now the only route to a
 * verified address, and it requires proving control of the new one.
 *
 * The phone stays the credential of record: it is what the challenge is bound to
 * and what a session is issued for. This is a copy, nothing more.
 */
function loginCopyTargets(user) {
  if (!config.email.configured) return [];
  if (!user?.email || !user.emailVerifiedAt) return [];
  return [user.email];
}

function isEmailIdentifier(identifier) {
  return String(identifier).includes('@');
}

/**
 * Resolve an account from whatever was typed into the single sign-in box.
 *
 * `pendingPhone` is matched too. Someone who registered while WhatsApp was down
 * knows only the number they typed; not matching it would tell them no account
 * exists, send them back through registration, and fail on the email already
 * being taken. They are found here and signed in through their verified email —
 * the unproven number still receives nothing.
 */
async function findByIdentifier(identifier) {
  if (isEmailIdentifier(identifier)) {
    return User.findOne({ email: identifier, status: { $ne: 'deleted' } });
  }
  return User.findOne({
    $or: [{ phone: identifier }, { pendingPhone: identifier }],
    status: { $ne: 'deleted' },
  });
}

// ---------------------------------------------------------------------------
// Identifier lookup
// ---------------------------------------------------------------------------

/**
 * Does this identifier have an account?
 *
 * THIS IS AN ACCOUNT-ENUMERATION ORACLE, and it is one on purpose.
 *
 * The sign-in flow below was built so that "no account for this number" is not
 * observable — start answers identically either way. This endpoint gives that up
 * because the product needs to branch to a registration form before a code is
 * sent. The leak is real: anyone may test whether a given number or address is a
 * customer.
 *
 * What contains it is `lookupLimiter`, the tightest budget in the app at 20 per
 * hour per source. That leaves a targeted check trivial and a sweep pointless.
 * If the enumeration risk ever outweighs the UX, the fix is to move the
 * new-or-existing decision to *after* code verification rather than to loosen
 * this limiter.
 */
router.post(
  '/lookup',
  lookupLimiter,
  validate({ body: z.object({ identifier: fields.identifier }).strict() }),
  async (req, res) => {
    const { identifier } = req.valid.body;
    const user = await findByIdentifier(identifier);

    return res.json({
      exists: Boolean(user),
      type: isEmailIdentifier(identifier) ? 'email' : 'phone',
    });
  }
);

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
        // Either key works: `identifier` is the single sign-in box, `phone` the
        // original narrower form.
        identifier: fields.identifier.optional(),
        phone: fields.phone.optional(),
        // Used only when this number has no account yet. Supplying it for an
        // existing account is ignored, so it cannot be used to overwrite the
        // name on someone else's account.
        name: fields.nonEmptyString(120).optional(),
        // `role` is intentionally absent. .strict() rejects it if supplied,
        // which turns a privilege-escalation attempt into a 400.
      })
      .strict()
      .refine((data) => Boolean(data.identifier || data.phone), {
        message: 'A mobile number or email address is required.',
        path: ['identifier'],
      }),
  }),
  async (req, res) => {
    const { name } = req.valid.body;
    const identifier = req.valid.body.identifier ?? req.valid.body.phone;

    const user = await findByIdentifier(identifier);

    /**
     * Where the code goes.
     *
     * For an existing account it goes to every VERIFIED contact, one code
     * shared between them — the typed identifier is how they were found, not
     * where delivery is aimed. Someone who types a number whose verification
     * never completed is reached at their email instead.
     */
    let destination = identifier;
    let copyTo = [];

    if (user) {
      const contacts = user.verifiedContacts();

      if (contacts.length === 0) {
        // No proven way to reach them. Answered like every other case so this
        // does not become a second oracle beside /lookup.
        return res.status(202).json({
          challengeId: null,
          channel: null,
          destination: otp.maskDestination(identifier),
          expiresAt: null,
          next: 'verify',
        });
      }

      destination = contacts[0];
      copyTo = config.email.configured ? contacts.slice(1) : [];
    } else if (isEmailIdentifier(identifier)) {
      /**
       * An email with no account. Registration needs a phone number too, so
       * there is nothing to create here — and answering 404 would make this a
       * looser-limited duplicate of /lookup. Answer as though a code was sent.
       */
      return res.status(202).json({
        challengeId: null,
        channel: 'email',
        destination: otp.maskDestination(identifier),
        expiresAt: null,
        next: 'verify',
      });
    }

    const challenge = await otp.issueChallenge({
      purpose: 'login',
      destination,
      user,
      // Held server-side for the life of the challenge; never returned.
      payload: user ? null : { name: name || null },
      copyTo,
    });

    // 202 whether or not that identifier has an account, and whether or not the
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
// Registration — a separate flow, because the client asks for both contacts
// ---------------------------------------------------------------------------

/**
 * Start registration for someone with no account.
 *
 * TWO CODES, NOT ONE. Each contact gets its own challenge and its own code, so
 * each is proved independently. Sharing one code between them would mean holding
 * either channel proves both, and the number would be attached to the account
 * without anyone showing they can receive anything at it.
 *
 * WHATSAPP BEING DOWN DOES NOT BLOCK REGISTRATION. If the phone code cannot be
 * delivered, `phone.delivered` comes back false and the client hides that input;
 * the account is created on the verified email alone and the number is kept as
 * `pendingPhone` — stored, not reserved, and never a delivery destination until
 * it is proved. Reserving it would let anyone type a stranger's number and lock
 * its real owner out of registering.
 */
/**
 * Shared implementation behind /register/* and /vendor/register/*.
 *
 * Both flows prove two independent contacts before creating an account. They
 * differ only in the role the account gets and the OTP `purpose` guarding it —
 * kept as distinct enum values (see models/OtpChallenge.js) rather than one
 * purpose plus a payload flag, so a code issued for a customer sign-up can
 * never be redeemed to mint a `shopkeeper` account.
 */
async function startRegistrationChallenge({ phone, email, name, purpose }) {
  /**
   * Taken means *verified* by someone else. A number sitting in another
   * account's `pendingPhone` is unproven and therefore still available —
   * whoever verifies it first gets it.
   */
  const [phoneTaken, emailTaken] = await Promise.all([
    User.findOne({ phone, status: { $ne: 'deleted' } }).select('_id').lean(),
    User.findOne({ email, status: { $ne: 'deleted' } }).select('_id').lean(),
  ]);

  if (phoneTaken || emailTaken) {
    throw new ApiError(
      409,
      'An account already exists for those details. Try signing in instead.',
      'ALREADY_REGISTERED'
    );
  }

  const payload = { name: name || null, phone, email };

  // The email leg first: it is the one registration cannot complete without,
  // so a failure here is fatal and nothing else has happened yet.
  const emailChallenge = await otp.issueChallenge({ purpose, destination: email, payload });

  let phoneChallenge = null;

  /**
   * Skipped outright when the phone transport cannot reach the user.
   *
   * The dev stub prints codes to stdout and reports success, so issuing a
   * challenge against it would tell the client a code was sent and put a code
   * input in front of someone who never received one. A deployment still on
   * NOTIFY_TRANSPORT=console is exactly the "WhatsApp is unavailable" case
   * this flow already handles — treat it as such rather than as a send.
   */
  if (notify.reachesRecipient('sms')) {
    try {
      phoneChallenge = await otp.issueChallenge({ purpose, destination: phone, payload });
    } catch (err) {
      // Exactly the case this flow exists to tolerate.
      console.warn('[auth] registration phone code undeliverable', {
        to: otp.maskDestination(phone),
        message: err?.message,
      });
    }
  } else {
    console.warn('[auth] registration phone code skipped: transport cannot reach the recipient');
  }

  return {
    email: { challengeId: emailChallenge.challengeId, destination: emailChallenge.destination, delivered: true },
    phone: phoneChallenge
      ? { challengeId: phoneChallenge.challengeId, destination: phoneChallenge.destination, delivered: true }
      : { challengeId: null, destination: otp.maskDestination(phone), delivered: false },
    expiresAt: emailChallenge.expiresAt,
    next: 'verify',
    // Test-only, mirroring issueChallenge; never populated outside NODE_ENV=test.
    ...(config.isTest
      ? { devCodes: { email: emailChallenge.devCode, phone: phoneChallenge?.devCode ?? null } }
      : {}),
  };
}

/**
 * The email code is required; the phone code is optional and its absence is
 * what "WhatsApp was down" looks like on the wire. A phone proved here becomes
 * the account's `phone`; one that was not becomes `pendingPhone`.
 *
 * @param {string} role hardcoded by the caller, never derived from the request.
 */
async function completeRegistration({ emailChallengeId, emailCode, phoneChallengeId, phoneCode, purpose, role }) {
  const emailChallenge = await otp.verifyChallenge({ challengeId: emailChallengeId, code: emailCode, purpose });

  const email = emailChallenge.destination;
  const { name, phone } = emailChallenge.payload || {};

  if (!phone) throw new ApiError(400, 'This registration is no longer valid.', 'OTP_INVALID');

  let phoneVerified = false;
  if (phoneChallengeId) {
    const phoneChallenge = await otp.verifyChallenge({ challengeId: phoneChallengeId, code: phoneCode, purpose });

    // Both codes must belong to the same registration, or one person's phone
    // code could be paired with another's email code.
    if (phoneChallenge.payload?.email !== email || phoneChallenge.destination !== phone) {
      throw new ApiError(400, 'These codes are from different registrations.', 'OTP_INVALID');
    }
    phoneVerified = true;
  }

  const now = new Date();

  try {
    return await User.create({
      name: name || placeholderName(phone),
      email,
      emailVerifiedAt: now,
      // Only a proved number is written to `phone`, where it is reserved.
      ...(phoneVerified ? { phone, phoneVerifiedAt: now } : { pendingPhone: phone, phoneVerifiedAt: null }),
      role,
      lastLoginAt: now,
    });
  } catch (err) {
    // Someone claimed one of these between start and verify.
    if (err?.code !== 11000) throw err;
    throw new ApiError(
      409,
      'An account already exists for those details. Try signing in instead.',
      'ALREADY_REGISTERED'
    );
  }
}

router.post(
  '/register/start',
  otpRequestLimiter,
  otpStartIpLimiter,
  validate({
    body: z
      .object({
        phone: fields.phone,
        email: fields.email,
        name: fields.nonEmptyString(120).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    if (!config.email.configured) {
      throw new ApiError(503, 'Registration is temporarily unavailable.', 'EMAIL_NOT_CONFIGURED');
    }

    const result = await startRegistrationChallenge({ ...req.valid.body, purpose: 'registration' });
    return res.status(202).json(result);
  }
);

/**
 * Complete registration.
 *
 * The email code is required; the phone code is optional and its absence is what
 * "WhatsApp was down" looks like on the wire. A phone proved here becomes the
 * account's `phone`; one that was not becomes `pendingPhone`.
 */
router.post(
  '/register/verify',
  otpVerifyLimiter,
  validate({
    body: z
      .object({
        emailChallengeId: fields.nonEmptyString(80),
        emailCode: fields.otpCode,
        phoneChallengeId: fields.nonEmptyString(80).optional(),
        phoneCode: fields.otpCode.optional(),
      })
      .strict()
      .refine((data) => !data.phoneChallengeId === !data.phoneCode, {
        message: 'A phone challenge id and code must be supplied together.',
        path: ['phoneCode'],
      }),
  }),
  async (req, res) => {
    // Hardcoded. Self sign-up cannot yield a privileged account.
    const user = await completeRegistration({ ...req.valid.body, purpose: 'registration', role: SELF_SERVICE_ROLES[0] });
    return res.status(201).json(await establishSession(user, req, res));
  }
);

// ---------------------------------------------------------------------------
// Vendor registration — same dual-OTP flow, a different role and OTP purpose
// ---------------------------------------------------------------------------

/**
 * A vendor account created here is inert: it has no stall's worth of products
 * (nothing distinguishes it from any other shopkeeper yet, since this catalog
 * has no per-vendor ownership) and, more importantly, no KYC record — so
 * middleware/vendorVerified.js refuses every catalog write until the PAN and
 * bank account are verified. The role alone grants access to the panel, not
 * the ability to sell anything.
 */
router.post(
  '/vendor/register/start',
  otpRequestLimiter,
  otpStartIpLimiter,
  validate({
    body: z
      .object({
        phone: fields.phone,
        email: fields.email,
        name: fields.nonEmptyString(120).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    if (!config.email.configured) {
      throw new ApiError(503, 'Registration is temporarily unavailable.', 'EMAIL_NOT_CONFIGURED');
    }

    const result = await startRegistrationChallenge({ ...req.valid.body, purpose: 'vendor_registration' });
    return res.status(202).json(result);
  }
);

router.post(
  '/vendor/register/verify',
  otpVerifyLimiter,
  validate({
    body: z
      .object({
        emailChallengeId: fields.nonEmptyString(80),
        emailCode: fields.otpCode,
        phoneChallengeId: fields.nonEmptyString(80).optional(),
        phoneCode: fields.otpCode.optional(),
      })
      .strict()
      .refine((data) => !data.phoneChallengeId === !data.phoneCode, {
        message: 'A phone challenge id and code must be supplied together.',
        path: ['phoneCode'],
      }),
  }),
  async (req, res) => {
    // Hardcoded, not derived from input — the route path is what selects this
    // role, never a request body field.
    const user = await completeRegistration({ ...req.valid.body, purpose: 'vendor_registration', role: 'shopkeeper' });
    return res.status(201).json({
      ...(await establishSession(user, req, res)),
      // Tells the client to open the KYC form rather than the (empty) dashboard.
      nextStep: 'kyc',
    });
  }
);

// ---------------------------------------------------------------------------
// Delivery agent registration — same dual-OTP flow, a different role and purpose
// ---------------------------------------------------------------------------

/**
 * Unlike the vendor equivalent above, an account created here can work
 * immediately: `findNearestRider` in services/dispatch.js selects on
 * `role: 'delivery'` plus a fresh location and an `online` duty status, and
 * there is no verification record standing between those two facts.
 *
 * That is a deliberate product decision, not an oversight, and it is worth
 * stating plainly because of what an offer carries: the customer's name, phone
 * number and home address, and — on a COD order — their cash. Anyone who can
 * receive one code by email and one over WhatsApp can reach all of it. If that
 * ever needs tightening, the gate belongs in `findNearestRider` and on the
 * duty-status write in routes/rider.js, NOT here: refusing at registration
 * would leave the applicant with an account they cannot use and no way to see
 * why, and `User.status` cannot express "pending" because middleware/auth.js
 * rejects any non-active user before they could read such a screen.
 */
router.post(
  '/delivery/register/start',
  otpRequestLimiter,
  otpStartIpLimiter,
  validate({
    body: z
      .object({
        phone: fields.phone,
        email: fields.email,
        name: fields.nonEmptyString(120).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    if (!config.email.configured) {
      throw new ApiError(503, 'Registration is temporarily unavailable.', 'EMAIL_NOT_CONFIGURED');
    }

    const result = await startRegistrationChallenge({ ...req.valid.body, purpose: 'delivery_registration' });
    return res.status(202).json(result);
  }
);

router.post(
  '/delivery/register/verify',
  otpVerifyLimiter,
  validate({
    body: z
      .object({
        emailChallengeId: fields.nonEmptyString(80),
        emailCode: fields.otpCode,
        phoneChallengeId: fields.nonEmptyString(80).optional(),
        phoneCode: fields.otpCode.optional(),
      })
      .strict()
      .refine((data) => !data.phoneChallengeId === !data.phoneCode, {
        message: 'A phone challenge id and code must be supplied together.',
        path: ['phoneCode'],
      }),
  }),
  async (req, res) => {
    // Hardcoded, not derived from input — the route path is what selects this
    // role, never a request body field.
    const user = await completeRegistration({ ...req.valid.body, purpose: 'delivery_registration', role: 'delivery' });
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

// ---------------------------------------------------------------------------
// Adding or changing the email address
// ---------------------------------------------------------------------------

/**
 * Email is a delivery destination for login codes, so attaching one is a
 * security action, not a profile edit.
 *
 * It used to live in PATCH /api/users/:id, which was correct while nothing was
 * ever delivered to an email. Now that a code is copied there, an unverified
 * address is a way in: whoever briefly holds a session could point it at
 * themselves and receive every future code. So it moved here, behind proof of
 * control of the NEW address — the same treatment, and for the same reason, as
 * /auth/phone/start above.
 *
 * Unlike a phone change this does NOT revoke other sessions. The phone remains
 * the credential; adding a copy destination does not invalidate sessions that
 * were authenticated against the number.
 */
router.post(
  '/email/start',
  requireAuth,
  otpRequestLimiter,
  otpStartIpLimiter,
  validate({ body: z.object({ email: fields.email }).strict() }),
  async (req, res) => {
    const { email } = req.valid.body;

    if (!config.email.configured) {
      throw new ApiError(503, 'Email delivery is not configured.', 'EMAIL_NOT_CONFIGURED');
    }

    if (email === req.user.email && req.user.emailVerifiedAt) {
      throw new ApiError(400, 'That is already your verified email.', 'EMAIL_UNCHANGED');
    }

    const taken = await User.findOne({ email }).select('_id').lean();
    if (taken && !taken._id.equals(req.user._id)) {
      throw new ApiError(409, 'That email is already in use.', 'DUPLICATE');
    }

    // Addressed to the NEW address, which is the entire point.
    const challenge = await otp.issueChallenge({
      purpose: 'email_change',
      destination: email,
      user: req.user,
      payload: { newEmail: email },
    });

    return res.status(202).json({ ...challenge, next: 'verify' });
  }
);

router.post(
  '/email/verify',
  requireAuth,
  otpVerifyLimiter,
  validate({
    body: z.object({ challengeId: fields.nonEmptyString(80), code: fields.otpCode }).strict(),
  }),
  async (req, res) => {
    const { challengeId, code } = req.valid.body;
    const challenge = await otp.verifyChallenge({ challengeId, code, purpose: 'email_change' });

    // Bound to the account that started it, so one user's verified challenge id
    // cannot be redeemed by another session.
    if (!challenge.user || !challenge.user.equals(req.user._id)) {
      throw new ApiError(403, 'This verification does not belong to your account.', 'FORBIDDEN');
    }

    const newEmail = challenge.payload?.newEmail;
    if (!newEmail) throw new ApiError(400, 'This verification is no longer valid.', 'OTP_INVALID');

    const user = await User.findById(req.user._id);
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    user.email = newEmail;
    user.emailVerifiedAt = new Date();

    try {
      await user.save();
    } catch (err) {
      // Someone else claimed the address between start and verify.
      if (err?.code === 11000) {
        throw new ApiError(409, 'That email is already in use.', 'DUPLICATE');
      }
      throw err;
    }

    return res.json({ user: user.toPublicJSON() });
  }
);

// There is no password-change endpoint, because there is no password. The
// equivalent "lock everyone else out" action is POST /auth/logout-all above.

module.exports = router;
