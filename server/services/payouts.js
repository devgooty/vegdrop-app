'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const { ApiError } = require('../middleware/errors');

/**
 * Outbound money movement, used only for vendor KYC penny drops.
 *
 * This talks to RazorpayX, which is a separate product from the Razorpay
 * Payments integration in routes/wallet.js. Payments credentials collect money;
 * they cannot send it. Supplying only RAZORPAY_KEY_ID here would fail at the
 * provider with an authorization error, so the two credential sets are kept
 * distinct in config and checked separately.
 *
 * Every provider failure surfaces as a 502. Per the rule in middleware/errors.js,
 * an upstream 4xx must never be re-thrown with its own status: RazorpayX
 * rejecting *our* request is an integration fault on our side, and reporting it
 * as a 400 would tell the vendor they typed something wrong when they did not.
 */

const API_BASE = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

function authHeader() {
  const token = Buffer.from(`${config.payouts.keyId}:${config.payouts.keySecret}`).toString('base64');
  return `Basic ${token}`;
}

async function callProvider(path, { method = 'POST', body, idempotencyKey } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        // RazorpayX dedupes on this, so a retried payout cannot send twice.
        ...(idempotencyKey ? { 'X-Payout-Idempotency': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(
      502,
      'Could not reach the verification provider. Please try again in a moment.',
      'PAYOUT_PROVIDER_UNREACHABLE'
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Logged in full for operators; the caller sees only a generic message.
    console.error('[payouts] provider rejected request', {
      path,
      status: response.status,
      code: payload?.error?.code,
      description: payload?.error?.description,
    });
    throw new ApiError(
      502,
      'The verification provider rejected the request. Please try again later.',
      'PAYOUT_PROVIDER_ERROR'
    );
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Unavailable provider (production, unconfigured)
// ---------------------------------------------------------------------------

/**
 * RazorpayX is unconfigured and this is production: refuse the one call that
 * needs it rather than fake a bank-account verification. config/env.js no
 * longer holds the whole app hostage to this — checkout works regardless —
 * but a real vendor must never be told their bank account passed a check that
 * never ran against a real bank.
 */
const unavailable = {
  async validateVpa() {
    throw new ApiError(503, 'Vendor verification is not available right now.', 'PAYOUT_PROVIDER_UNCONFIGURED');
  },
  async sendPennyDrop() {
    throw new ApiError(503, 'Vendor verification is not available right now.', 'PAYOUT_PROVIDER_UNCONFIGURED');
  },
};

// ---------------------------------------------------------------------------
// Mock provider (development only)
// ---------------------------------------------------------------------------

/**
 * Simulates the provider so the whole KYC flow is exercisable without RazorpayX
 * credentials. Never selected in production — see `provider` below.
 */
const mock = {
  async validateVpa(vpa) {
    // Reject a shape the real API would also reject, so the mock does not make
    // broken input look valid during development.
    if (!/^[\w.\-]{2,60}@[a-zA-Z]{2,30}$/.test(vpa)) {
      return { valid: false, beneficiaryName: null };
    }
    return { valid: true, beneficiaryName: null };
  },

  async sendPennyDrop({ vpa, amountPaise, referenceId }) {
    console.warn(
      `[payouts] MOCK penny drop: ${amountPaise} paise -> ${vpa} (ref ${referenceId}). ` +
        'No money moved. Set RAZORPAYX_* credentials for real transfers.'
    );
    return { providerRef: `mock_payout_${crypto.randomUUID()}`, status: 'processed', utr: null };
  },
};

// ---------------------------------------------------------------------------
// RazorpayX provider
// ---------------------------------------------------------------------------

const razorpayx = {
  /** Confirms the VPA is registered and returns the name the bank has on file. */
  async validateVpa(vpa) {
    const result = await callProvider('/payments/validate/vpa', { body: { vpa } });
    return {
      valid: Boolean(result?.success),
      beneficiaryName: result?.customer_name || null,
    };
  },

  /**
   * Contact -> fund account -> payout. RazorpayX has no single-call transfer to
   * a raw VPA; the fund account is the addressable entity.
   */
  async sendPennyDrop({ vpa, amountPaise, referenceId, contactName, contactPhone }) {
    const contact = await callProvider('/contacts', {
      body: { name: contactName, contact: contactPhone, type: 'vendor', reference_id: referenceId },
    });

    const fundAccount = await callProvider('/fund_accounts', {
      body: { contact_id: contact.id, account_type: 'vpa', vpa: { address: vpa } },
    });

    const payout = await callProvider('/payouts', {
      idempotencyKey: referenceId,
      body: {
        account_number: config.payouts.accountNumber,
        fund_account_id: fundAccount.id,
        amount: amountPaise,
        currency: 'INR',
        mode: 'UPI',
        purpose: 'payout',
        queue_if_low_balance: false,
        reference_id: referenceId,
        narration: 'VegDrop vendor verification',
      },
    });

    return { providerRef: payout.id, status: payout.status, utr: payout.utr || null };
  },
};

const provider = config.payouts.configured ? razorpayx : config.isProduction ? unavailable : mock;

module.exports = {
  validateVpa: (vpa) => provider.validateVpa(vpa),
  sendPennyDrop: (args) => provider.sendPennyDrop(args),
  isMock: provider === mock,
};
