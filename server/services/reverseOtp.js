'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const ReverseOtpChallenge = require('../models/ReverseOtpChallenge');
const { ApiError } = require('../middleware/errors');

/**
 * Reverse OTP — proving a phone number by receiving a message instead of sending
 * one.
 *
 * The ordinary flow (services/otp.js) sends a code to a number and asks for it
 * back, which proves the user can RECEIVE there. This shows the user a code and
 * asks them to message it to our inbox, which proves they can SEND from there.
 *
 * WHY BOTHER
 *
 * Business-initiated WhatsApp messages need a Meta-approved AUTHENTICATION
 * template and cost money per send. Inbound messages need neither. And because
 * we never dispatch anything, there is no delivery to fail silently — the class
 * of bug where a code is accepted by the provider, never arrives, and the user
 * is left guessing simply cannot occur.
 *
 * WHAT PROVES WHAT
 *
 * The code is not the secret. It is displayed on screen and carried through the
 * user's own messaging app; anyone looking over their shoulder has it. The proof
 * is that the message arrived FROM the number being claimed, as attested by the
 * inbound channel. The code decides *which* pending session an arriving message
 * settles, and stops an old message from settling a new login.
 *
 * That makes the assurance of this flow exactly the assurance of the channel's
 * sender attestation, and the two channels are NOT equal:
 *
 *   - WhatsApp Cloud API webhooks are HMAC-signed by Meta over the raw body, and
 *     the sender is Meta's own record of who sent it. Strong.
 *   - The SMS relay reports whatever a phone read out of an SMS header, over a
 *     network where sender IDs are spoofable. Weaker — surfaced to the client as
 *     `assurance: 'low'` rather than quietly treated as equivalent.
 */

const { alphabet, codeLength, ttlSeconds } = config.reverseOtp;

/** Matches a run of exactly our alphabet, used to pull codes out of free text. */
const CODE_PATTERN = new RegExp(`[${alphabet}]{${codeLength}}`, 'g');

/** How many times to retry when a freshly generated code collides. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * A code from the unambiguous alphabet.
 *
 * `randomInt` rather than `randomBytes` % length: the modulo of a byte over a
 * 31-character alphabet is biased toward the first few characters, and biased
 * codes shrink the space an attacker has to search.
 */
function generateCode() {
  let code = '';
  for (let i = 0; i < codeLength; i += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return code;
}

/**
 * HMAC of the code alone — no per-challenge salt.
 *
 * services/otp.js mixes the challenge id into its preimage, which binds a hash
 * to one challenge and blocks replay across them. That is impossible here: an
 * arriving message carries only the code, so the code is the only thing we can
 * look the challenge up BY. Single-use is enforced by the unique index and the
 * `verifiedAt: null` guards instead.
 */
function hashCode(code) {
  return crypto.createHmac('sha256', config.otp.pepper).update(code).digest('hex');
}

/**
 * Reduce any rendering of a number to the 10 local digits the database stores.
 *
 * Inbound senders arrive fully qualified (`919876543210` from Meta, `+91 98765
 * 43210` from an SMS header). Taking the last 10 digits normalises every form
 * to one — by LENGTH, never by stripping a `91` prefix, which would corrupt a
 * number that legitimately begins with those digits. Same reasoning as the
 * comment on `fields.phone` in middleware/validate.js.
 */
function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '').slice(-10);
}

/** ******3210 — enough to recognise your own number, not enough to harvest one. */
function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Which channels can actually receive a message right now. */
function availableChannels() {
  return {
    whatsapp: config.reverseOtp.whatsapp.configured,
    sms: config.reverseOtp.sms.configured,
  };
}

function anyChannelConfigured() {
  const channels = availableChannels();
  return channels.whatsapp || channels.sms;
}

/**
 * Issue a challenge: mint a code, store its hash, hand back the code and a poll
 * token.
 *
 * Unlike the outbound flow there is nothing to deliver, so there is no cooldown
 * and no delivery failure to roll back — the only cost of issuing one is a row.
 */
async function issueChallenge({ purpose, phone, app = null, user = null, payload = null }) {
  if (!anyChannelConfigured()) {
    /**
     * Fail closed. An unconfigured channel must never degrade into "allow": a
     * challenge nobody can ever send a message to would sit at "waiting" until
     * it expired, which reads to the user as a broken app rather than a disabled
     * feature.
     */
    throw new ApiError(
      503,
      'This verification method is not available right now.',
      'REVERSE_OTP_NOT_CONFIGURED'
    );
  }

  const normalizedPhone = normalizePhone(phone);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  let created = null;
  let code = null;

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    code = generateCode();
    try {
      created = await ReverseOtpChallenge.create({
        token: crypto.randomBytes(32).toString('hex'),
        codeHash: hashCode(code),
        phone: normalizedPhone,
        purpose,
        app,
        user: user?._id ?? null,
        payload,
        expiresAt,
      });
      break;
    } catch (err) {
      // The unique index on codeHash says this exact code is already live for
      // somebody. Astronomically rare over 31^6, but a collision would let one
      // person's message settle another's session, so it is retried rather than
      // tolerated.
      if (err?.code !== 11000) throw err;
    }
  }

  if (!created) {
    throw new ApiError(503, 'Could not start verification. Please try again.', 'REVERSE_OTP_UNAVAILABLE');
  }

  /**
   * Supersede this phone's other open challenges for the same purpose.
   *
   * Without it, tapping "start over" leaves the first challenge live: the user
   * sends the NEW code, the OLD challenge stays pending forever, and any screen
   * still polling it waits on a message that will never come. Mirrors the
   * supersede step in services/otp.js.
   *
   * Scoped by `app` as well as by account, for the reason services/otp.js scopes
   * its own by account: one number can back a separate account per role. Two of
   * those accounts signing in at once share `user: null` until they exist, so
   * without the app in the filter a shopkeeper starting a reverse sign-in would
   * silently kill the customer one the same person opened a moment earlier.
   */
  await ReverseOtpChallenge.updateMany(
    {
      _id: { $ne: created._id },
      phone: normalizedPhone,
      purpose,
      app,
      user: user?._id ?? null,
      consumedAt: null,
    },
    { $set: { consumedAt: new Date() } }
  );

  return { token: created.token, code, expiresAt: created.expiresAt };
}

/**
 * Match an inbound message against pending challenges.
 *
 * ATOMICITY
 *
 * Every branch is a single conditional `findOneAndUpdate`, never a read followed
 * by a write. The filters do the deciding, so two messages arriving at once
 * cannot both win and neither can overwrite the other's outcome.
 *
 * `verifiedAt: null` appears in every filter that sets a failure flag. That is
 * the whole of the "verified always wins" rule: once a correct send has stamped
 * `verifiedAt`, no later or concurrent wrong-number message can paint a stale
 * `mismatch` or `badCode` over a session that already succeeded.
 */
async function matchInbound({ from, text, channel = 'whatsapp' }) {
  const sender = normalizePhone(from);
  if (!sender) return { matched: false };

  const body = String(text ?? '').toUpperCase();
  // Dedupe: someone quoting the code twice should not count as two attempts.
  const codes = [...new Set(body.match(CODE_PATTERN) ?? [])];

  for (const code of codes) {
    const codeHash = hashCode(code);
    const now = new Date();

    // A — the code is live AND it came from the number that claimed it.
    const verified = await ReverseOtpChallenge.findOneAndUpdate(
      { codeHash, phone: sender, consumedAt: null, verifiedAt: null, expiresAt: { $gt: now } },
      { $set: { verifiedAt: now, mismatch: false, mismatchFrom: null, badCode: false } },
      { returnDocument: 'after' }
    );

    if (verified) {
      console.info('[reverse-otp] verified', {
        channel,
        purpose: verified.purpose,
        phone: maskPhone(sender),
      });
      return { matched: true };
    }

    /**
     * B — the code is live but somebody ELSE sent it. Refused, and recorded so
     * the waiting screen can say why. Silence here is the worst outcome: the
     * legitimate user sees no progress and has no idea their friend forwarded
     * the message from the wrong handset.
     */
    const mismatched = await ReverseOtpChallenge.findOneAndUpdate(
      {
        codeHash,
        phone: { $ne: sender },
        consumedAt: null,
        verifiedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { mismatch: true, mismatchFrom: sender } }
    );

    if (mismatched) {
      console.warn('[reverse-otp] sender mismatch', {
        channel,
        expected: maskPhone(mismatched.phone),
        got: maskPhone(sender),
      });
    }
  }

  /**
   * C — nothing in the message matched a live code, but this sender has a
   * session open. Almost always a typo or an edited prefill. Flagging it turns
   * an indefinite "waiting" into "we got your message, the code didn't match".
   */
  const stray = await ReverseOtpChallenge.findOneAndUpdate(
    { phone: sender, consumedAt: null, verifiedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { badCode: true } },
    { sort: { createdAt: -1 } }
  );

  if (stray) {
    console.info('[reverse-otp] message did not contain a valid code', {
      channel,
      phone: maskPhone(sender),
    });
  }

  return { matched: false };
}

/**
 * Current state of a challenge, for the polling client.
 *
 * Expiry is decided on the timestamp, not on the document being gone: MongoDB's
 * TTL reaper only sweeps about once a minute, so an expired challenge is still
 * readable for a while after it stopped being valid.
 */
async function getStatus(token) {
  const challenge = await ReverseOtpChallenge.findOne({ token }).lean();

  /**
   * Everything with nothing left to wait for answers `expired`, and the client
   * has one response to all of it: offer a fresh code.
   *
   * That covers an unknown token, a TTL-reaped one, a token already spent for a
   * session, and — the common case — one superseded because the user tapped
   * "start over" and is now looking at a different code. Distinguishing them
   * would give the client four ways to say the same sentence, and would let a
   * caller who does not hold the token learn which tokens once existed.
   */
  if (!challenge) return { state: 'expired' };
  if (challenge.consumedAt) return { state: 'expired' };

  if (challenge.verifiedAt) {
    return { state: 'verified', purpose: challenge.purpose, expiresAt: challenge.expiresAt };
  }
  if (challenge.expiresAt.getTime() <= Date.now()) return { state: 'expired' };

  if (challenge.mismatch) {
    return {
      state: 'mismatch',
      purpose: challenge.purpose,
      expiresAt: challenge.expiresAt,
      // The number they were meant to send from — which they typed themselves,
      // so echoing it masked discloses nothing. The number they actually sent
      // FROM is deliberately not returned: it may be a stranger's.
      expectedPhone: maskPhone(challenge.phone),
    };
  }

  if (challenge.badCode) {
    return { state: 'bad_code', purpose: challenge.purpose, expiresAt: challenge.expiresAt };
  }

  return { state: 'pending', purpose: challenge.purpose, expiresAt: challenge.expiresAt };
}

function redeemableFilter({ token, purpose, user, phone }) {
  const filter = {
    token,
    verifiedAt: { $ne: null },
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  };

  if (purpose) filter.purpose = Array.isArray(purpose) ? { $in: purpose } : purpose;
  if (user) filter.user = user;
  if (phone) filter.phone = phone;

  return filter;
}

/**
 * Look at a redeemable challenge WITHOUT spending it.
 *
 * Exists so a caller can refuse a token on its merits before consuming it. A
 * route that consumes first and validates afterwards burns the challenge on
 * every rejection — which hands anyone who obtains a token a way to destroy the
 * verification it stands for, without being able to use it. Checking first
 * leaves a wrongly-presented token untouched and still usable by its owner.
 */
async function findRedeemable(token, { purpose } = {}) {
  return ReverseOtpChallenge.findOne(redeemableFilter({ token, purpose })).lean();
}

/**
 * Spend a verified challenge.
 *
 * One atomic step, so a client that fires twice — a retry, a double tap, two
 * polls landing together — gets a document back exactly once. The second caller
 * sees null and the route turns that into an error rather than a second session.
 *
 * `purpose` is part of the filter: a token raised for one flow can never be
 * redeemed by another, the same rule `verifyChallenge` enforces for outbound
 * codes. `user` and `phone` narrow it further where the caller has already
 * established what the token must belong to — keeping the check inside the same
 * atomic update as the spend, so nothing can change between the two.
 */
async function consumeVerified(token, { purpose, user, phone } = {}) {
  return ReverseOtpChallenge.findOneAndUpdate(
    redeemableFilter({ token, purpose, user, phone }),
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' }
  );
}

module.exports = {
  issueChallenge,
  matchInbound,
  getStatus,
  findRedeemable,
  consumeVerified,
  availableChannels,
  anyChannelConfigured,
  normalizePhone,
  maskPhone,
};
