'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config/env');
const VendorKyc = require('../models/VendorKyc');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { kycLimiter } = require('../middleware/rateLimit');
const fieldCrypto = require('../services/fieldCrypto');
const payouts = require('../services/payouts');

const router = express.Router();

/**
 * Vendor KYC.
 *
 * Proves two separate things before a shopkeeper may list stock:
 *
 *  1. Identity — a PAN, which is also the uniqueness key, so one person cannot
 *     run several vendor accounts.
 *  2. Control of the settlement account — a penny drop. Format validation shows
 *     a UPI ID is well-formed; only receiving money proves the vendor can see
 *     that account.
 *
 * The amount is randomised between 1 and 100 paise and the vendor must report it
 * exactly. A fixed ₹1 with a "did you receive it?" button would verify nothing —
 * anyone could click yes. Requiring the exact figure means passing the check
 * requires reading the statement of the account being registered.
 *
 * The expected amount is stored as a keyed HMAC, never in the clear, for the
 * same reason OTP codes are: a database read must not hand over the answer.
 */

// developer is allowed through for local testing; it never sells anything.
const VENDOR_ROLES = ['shopkeeper', 'developer'];

/** Record-scoped so an amount observed on one KYC cannot be replayed on another. */
function hashAmount(kycId, amountPaise) {
  return fieldCrypto.fingerprint(`penny:${kycId}:${amountPaise}`);
}

/** Names differ in case, punctuation and spacing between PAN and bank records. */
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

async function loadKyc(user) {
  return VendorKyc.findOne({ user: user._id });
}

// ---------------------------------------------------------------------------

/** Current verification state. Safe to poll; returns masked values only. */
router.get('/me', requireAuth, requireRole(VENDOR_ROLES), async (req, res) => {
  const kyc = await loadKyc(req.user);

  if (!kyc) {
    return res.json({
      data: { status: 'missing', isVerified: false, canUpdateStock: false },
    });
  }

  return res.json({
    data: { ...kyc.toPublicJSON(), canUpdateStock: kyc.status === 'verified' },
  });
});

/**
 * Submit or replace identity and settlement details.
 *
 * Re-submitting resets the record to 'draft' and voids any outstanding penny
 * drop — changing the bank account after verification would otherwise leave the
 * account verified against details that no longer apply.
 */
router.post(
  '/me',
  requireAuth,
  requireRole(VENDOR_ROLES),
  kycLimiter,
  validate({
    body: z
      .object({
        legalName: fields.nonEmptyString(120),
        pan: fields.pan,
        bankAccount: fields.bankAccount,
        ifsc: fields.ifsc,
        upiVpa: fields.upiVpa,
        // `status`, `verifiedAt` and the penny-drop fields are absent by design;
        // .strict() turns an attempt to supply one into a 400.
      })
      .strict(),
  }),
  async (req, res) => {
    const { legalName, pan, bankAccount, ifsc, upiVpa } = req.valid.body;

    const existing = await loadKyc(req.user);
    if (existing?.status === 'verified') {
      throw new ApiError(
        409,
        'These details are already verified. Contact support to change your settlement account.',
        'KYC_ALREADY_VERIFIED'
      );
    }

    // Confirm the UPI ID resolves before spending a transfer on it.
    const vpaCheck = await payouts.validateVpa(upiVpa);
    if (!vpaCheck.valid) {
      throw new ApiError(400, 'That UPI ID could not be found. Check it and try again.', 'UPI_NOT_FOUND');
    }

    // When the provider tells us who the account belongs to, it must match the
    // PAN holder. This is what stops a vendor settling into someone else's account.
    if (vpaCheck.beneficiaryName) {
      const declared = normalizeName(legalName);
      const actual = normalizeName(vpaCheck.beneficiaryName);
      if (declared && actual && !actual.includes(declared) && !declared.includes(actual)) {
        throw new ApiError(
          400,
          'The name on that UPI account does not match the name you entered. They must be the same person.',
          'KYC_NAME_MISMATCH'
        );
      }
    }

    const secrets = VendorKyc.buildSecrets({ pan, bankAccount });

    const doc = {
      user: req.user._id,
      legalName,
      ifsc,
      upiVpa,
      upiBeneficiaryName: vpaCheck.beneficiaryName,
      ...secrets,
      status: 'draft',
      // Any previous transfer is void now that the details have changed.
      pennyDrop: {
        amountHash: null,
        referenceId: null,
        providerRef: null,
        utr: null,
        sentAt: null,
        expiresAt: null,
        attempts: 0,
        maxAttempts: config.kyc.pennyMaxAttempts,
      },
      verifiedAt: null,
      rejectedAt: null,
      rejectionReason: null,
    };

    const kyc = await VendorKyc.findOneAndUpdate(
      { user: req.user._id },
      { $set: doc },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).catch((err) => {
      // Unique index on panFingerprint.
      if (err?.code === 11000) {
        throw new ApiError(409, 'That PAN is already registered to another vendor.', 'PAN_ALREADY_USED');
      }
      throw err;
    });

    return res.status(201).json({ data: kyc.toPublicJSON() });
  }
);

/**
 * Send the verification transfer.
 *
 * The amount is generated here and immediately discarded — only its HMAC is
 * persisted, so from this point on nobody, including an operator with database
 * access, can look up the answer.
 */
router.post(
  '/me/penny-drop',
  requireAuth,
  requireRole(VENDOR_ROLES),
  kycLimiter,
  async (req, res) => {
    const kyc = await loadKyc(req.user);

    if (!kyc) {
      throw new ApiError(400, 'Submit your PAN and bank details first.', 'KYC_NOT_SUBMITTED');
    }
    if (kyc.status === 'verified') {
      throw new ApiError(409, 'This account is already verified.', 'KYC_ALREADY_VERIFIED');
    }
    if (kyc.status === 'rejected') {
      throw new ApiError(
        409,
        'Verification was declined for this account. Re-submit your details to try again.',
        'KYC_REJECTED'
      );
    }

    // Do not pay for a second transfer while the first is still live.
    if (kyc.status === 'penny_sent' && kyc.pennyDrop?.expiresAt > new Date()) {
      throw new ApiError(
        429,
        'A verification transfer is already on its way. Check your account, then enter the amount received.',
        'PENNY_DROP_PENDING'
      );
    }

    const { minPennyPaise, maxPennyPaise } = config.kyc;
    // crypto.randomInt, not Math.random: the amount is a secret to be guessed.
    const amountPaise = crypto.randomInt(minPennyPaise, maxPennyPaise + 1);
    const referenceId = `kyc_${kyc._id.toHexString()}_${crypto.randomUUID().slice(0, 8)}`;

    const result = await payouts.sendPennyDrop({
      vpa: kyc.upiVpa,
      amountPaise,
      referenceId,
      contactName: kyc.legalName,
      contactPhone: req.user.phone,
    });

    kyc.status = 'penny_sent';
    kyc.pennyDrop = {
      amountHash: hashAmount(kyc._id.toHexString(), amountPaise),
      referenceId,
      providerRef: result.providerRef,
      utr: result.utr,
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + config.kyc.pennyTtlSeconds * 1000),
      attempts: 0,
      maxAttempts: config.kyc.pennyMaxAttempts,
    };
    await kyc.save();

    const response = { data: kyc.toPublicJSON() };

    // Returned only under test, so suites can complete the flow without a bank
    // account. Never populated in development or production responses — the
    // mock provider logs the amount to the server console instead.
    if (config.isTest) response.devAmountPaise = amountPaise;

    return res.status(202).json(response);
  }
);

/**
 * Confirm the amount received. Success is what unlocks catalog writes.
 */
router.post(
  '/me/penny-drop/verify',
  requireAuth,
  requireRole(VENDOR_ROLES),
  kycLimiter,
  validate({
    body: z
      .object({
        amountPaise: z.number().int().min(1).max(100_000),
      })
      .strict(),
  }),
  async (req, res) => {
    const kyc = await VendorKyc.findOne({ user: req.user._id }).select('+pennyDrop.amountHash');

    if (!kyc || kyc.status !== 'penny_sent') {
      throw new ApiError(400, 'No verification transfer is awaiting confirmation.', 'PENNY_DROP_NOT_SENT');
    }
    if (kyc.pennyDrop.expiresAt <= new Date()) {
      throw new ApiError(410, 'This verification has expired. Request a new transfer.', 'PENNY_DROP_EXPIRED');
    }

    // Count the attempt before comparing, so a crash mid-verify cannot yield a
    // free guess and concurrent guesses cannot race past the cap.
    const bumped = await VendorKyc.findOneAndUpdate(
      {
        _id: kyc._id,
        status: 'penny_sent',
        'pennyDrop.attempts': { $lt: kyc.pennyDrop.maxAttempts },
      },
      { $inc: { 'pennyDrop.attempts': 1 } },
      { new: true }
    ).select('+pennyDrop.amountHash');

    if (!bumped) {
      throw new ApiError(429, 'Too many incorrect attempts. Request a new transfer.', 'PENNY_DROP_ATTEMPTS_EXCEEDED');
    }

    const expected = Buffer.from(bumped.pennyDrop.amountHash, 'hex');
    const actual = Buffer.from(hashAmount(bumped._id.toHexString(), req.valid.body.amountPaise), 'hex');
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

    if (!matches) {
      const remaining = Math.max(0, bumped.pennyDrop.maxAttempts - bumped.pennyDrop.attempts);

      if (remaining === 0) {
        bumped.status = 'rejected';
        bumped.rejectedAt = new Date();
        bumped.rejectionReason = 'Too many incorrect amount confirmations.';
        await bumped.save();
        throw new ApiError(
          429,
          'Too many incorrect attempts. Re-submit your details to try again.',
          'PENNY_DROP_ATTEMPTS_EXCEEDED'
        );
      }

      throw new ApiError(
        400,
        `That amount does not match what we sent. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
        'PENNY_DROP_MISMATCH'
      );
    }

    // Guarded so a duplicated correct submission cannot double-verify.
    const verified = await VendorKyc.findOneAndUpdate(
      { _id: bumped._id, status: 'penny_sent' },
      {
        $set: {
          status: 'verified',
          verifiedAt: new Date(),
          // The answer is no longer needed and should not linger.
          'pennyDrop.amountHash': null,
        },
      },
      { new: true }
    );

    if (!verified) {
      throw new ApiError(409, 'This verification has already been completed.', 'KYC_ALREADY_VERIFIED');
    }

    return res.json({
      data: { ...verified.toPublicJSON(), canUpdateStock: true },
    });
  }
);

module.exports = router;
