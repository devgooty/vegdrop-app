'use strict';

const crypto = require('crypto');
const PhoneHandoverSession = require('../models/PhoneHandoverSession');
const ReverseOtpChallenge = require('../models/ReverseOtpChallenge');
const reverseOtp = require('./reverseOtp');
const { messageFor, channelsForCode } = require('./reverseOtpChannels');
const { ApiError } = require('../middleware/errors');

/** Shorter than reverse-OTP TTL on purpose — pairing should finish quickly. */
const HANDOVER_TTL_SECONDS = 300;
const MAX_PAIR_ATTEMPTS = 3;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenMatches(presented, storedHash) {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(String(storedHash), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Uniform over 0000–9999. Leading zeros are real codes. */
function generatePairNumber() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateOpaqueToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isExpired(session) {
  return !session || !session.expiresAt || session.expiresAt.getTime() <= Date.now();
}

function expiresInSeconds(expiresAt) {
  return Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
}

function publicState(session) {
  if (!session) return 'expired';
  if (session.state === 'failed') return 'failed';
  if (isExpired(session)) return 'expired';
  return session.state;
}

function pairNumbersMatch(presented, expected) {
  const a = String(presented || '').trim();
  const b = String(expected || '');
  if (!b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function challengeView(session, { token, code, expiresAt, alreadyPaired }) {
  return {
    alreadyPaired,
    token,
    code,
    expiresAt,
    phone: session.phone,
    purpose: session.purpose,
    app: session.app,
  };
}

/**
 * Start a handover bound to a phone. No reverse code yet — that waits for pair.
 */
async function startSession({ phone, purpose, app = null, user = null, payload = null }) {
  if (!reverseOtp.anyChannelConfigured()) {
    throw new ApiError(
      503,
      'This verification method is not available right now.',
      'REVERSE_OTP_NOT_CONFIGURED'
    );
  }

  const sessionId = generateSessionId();
  const claimToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + HANDOVER_TTL_SECONDS * 1000);

  await PhoneHandoverSession.create({
    sessionId,
    claimHash: hashToken(claimToken),
    phone: reverseOtp.normalizePhone(phone),
    purpose,
    app,
    user: user?._id ?? user ?? null,
    payload,
    state: 'pending',
    expiresAt,
  });

  return {
    sessionId,
    claimToken,
    expiresAt,
    expiresInSeconds: HANDOVER_TTL_SECONDS,
  };
}

/**
 * First open of the helper wins. Returns a pair number and phoneToken — never
 * a reverse code.
 */
async function scanSession(sessionId) {
  const phoneToken = generateOpaqueToken();
  const pairNumber = generatePairNumber();

  const updated = await PhoneHandoverSession.findOneAndUpdate(
    {
      sessionId,
      state: 'pending',
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        state: 'scanned',
        phoneHash: hashToken(phoneToken),
        pairNumber,
        scannedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  if (updated) {
    return {
      phoneToken,
      pairNumber,
      expiresAt: updated.expiresAt,
      expiresInSeconds: expiresInSeconds(updated.expiresAt),
    };
  }

  const existing = await PhoneHandoverSession.findOne({ sessionId }).lean();
  if (!existing || isExpired(existing)) {
    throw new ApiError(404, 'This sign-in has expired. Refresh on your computer.', 'HANDOVER_EXPIRED');
  }
  throw new ApiError(
    409,
    'This sign-in code has already been used. Refresh on your computer.',
    'HANDOVER_ALREADY_SCANNED'
  );
}

/**
 * Browser confirms the pair number. Claim token is checked BEFORE digits so a
 * wrong-token probe cannot learn whether a guess was right.
 *
 * Only on success is a ReverseOtpChallenge minted.
 */
async function pairSession({ sessionId, claimToken, pairNumber, issueChallenge }) {
  const session = await PhoneHandoverSession.findOne({ sessionId });
  if (!session || isExpired(session) || session.state === 'failed') {
    throw new ApiError(404, 'This sign-in has expired. Refresh and try again.', 'HANDOVER_EXPIRED');
  }

  // Claim first — never reveal pair digit correctness to an unauthenticated caller.
  if (!tokenMatches(claimToken, session.claimHash)) {
    throw new ApiError(403, 'This sign-in does not belong to this browser.', 'HANDOVER_FORBIDDEN');
  }

  if (session.state === 'paired' && session.reverseToken) {
    // Idempotent re-pair after a dropped response: hand back the same challenge.
    const existing = await ReverseOtpChallenge.findOne({ token: session.reverseToken })
      .select('expiresAt')
      .lean();
    return challengeView(session, {
      alreadyPaired: true,
      token: session.reverseToken,
      code: session.reverseCode,
      expiresAt: existing?.expiresAt || session.expiresAt,
    });
  }

  if (session.state !== 'scanned') {
    throw new ApiError(409, 'Open the link on your phone first.', 'HANDOVER_NOT_SCANNED');
  }

  if (!pairNumbersMatch(pairNumber, session.pairNumber)) {
    const attempts = (session.pairAttempts || 0) + 1;
    session.pairAttempts = attempts;
    if (attempts >= MAX_PAIR_ATTEMPTS) {
      session.state = 'failed';
      session.pairNumber = null;
      await session.save();
      throw new ApiError(
        429,
        'Too many wrong numbers. Refresh and try again.',
        'HANDOVER_PAIR_LOCKED'
      );
    }
    await session.save();
    throw new ApiError(400, 'That number does not match.', 'HANDOVER_PAIR_MISMATCH', {
      attemptsLeft: MAX_PAIR_ATTEMPTS - attempts,
    });
  }

  const user = session.user ? { _id: session.user } : null;
  const challenge = await issueChallenge({
    purpose: session.purpose,
    phone: session.phone,
    app: session.app,
    user,
    payload: session.payload,
  });

  const claimed = await PhoneHandoverSession.findOneAndUpdate(
    {
      sessionId,
      state: 'scanned',
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        state: 'paired',
        reverseToken: challenge.token,
        reverseCode: challenge.code,
        pairedAt: new Date(),
        pairNumber: null,
      },
    },
    { returnDocument: 'after' }
  );

  if (!claimed) {
    // Lost the race or expired between checks — reverse challenge may exist but
    // is harmless (bound to this phone); the client retries pair or starts over.
    throw new ApiError(409, 'Could not confirm that number. Try again.', 'HANDOVER_PAIR_RACE');
  }

  return challengeView(session, {
    alreadyPaired: false,
    token: challenge.token,
    code: challenge.code,
    expiresAt: challenge.expiresAt,
  });
}

/** Browser poll: claim token required. Never returns the pair number. */
async function browserStatus({ sessionId, claimToken }) {
  const session = await PhoneHandoverSession.findOne({ sessionId }).lean();
  if (!session || isExpired(session)) {
    return { state: 'expired' };
  }
  if (!tokenMatches(claimToken, session.claimHash)) {
    throw new ApiError(403, 'This sign-in does not belong to this browser.', 'HANDOVER_FORBIDDEN');
  }
  if (session.state === 'failed') {
    return { state: 'failed' };
  }
  return {
    state: session.state,
    pairNumberNeeded: session.state === 'scanned',
    expiresAt: session.expiresAt,
  };
}

/**
 * Phone poll: after pair, returns the reverse message + channel links.
 * Before pair, only the session state (and pair number while scanned).
 */
async function phoneStatus({ sessionId, phoneToken }) {
  const session = await PhoneHandoverSession.findOne({ sessionId }).lean();
  if (!session || isExpired(session)) {
    return { state: 'expired' };
  }
  if (!tokenMatches(phoneToken, session.phoneHash)) {
    throw new ApiError(403, 'This sign-in does not belong to this phone.', 'HANDOVER_FORBIDDEN');
  }
  if (session.state === 'failed') {
    return { state: 'failed' };
  }
  if (session.state === 'scanned') {
    return {
      state: 'scanned',
      pairNumber: session.pairNumber,
      expiresAt: session.expiresAt,
    };
  }
  if (session.state === 'paired' && session.reverseCode) {
    return {
      state: 'paired',
      code: session.reverseCode,
      message: messageFor(session.reverseCode),
      channels: await channelsForCode(session.reverseCode),
      expiresAt: session.expiresAt,
    };
  }
  return { state: publicState(session) };
}

module.exports = {
  HANDOVER_TTL_SECONDS,
  MAX_PAIR_ATTEMPTS,
  startSession,
  scanSession,
  pairSession,
  browserStatus,
  phoneStatus,
};
