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
const reverseOtp = require('../services/reverseOtp');
const {
  placeholderName,
  APP_ROLE_SCOPE,
  findByIdentifier,
  sessionPayload,
  establishSession,
} = require('../services/authSession');

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

/**
 * `placeholderName`, `APP_ROLE_SCOPE`, `findByIdentifier`,
 * `sessionPayload` and `establishSession` now live in services/authSession.js.
 * Reverse OTP signs people in too, and one shared copy is what keeps the two
 * flows from drifting apart. The reasoning behind each moved with it.
 */

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
  validate({
    body: z
      .object({
        // A number. It accepted an email address while one could resolve an
        // account; it cannot now, so an address is a 400 rather than a lookup
        // that can only ever answer "no".
        identifier: fields.phone,
        /**
         * Which app is asking, so "exists" means the account THAT app can sign
         * in — see `APP_ROLE_SCOPE`. Optional and unrestricted when omitted, so
         * a caller that predates app-scoping (or calls this directly) keeps the
         * old one-account-per-identifier behaviour rather than failing closed.
         */
        app: z.enum(['customer', 'shopkeeper', 'delivery']).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { identifier, app } = req.valid.body;
    const user = await findByIdentifier(identifier, app ? APP_ROLE_SCOPE[app] : undefined);

    /**
     * `type` is always 'phone' now and is kept only so an older client that
     * branches on it still parses. Email stopped being a way in when codes
     * stopped being delivered there.
     */
    return res.json({ exists: Boolean(user), type: 'phone' });
  }
);

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
        // original narrower form. Both are phones — `identifier` used to accept
        // an email address as well, and is left in place so a client that still
        // sends that key keeps working.
        identifier: fields.phone.optional(),
        phone: fields.phone.optional(),
        // Used only when this number has no account yet. Supplying it for an
        // existing account is ignored, so it cannot be used to overwrite the
        // name on someone else's account.
        name: fields.nonEmptyString(120).optional(),
        // Which app is asking — see `APP_ROLE_SCOPE`. Optional for the same
        // back-compat reason as on /lookup.
        app: z.enum(['customer', 'shopkeeper', 'delivery']).optional(),
        // `role` is intentionally absent. .strict() rejects it if supplied,
        // which turns a privilege-escalation attempt into a 400.
      })
      .strict()
      .refine((data) => Boolean(data.identifier || data.phone), {
        message: 'A mobile number is required.',
        path: ['identifier'],
      }),
  }),
  async (req, res) => {
    const { name, app } = req.valid.body;
    const identifier = req.valid.body.identifier ?? req.valid.body.phone;

    const user = await findByIdentifier(identifier, app ? APP_ROLE_SCOPE[app] : undefined);

    /**
     * Where the code goes.
     *
     * The proven phone, or the typed one for a number with no account yet.
     *
     * This used to fan out to every verified contact, so a login code reached a
     * verified email too. That is gone: once a code lands in a mailbox, account
     * security becomes the weaker of the two channels, and the phone is the
     * credential of record regardless. The case it was really insuring against —
     * a number the transport cannot reach — is covered by reverse OTP, which
     * proves the phone rather than routing around it.
     */
    let destination = identifier;

    if (user) {
      const contacts = user.verifiedContacts();

      if (contacts.length > 0) {
        destination = contacts[0];
      } else if (user.pendingPhone) {
        /**
         * A legacy account whose number was never proved.
         *
         * These exist because registration once completed on the email code
         * alone, storing the typed number as `pendingPhone` — unproven, and so
         * not a delivery destination. A verified email was how those users got
         * in, and removing email OTP would have locked every one of them out
         * permanently with no way back.
         *
         * Sending here is safe, and is in fact the repair: delivering a code to
         * the number and having it come back proves the number. /otp/verify
         * promotes it to `phone` on success.
         */
        destination = user.pendingPhone;
      } else {
        // No way to reach them at all. Answered like every other case so this
        // does not become a second oracle beside /lookup.
        return res.status(202).json({
          challengeId: null,
          channel: null,
          destination: otp.maskDestination(identifier),
          expiresAt: null,
          next: 'verify',
        });
      }
    } else if (app === 'shopkeeper' || app === 'delivery') {
      /**
       * A phone with no scoped match, on an app that never mints an account
       * from one.
       *
       * Falling through to the code below would still issue a challenge whose
       * verify step creates a plain `customer` account (see `SELF_SERVICE_ROLES`
       * in /otp/verify) — regardless of which app's login screen asked for it.
       * That auto-create path exists for exactly one case: a bare phone number
       * on the CUSTOMER app. A shopkeeper or delivery account is only ever
       * created through its own /register endpoint. Without this branch, someone typing their
       * number on the delivery app's sign-in screen for the first time would
       * silently get a customer account they can never see from that app —
       * the exact confusion self-registration was built to avoid.
       *
       * Answered the same non-committal way the branches above are: nothing
       * here reveals whether that was the reason.
       */
      return res.status(202).json({
        challengeId: null,
        channel: null,
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

      /**
       * Promote a number that was only ever pending.
       *
       * The code was delivered to `pendingPhone` and came back, which is the
       * whole definition of proving it. Without this the account would carry a
       * `phoneVerifiedAt` and no `phone` — a state nothing else in the app
       * expects, and the reason the profile screen showed no number at all.
       *
       * `pendingPhone` is stored but never reserved, so two accounts can hold
       * the same one and only the first to prove it gets it. The loser sees the
       * unique index, and is told plainly rather than shown a 500.
       */
      if (!user.phone && user.pendingPhone && user.pendingPhone === challenge.destination) {
        user.phone = user.pendingPhone;
        user.pendingPhone = undefined;
      }

      try {
        await user.save();
      } catch (err) {
        if (err?.code !== 11000) throw err;
        throw new ApiError(
          409,
          'That number now belongs to another account. Contact support.',
          'ALREADY_REGISTERED'
        );
      }

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
      // The unique index on `(phone, role)` settles it; the loser adopts the
      // winner's account rather than failing a sign-in that legitimately
      // succeeded. Scoped by role too now: this phone may also legitimately
      // back a `shopkeeper` or `delivery` account, and a bare `{ phone }`
      // lookup could resolve to one of those instead of the customer account
      // this race was actually over.
      if (err?.code !== 11000) throw err;
      user = await User.findOne({ phone, role: SELF_SERVICE_ROLES[0] });
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
 * ONE CODE, FOR THE PHONE. The phone is the only thing registration proves,
 * because it is the only thing a session is ever issued for.
 *
 * This used to prove two contacts, email and phone, each with its own code — and
 * the email leg was the required one, so an account could be created having
 * proved only an address. That inverted the security model: the credential of
 * record was the contact nobody had to demonstrate control of. Email is now an
 * ordinary detail on the account, stored for stall notices, proved by nothing.
 *
 * A PHONE THE TRANSPORT CANNOT REACH NO LONGER BLOCKS REGISTRATION EITHER, but
 * for a better reason than before. `phone.delivered` comes back false and the
 * client offers reverse OTP, where the user messages the code to us from the
 * number they are claiming. That still proves the number. The old fallback did
 * not — it stored the number unproven as `pendingPhone` and let the email code
 * carry the account.
 */
/**
 * Shared implementation behind /register/*, /vendor/register/* and
 * /delivery/register/*.
 *
 * They differ only in the role the account gets and the OTP `purpose` guarding
 * it — kept as distinct enum values (see models/OtpChallenge.js) rather than one
 * purpose plus a payload flag, so a code issued for a customer sign-up can never
 * be redeemed to mint a `shopkeeper` account.
 */
async function startRegistrationChallenge({ phone, name, purpose, role }) {
  /**
   * Taken means *verified*, by someone else, AS THIS ROLE.
   *
   * Scoped by `role` because a contact is not unique across the whole User
   * collection — it is unique per `(contact, role)`, see the comment on
   * models/User.js. The same phone or email may already back a `customer`
   * account and that is fine: registering a `shopkeeper` account for it is a
   * DIFFERENT (phone, role) / (email, role) pair, and the compound index has no
   * objection. What is refused is a second account of the SAME role for a
   * contact that already has one.
   *
   * A number sitting in another account's `pendingPhone` is unproven and
   * therefore still available regardless of role — whoever verifies it first
   * gets it — so `pendingPhone` is deliberately not checked here.
   *
   * Only the number is checked. The `(email, role)` index still exists, but no
   * address is supplied here to collide with one.
   */
  const phoneTaken = await User.findOne({ phone, role, status: { $ne: 'deleted' } })
    .select('_id')
    .lean();

  if (phoneTaken) {
    throw new ApiError(
      409,
      'You already have an account with that role. Try signing in instead.',
      'ALREADY_REGISTERED'
    );
  }

  const payload = { name: name || null, phone };

  let phoneChallenge = null;

  /**
   * Skipped outright when the phone transport cannot reach the user.
   *
   * The dev stub prints codes to stdout and reports success, so issuing a
   * challenge against it would tell the client a code was sent and put a code
   * input in front of someone who never received one.
   */
  if (notify.reachesRecipient('sms')) {
    try {
      phoneChallenge = await otp.issueChallenge({ purpose, destination: phone, payload });
    } catch (err) {
      console.warn('[auth] registration phone code undeliverable', {
        to: otp.maskDestination(phone),
        message: err?.message,
      });
    }
  } else {
    console.warn('[auth] registration phone code skipped: transport cannot reach the recipient');
  }

  /**
   * Nothing can deliver and nothing can receive — say so.
   *
   * With the email leg gone, reverse OTP is the whole of the fallback. If it is
   * not configured either, there is no way for this registration to complete,
   * and returning a challenge-shaped response would leave the user on a screen
   * that can never advance. Fail loudly at the start instead.
   */
  if (!phoneChallenge && !config.reverseOtp.whatsapp.configured && !config.reverseOtp.sms.configured) {
    throw new ApiError(
      503,
      'We cannot verify a number right now. Please try again shortly.',
      'OTP_DELIVERY_FAILED'
    );
  }

  return {
    phone: phoneChallenge
      ? { challengeId: phoneChallenge.challengeId, destination: phoneChallenge.destination, delivered: true }
      : { challengeId: null, destination: otp.maskDestination(phone), delivered: false },
    expiresAt: phoneChallenge?.expiresAt ?? null,
    next: 'verify',
    // Test-only, mirroring issueChallenge; never populated outside NODE_ENV=test.
    ...(config.isTest ? { devCodes: { phone: phoneChallenge?.devCode ?? null } } : {}),
  };
}

/**
 * Finish a registration by proving the phone, and only the phone.
 *
 * Two shapes, exactly one of which must be present:
 *
 *   - an outbound code (`phoneChallengeId` + `phoneCode`) — the default;
 *   - a reverse-OTP token (`phoneToken`) — the user messaged the code to us from
 *     the number instead, which works when nothing can be delivered to them.
 *
 * There is no third "neither" shape any more. It existed because the email code
 * could carry a registration on its own, leaving the number stored unproven as
 * `pendingPhone`. Nothing carries a registration but the phone now, so a
 * registration that cannot prove one does not become an account.
 *
 * WHERE THE ACCOUNT'S DETAILS COME FROM. The phone is taken from the stored
 * challenge, never from the request — holding a challenge id must not let you
 * point it at a number you do not control. `name` is read from the challenge's
 * payload when there is one and from the request otherwise, which is the only
 * option on the reverse path: that flow has no server-side record of what was
 * typed at /register/start. It is cosmetic either way.
 *
 * No account is created with an email address. One is attached later, from the
 * profile, through PATCH /api/users/:id.
 *
 * @param {string} role hardcoded by the caller, never derived from the request.
 */
async function completeRegistration({
  phoneChallengeId,
  phoneCode,
  phoneToken,
  name: bodyName,
  purpose,
  role,
}) {
  let phone = null;
  let name = bodyName || null;

  if (phoneChallengeId) {
    const phoneChallenge = await otp.verifyChallenge({
      challengeId: phoneChallengeId,
      code: phoneCode,
      purpose,
    });

    phone = phoneChallenge.destination;
    name = phoneChallenge.payload?.name || name;
  } else if (phoneToken) {
    /**
     * The reverse leg. Scoped to this flow's `purpose`, so a token raised for a
     * customer sign-up can never be spent minting a shopkeeper — the same rule
     * the outbound purposes enforce.
     *
     * Inspected before it is spent, so a token presented against the wrong
     * registration is refused without being destroyed — see the same reasoning
     * at /auth/reverse/complete/phone.
     */
    const pending = await reverseOtp.findRedeemable(phoneToken, { purpose });
    if (!pending) {
      throw new ApiError(400, 'This verification is no longer valid.', 'REVERSE_OTP_INVALID');
    }

    // Spend it with the number in the filter, so nothing can change underneath
    // between the read and the write.
    const reverseChallenge = await reverseOtp.consumeVerified(phoneToken, {
      purpose,
      phone: pending.phone,
    });
    if (!reverseChallenge) {
      throw new ApiError(400, 'This verification is no longer valid.', 'REVERSE_OTP_INVALID');
    }

    phone = reverseChallenge.phone;
  }

  if (!phone) throw new ApiError(400, 'This registration is no longer valid.', 'OTP_INVALID');

  const now = new Date();

  try {
    return await User.create({
      name: name || placeholderName(phone),
      phone,
      phoneVerifiedAt: now,
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
        // No `email`. Sign-up asks for a number and a name; an address is a
        // profile detail, added later by anyone who wants stall notices.
        name: fields.nonEmptyString(120).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const result = await startRegistrationChallenge({
      ...req.valid.body,
      purpose: 'registration',
      role: SELF_SERVICE_ROLES[0],
    });
    return res.status(202).json(result);
  }
);

/**
 * Complete registration.
 *
 * The phone must be proved, by an outbound code or by reverse OTP. There is no
 * longer a shape of this request that creates an account without it.
 */
router.post(
  '/register/verify',
  otpVerifyLimiter,
  validate({
    body: z
      .object({
        phoneChallengeId: fields.nonEmptyString(80).optional(),
        phoneCode: fields.otpCode.optional(),
        // The reverse-OTP alternative: the user messaged their number to us
        // rather than receiving a code. Replaces the pair above, never joins it.
        phoneToken: fields.nonEmptyString(80).optional(),
        /**
         * Only read on the reverse path, where no stored challenge holds what
         * was typed at /start. Cosmetic, and proved by nothing.
         */
        name: fields.nonEmptyString(120).optional(),
      })
      .strict()
      .refine((data) => !data.phoneChallengeId === !data.phoneCode, {
        message: 'A phone challenge id and code must be supplied together.',
        path: ['phoneCode'],
      })
      /**
       * Exactly one phone leg, never both and never neither.
       *
       * Both would leave which one actually proved the number ambiguous, and
       * `completeRegistration` would silently honour the outbound pair and leave
       * the reverse token unspent — still live, still redeemable elsewhere.
       *
       * Neither used to be allowed, because the email code could carry the
       * registration by itself. Nothing carries it but the phone now.
       */
      .refine((data) => Boolean(data.phoneChallengeId) !== Boolean(data.phoneToken), {
        message: 'Verify the mobile number with a code or by messaging us.',
        path: ['phoneToken'],
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
 * middleware/vendorVerified.js refuses every catalog write until the bank
 * account is verified. The role alone grants access to the panel, not the
 * ability to sell anything.
 */
router.post(
  '/vendor/register/start',
  otpRequestLimiter,
  otpStartIpLimiter,
  validate({
    body: z
      .object({
        phone: fields.phone,
        // No `email`. Sign-up asks for a number and a name; an address is a
        // profile detail, added later by anyone who wants stall notices.
        name: fields.nonEmptyString(120).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const result = await startRegistrationChallenge({
      ...req.valid.body,
      purpose: 'vendor_registration',
      role: 'shopkeeper',
    });
    return res.status(202).json(result);
  }
);

router.post(
  '/vendor/register/verify',
  otpVerifyLimiter,
  validate({
    body: z
      .object({
        phoneChallengeId: fields.nonEmptyString(80).optional(),
        phoneCode: fields.otpCode.optional(),
        // The reverse-OTP alternative: the user messaged their number to us
        // rather than receiving a code. Replaces the pair above, never joins it.
        phoneToken: fields.nonEmptyString(80).optional(),
        /**
         * Only read on the reverse path, where no stored challenge holds what
         * was typed at /start. Cosmetic, and proved by nothing.
         */
        name: fields.nonEmptyString(120).optional(),
      })
      .strict()
      .refine((data) => !data.phoneChallengeId === !data.phoneCode, {
        message: 'A phone challenge id and code must be supplied together.',
        path: ['phoneCode'],
      })
      /**
       * Exactly one phone leg, never both and never neither.
       *
       * Both would leave which one actually proved the number ambiguous, and
       * `completeRegistration` would silently honour the outbound pair and leave
       * the reverse token unspent — still live, still redeemable elsewhere.
       *
       * Neither used to be allowed, because the email code could carry the
       * registration by itself. Nothing carries it but the phone now.
       */
      .refine((data) => Boolean(data.phoneChallengeId) !== Boolean(data.phoneToken), {
        message: 'Verify the mobile number with a code or by messaging us.',
        path: ['phoneToken'],
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
 * prove one phone number can reach all of it. If that
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
        // No `email`. Sign-up asks for a number and a name; an address is a
        // profile detail, added later by anyone who wants stall notices.
        name: fields.nonEmptyString(120).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const result = await startRegistrationChallenge({
      ...req.valid.body,
      purpose: 'delivery_registration',
      role: 'delivery',
    });
    return res.status(202).json(result);
  }
);

router.post(
  '/delivery/register/verify',
  otpVerifyLimiter,
  validate({
    body: z
      .object({
        phoneChallengeId: fields.nonEmptyString(80).optional(),
        phoneCode: fields.otpCode.optional(),
        // The reverse-OTP alternative: the user messaged their number to us
        // rather than receiving a code. Replaces the pair above, never joins it.
        phoneToken: fields.nonEmptyString(80).optional(),
        /**
         * Only read on the reverse path, where no stored challenge holds what
         * was typed at /start. Cosmetic, and proved by nothing.
         */
        name: fields.nonEmptyString(120).optional(),
      })
      .strict()
      .refine((data) => !data.phoneChallengeId === !data.phoneCode, {
        message: 'A phone challenge id and code must be supplied together.',
        path: ['phoneCode'],
      })
      /**
       * Exactly one phone leg, never both and never neither.
       *
       * Both would leave which one actually proved the number ambiguous, and
       * `completeRegistration` would silently honour the outbound pair and leave
       * the reverse token unspent — still live, still redeemable elsewhere.
       *
       * Neither used to be allowed, because the email code could carry the
       * registration by itself. Nothing carries it but the phone now.
       */
      .refine((data) => Boolean(data.phoneChallengeId) !== Boolean(data.phoneToken), {
        message: 'Verify the mobile number with a code or by messaging us.',
        path: ['phoneToken'],
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

    /**
     * Scoped to THIS account's own role, matching the compound `(phone, role)`
     * index this write will actually be checked against — not a global
     * lookup. The same number may already be somebody's `customer` account,
     * quite possibly this same person's; moving a `shopkeeper` account onto
     * it is a different (phone, role) pair entirely and the database has no
     * objection. An unscoped check here would refuse a move the write itself
     * would have allowed.
     */
    const taken = await User.findOne({ phone, role: req.user.role }).select('_id').lean();
    if (taken) {
      throw new ApiError(409, 'That number is already in use by an account with your role.', 'DUPLICATE');
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
// Changing the email address
// ---------------------------------------------------------------------------

// There is no /email/start or /email/verify any more, and no `email_change` OTP
// purpose behind them. They existed because a login code was copied to a
// verified address, which made attaching one a security action rather than a
// profile edit: whoever briefly held a session could point it at themselves and
// receive every future code.
//
// Nothing is delivered to an email now, so that attack has nothing to work
// with. An address is an ordinary contact detail again — where a stall notice
// goes — and it is set through PATCH /api/users/:id like any other field.

// There is no password-change endpoint, because there is no password. The
// equivalent "lock everyone else out" action is POST /auth/logout-all above.

module.exports = router;
