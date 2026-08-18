'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const OtpChallenge = require('../models/OtpChallenge');
const { ApiError } = require('../middleware/errors');
const notify = require('./notify');

/**
 * One-time verification codes.
 *
 * Replaces a hardcoded `123456` that was compared in the browser. Properties:
 *
 *  - Codes come from crypto.randomInt, not Math.random.
 *  - Only an HMAC of the code is persisted, keyed by a server-side pepper, so a
 *    database dump does not yield usable codes.
 *  - The HMAC covers the challenge id too, so a code captured for one challenge
 *    cannot be replayed against another.
 *  - Attempts are counted atomically and the challenge dies at the cap.
 *  - Verification is the only place the comparison happens, and it is
 *    constant-time.
 */

function generateCode(length) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

function hashCode(challengeId, code) {
  return crypto
    .createHmac('sha256', config.otp.pepper)
    .update(`${challengeId}:${code}`)
    .digest('hex');
}

/**
 * Always 'sms'. An OTP has exactly one kind of destination now — a phone.
 *
 * Kept as a function rather than inlined because `OtpChallenge.channel` is a
 * stored enum that still has an `email` member for rows written before login
 * codes stopped being copied to a mailbox.
 */
function channelFor() {
  return 'sms';
}

/**
 * Issue a challenge and dispatch the code.
 *
 * @returns {Promise<{ challengeId: string, channel: string, destination: string, expiresAt: Date, devCode?: string }>}
 */
async function issueChallenge({ purpose, destination, user = null, payload = null }) {
  const normalized = String(destination).trim().toLowerCase();
  const channel = channelFor(normalized);

  /**
   * Scoped by account too, when one is known.
   *
   * One phone or email can now back several accounts — a customer, a
   * shopkeeper, a delivery agent, each a separate User document sharing a
   * contact (see models/User.js). All three sign in through the SAME `login`
   * purpose, to the SAME destination. Without this, requesting a login code
   * for one account would set the cooldown and then supersede — invalidate —
   * a still-pending code for a DIFFERENT account that merely happens to share
   * an email, purely because both queries matched on `(destination, purpose)`
   * alone. That is not a security hole — `verifyChallenge` still checks the
   * exact `challengeId`, which is account-specific from the moment it is
   * minted — but it would make switching between one's own apps back to back
   * feel randomly broken.
   *
   * `null` when no account is known yet (registration, or a login attempt for
   * an identifier with no match at all), which is exactly when the OLD
   * destination-only scoping is still the right one: there is no account to
   * scope to, and the invariant being protected — one live code per
   * destination per purpose — is about the destination itself.
   */
  const accountScope = user ? { user: user._id } : {};

  // Cooldown: block rapid re-issue for the same destination, purpose and
  // (when known) account.
  const recent = await OtpChallenge.findOne({
    destination: normalized,
    purpose,
    ...accountScope,
    consumedAt: null,
    lastSentAt: { $gt: new Date(Date.now() - config.otp.resendCooldownSeconds * 1000) },
  }).lean();

  if (recent) {
    throw new ApiError(
      429,
      `Please wait ${config.otp.resendCooldownSeconds} seconds before requesting another code.`,
      'OTP_COOLDOWN'
    );
  }

  const challengeId = crypto.randomUUID();
  const code = generateCode(config.otp.length);
  const expiresAt = new Date(Date.now() + config.otp.ttlSeconds * 1000);

  // Persisted before dispatch so that `lastSentAt` arms the cooldown above and
  // two near-simultaneous requests cannot each send a message.
  const created = await OtpChallenge.create({
    challengeId,
    purpose,
    destination: normalized,
    channel,
    codeHash: hashCode(challengeId, code),
    user: user ? user._id : null,
    payload,
    maxAttempts: config.otp.maxAttempts,
    expiresAt,
    lastSentAt: new Date(),
  });

  /**
   * Deliver first, and only retire the previous code once delivery succeeded.
   *
   * Superseding up front meant a transport failure destroyed a code the user
   * could still have used, and left `lastSentAt` set so the cooldown blocked
   * them from requesting another — locked out of a passwordless system by an
   * error on our side. Rolling the row back on failure restores both: the older
   * challenge stays live, and nothing is counted as sent.
   */
  try {
    await notify.sendOtp({
      channel,
      to: normalized,
      code,
      purpose,
      ttlSeconds: config.otp.ttlSeconds,
      role: user?.role,
      name: user?.name,
    });
  } catch (err) {
    await OtpChallenge.deleteOne({ _id: created._id }).catch(() => {});
    throw err;
  }

  // Exactly one live code per destination, purpose and (when known) account,
  // from here on — same scoping as the cooldown check above, and for the same
  // reason: a code for one account sharing this destination must not retire a
  // still-valid code for another.
  await OtpChallenge.updateMany(
    { destination: normalized, purpose, ...accountScope, consumedAt: null, _id: { $ne: created._id } },
    { $set: { consumedAt: new Date() } }
  );

  /**
   * There are no secondary copies of a code any more.
   *
   * A verified email used to receive one. That made account security the weaker
   * of the two channels — whoever read the mailbox could sign in — and it was
   * insurance against a phone the transport could not reach. Reverse OTP covers
   * that case properly, by proving the number instead of routing around it.
   */

  const result = { challengeId, channel, destination: maskDestination(normalized), expiresAt };

  // Returned only under test so suites can complete the flow without a mailbox.
  // Never populated in development or production responses.
  if (config.isTest) result.devCode = code;

  return result;
}

/**
 * Verify a submitted code and consume the challenge.
 *
 * @returns {Promise<import('../models/OtpChallenge')>} the consumed challenge
 * @throws {ApiError} 400/410/429 on invalid, expired, or exhausted challenges
 */
async function verifyChallenge({ challengeId, code, purpose }) {
  const challenge = await OtpChallenge.findOne({ challengeId, purpose });

  // Uniform error for unknown vs. consumed: do not leak whether an id was real.
  if (!challenge || challenge.consumedAt) {
    throw new ApiError(400, 'This verification code is no longer valid. Request a new one.', 'OTP_INVALID');
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(410, 'This verification code has expired. Request a new one.', 'OTP_EXPIRED');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await OtpChallenge.updateOne({ _id: challenge._id }, { $set: { consumedAt: new Date() } });
    throw new ApiError(429, 'Too many incorrect attempts. Request a new code.', 'OTP_ATTEMPTS_EXCEEDED');
  }

  // Count the attempt before comparing, so a crash mid-verify cannot yield a
  // free guess, and concurrent guesses cannot race past the cap.
  const bumped = await OtpChallenge.findOneAndUpdate(
    { _id: challenge._id, attempts: { $lt: challenge.maxAttempts }, consumedAt: null },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  );

  if (!bumped) {
    throw new ApiError(429, 'Too many incorrect attempts. Request a new code.', 'OTP_ATTEMPTS_EXCEEDED');
  }

  const expected = Buffer.from(bumped.codeHash, 'hex');
  const actual = Buffer.from(hashCode(challengeId, String(code)), 'hex');
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    const remaining = Math.max(0, bumped.maxAttempts - bumped.attempts);
    throw new ApiError(
      400,
      remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Incorrect code. Request a new one.',
      'OTP_INVALID'
    );
  }

  // Single-use: mark consumed only on success, guarded so a concurrent duplicate
  // submission of the same correct code cannot both win.
  const consumed = await OtpChallenge.findOneAndUpdate(
    { _id: bumped._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' }
  );

  if (!consumed) {
    throw new ApiError(400, 'This verification code has already been used.', 'OTP_INVALID');
  }

  return consumed;
}

/** j***@example.com / ******3210 — enough to identify, not enough to enumerate. */
function maskDestination(destination) {
  if (destination.includes('@')) {
    const [local, domain] = destination.split('@');
    const head = local.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
  }
  return `${'*'.repeat(Math.max(0, destination.length - 4))}${destination.slice(-4)}`;
}

module.exports = { issueChallenge, verifyChallenge, maskDestination };
