'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config/env');
const OrderHandover = require('../models/OrderHandover');

/**
 * Handover codes: issuing, showing, redeeming. See models/OrderHandover.js for
 * what each stage is and why the code lives in its own collection.
 *
 * WHEN A CODE COMES INTO EXISTENCE
 *
 * The first time its holder asks to see it, while the order is in a state where
 * that handover is next - and nowhere else. Not at checkout, not when a stall
 * claims, not on a status write. Three things fall out of that single choice:
 *
 *  - There is one mint site, `showToHolder`, instead of one per transition that
 *    could lead to a handover. A market order can be re-sourced to a different
 *    market (sourcing.js) and a partial can be retried; a code minted eagerly at
 *    claim time would be stale by the time anyone read it.
 *  - Orders already in flight when this shipped need no backfill. The shop,
 *    stall or customer opens their order and the code is there.
 *  - It still fails CLOSED. A rider cannot redeem a code nobody has been shown,
 *    so an order whose holder never looks cannot be completed by the rider -
 *    which is the point of asking the holder in the first place.
 *
 * The unique `{ order, stage, stall }` index is what makes a first read safe to
 * race: two devices opening the same order at once insert one document.
 *
 * WHAT A CODE PROVES, STATED PLAINLY
 *
 * That the holder chose to release the goods to whoever held this rider's
 * session at that moment. It does NOT prove the two were standing together: a
 * shopkeeper can read six digits down a phone, and a customer can text theirs
 * to a rider stuck in traffic. What it buys is that a handover needs BOTH
 * parties to take part - the rider cannot mark goods collected or delivered on
 * their own, and neither can the shop - and `verifiedBy`/`verifiedAt` make a
 * false one attributable. It is not proof of delivery and must not be sold as
 * one.
 */

const { STAGES } = OrderHandover;

function objectId(value) {
  if (value === null || value === undefined) return null;
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
}

function key({ orderId, stage, stallId = null }) {
  if (!STAGES.includes(stage)) throw new Error(`Unknown handover stage: ${stage}`);
  return { order: objectId(orderId), stage, stall: objectId(stallId) };
}

/**
 * Six digits, never one already live on the same order.
 *
 * `crypto.randomInt`, not `Math.random` - the same rule as every guessable
 * secret here. Distinct within an order because the owner asked for different
 * codes for different confirmations, and two identical codes on one screen of
 * one order would read as a bug even though a code from one handover can never
 * be redeemed against another: the lookup is keyed on the handover, not the
 * digits.
 */
function generateCode(avoid = new Set()) {
  for (let i = 0; i < 20; i += 1) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!avoid.has(code)) return code;
  }
  // Twenty collisions against at most a handful of live codes is not bad luck.
  throw new Error('Could not generate a distinct handover code.');
}

async function codesInUse(orderId) {
  const rows = await OrderHandover.find({ order: objectId(orderId), code: { $ne: null } })
    .select('+code')
    .lean();
  return new Set(rows.map((row) => row.code));
}

/**
 * Constant-time comparison. The attempt cap is what actually bounds guessing;
 * this just stops the response time from being a second, uncapped oracle.
 */
function codesMatch(stored, submitted) {
  if (typeof stored !== 'string' || typeof submitted !== 'string') return false;
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(submitted, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * What a holder is shown. Hand-built from named fields rather than serialised,
 * so a field added to the model later cannot reach a client by default.
 */
function view(doc) {
  const max = config.handover.maxAttempts;
  const verified = Boolean(doc.verifiedAt);
  const locked = !verified && Boolean(doc.lockedAt);
  return {
    stage: doc.stage,
    stallId: doc.stall ? String(doc.stall) : null,
    // A spent or locked code is not shown: neither can be redeemed, and
    // displaying one invites reading it out to a rider for nothing.
    code: verified || locked ? null : doc.code,
    verified,
    verifiedAt: doc.verifiedAt || null,
    locked,
    attemptsRemaining: verified ? 0 : Math.max(0, max - (doc.attempts || 0)),
    issuedAt: doc.updatedAt || doc.createdAt || null,
  };
}

/**
 * Show a code to the account that holds it, creating it on first sight.
 *
 * The CALLER decides who the rightful holder is, from the order - `order.shop`,
 * the stall's owner, `order.customer` - and decides whether the order is at the
 * point where this handover is next. This function only guarantees that it
 * never returns a code to anyone but the holder already on record.
 *
 * Returns null when a handover exists but belongs to someone else, which the
 * route reports exactly like a missing order.
 */
async function showToHolder({ orderId, stage, stallId = null, holderId }) {
  const filter = key({ orderId, stage, stallId });
  const holder = objectId(holderId);

  let doc = await OrderHandover.findOne(filter).select('+code');

  if (!doc) {
    const code = generateCode(await codesInUse(orderId));
    try {
      await OrderHandover.updateOne(
        filter,
        { $setOnInsert: { holder, code, attempts: 0, issues: 1, lockedAt: null, verifiedAt: null, verifiedBy: null } },
        { upsert: true }
      );
    } catch (err) {
      // Two first reads raced and the other one inserted. Theirs stands.
      if (err?.code !== 11000) throw err;
    }
    doc = await OrderHandover.findOne(filter).select('+code');
  }

  if (!doc || String(doc.holder) !== String(holder)) return null;
  return view(doc);
}

/**
 * The holder asks for a fresh code - because it locked, or because they think
 * someone overheard it.
 *
 * Only an unredeemed handover can be reissued; a redeemed one has nothing left
 * to protect. Resets the attempt count, because the guesses were against the
 * old digits.
 */
async function reissue({ orderId, stage, stallId = null, holderId }) {
  const filter = key({ orderId, stage, stallId });
  const code = generateCode(await codesInUse(orderId));

  const doc = await OrderHandover.findOneAndUpdate(
    { ...filter, holder: objectId(holderId), verifiedAt: null },
    { $set: { code, attempts: 0, lockedAt: null }, $inc: { issues: 1 } },
    { returnDocument: 'after' }
  ).select('+code');

  return doc ? view(doc) : null;
}

/**
 * A rider submits a code. Counts the attempt BEFORE comparing.
 *
 * The `$inc` is a conditional update guarded on the cap, the same shape as
 * services/otp.js: a crash between counting and comparing cannot yield a free
 * guess, and concurrent guesses cannot race past the cap, because the count
 * and the guard are one operation.
 *
 * This does NOT mark the handover redeemed. The caller moves the order first -
 * its own conditional update is the real transition guard - and only then
 * calls `markRedeemed`. If that order write loses a race, the code is still
 * good and the rider can simply try again.
 *
 * Reasons: CODE_NOT_ISSUED (the holder has never opened it), ALREADY_VERIFIED,
 * CODE_LOCKED, WRONG_CODE. Only WRONG_CODE carries `attemptsRemaining`.
 */
async function redeem({ orderId, stage, stallId = null, code }) {
  const filter = key({ orderId, stage, stallId });
  const max = config.handover.maxAttempts;

  const doc = await OrderHandover.findOneAndUpdate(
    { ...filter, verifiedAt: null, lockedAt: null, code: { $ne: null }, attempts: { $lt: max } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  ).select('+code');

  if (!doc) {
    const existing = await OrderHandover.findOne(filter).select('verifiedAt').lean();
    if (!existing) return { ok: false, reason: 'CODE_NOT_ISSUED' };
    if (existing.verifiedAt) return { ok: false, reason: 'ALREADY_VERIFIED' };
    return { ok: false, reason: 'CODE_LOCKED' };
  }

  if (!codesMatch(doc.code, code)) {
    const attemptsRemaining = Math.max(0, max - doc.attempts);
    if (attemptsRemaining === 0) {
      await OrderHandover.updateOne(
        { _id: doc._id, verifiedAt: null, lockedAt: null },
        { $set: { lockedAt: new Date() } }
      );
      return { ok: false, reason: 'CODE_LOCKED' };
    }
    return { ok: false, reason: 'WRONG_CODE', attemptsRemaining };
  }

  return { ok: true, handoverId: doc._id };
}

/** The order moved. Retire the code so it can never be read back or reused. */
async function markRedeemed({ handoverId, riderId }) {
  await OrderHandover.updateOne(
    { _id: handoverId, verifiedAt: null },
    { $set: { verifiedAt: new Date(), verifiedBy: objectId(riderId), code: null, lockedAt: null } }
  );
}

/**
 * Human-readable text for each refusal, shared by every redeem route so the
 * rider's app says the same thing whichever door they came through.
 */
function refusal(reason, { attemptsRemaining, holder }) {
  switch (reason) {
    case 'WRONG_CODE':
      return {
        status: 400,
        message: `That code doesn't match. Ask the ${holder} to read it again. ${attemptsRemaining} ${
          attemptsRemaining === 1 ? 'try' : 'tries'
        } left.`,
      };
    case 'CODE_LOCKED':
      return {
        status: 409,
        message: `Too many wrong codes. Ask the ${holder} to tap "New code" and read you the new one.`,
      };
    case 'CODE_NOT_ISSUED':
      return {
        status: 409,
        message: `Ask the ${holder} to open this order in their app - the code appears there.`,
      };
    case 'ALREADY_VERIFIED':
      return { status: 409, message: 'This handover has already been confirmed.' };
    default:
      return { status: 409, message: 'This handover cannot be confirmed right now.' };
  }
}

module.exports = {
  STAGES,
  generateCode,
  codesMatch,
  showToHolder,
  reissue,
  redeem,
  markRedeemed,
  refusal,
};
