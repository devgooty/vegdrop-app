/**
 * Wallet access.
 *
 * The balance is whatever the server's append-only ledger says. Nothing here
 * writes a balance — the previous implementation kept it in localStorage, where
 * it was editable from devtools.
 *
 * Top-up is a three-party handshake: we record an intent, Razorpay collects the
 * money, and the server verifies the payment against the recorded intent before
 * crediting. The browser never states an amount at verification time.
 */

import { api } from './apiClient';

/**
 * What each ledger `reason` is called on screen.
 *
 * The server's enum is a database value, not a sentence. Every panel that
 * rendered a statement line was reaching for a `label` field the API has never
 * sent, so every row drew a blank title — and `timestamp`, `status`, `method`
 * and `refId` were missing in exactly the same way, which is what produced
 * "Invalid Date" under each one.
 */
const REASON_LABELS = {
  razorpay_topup: 'Wallet top-up',
  order_payment: 'Order payment',
  order_refund: 'Refund',
  promotional_credit: 'Promotional credit',
  admin_adjustment: 'Adjustment',
  stall_settlement: 'Payout received',
};

/**
 * One server ledger row → the shape the panels render.
 *
 * Deliberately here rather than in each component: the wallet screen and the
 * developer ledger were drifting from the API independently, and one mapping
 * they both import cannot drift twice.
 *
 * There is no `status`. A WalletTransaction only exists because money actually
 * moved — the ledger is append-only and nothing writes a pending or failed
 * entry — so a status chip on every row could only ever say "Success". The
 * running balance is shown in its place, which is the thing a person reading a
 * statement is actually checking.
 */
export function toUiTransaction(row) {
  const label = REASON_LABELS[row.reason] || 'Transaction';

  return {
    id: row.id,
    type: row.type,
    reason: row.reason,
    amountPaise: row.amountPaise,
    amount: (row.amountPaise ?? 0) / 100,
    balanceAfter: row.balanceAfter ?? 0,
    label,
    /**
     * The order this line came from, when the server recorded one.
     *
     * Dropped when it only restates the label — a top-up's note is literally
     * "Wallet top-up", and rendering both printed the same words twice.
     */
    note: row.note && row.note !== label ? row.note : null,
    createdAt: row.createdAt,
    timestamp: row.createdAt ? new Date(row.createdAt).getTime() : null,
  };
}

/**
 * @returns {Promise<{balance: number, balancePaise: number, transactions: Array}>}
 */
export async function fetchWallet() {
  const result = await api.get('/wallet');
  return {
    ...result.data,
    transactions: (result.data.transactions || []).map(toUiTransaction),
  };
}

/**
 * Record a top-up intent and get the Razorpay order to open checkout with.
 * @param {number} amountRupees
 */
export async function createTopUp(amountRupees) {
  const result = await api.post('/wallet/topup/create', { amount: amountRupees });
  return result.data;
}

/**
 * Hand Razorpay's response back for verification. The amount credited comes
 * from the server's recorded intent, not from anything passed here.
 */
export async function verifyTopUp({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const result = await api.post('/wallet/topup/verify', {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  });
  return result.data;
}

/** Load the Razorpay checkout script once, on demand. */
let razorpayScriptPromise = null;
export function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve(true);
  if (razorpayScriptPromise) return razorpayScriptPromise;

  razorpayScriptPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => {
      razorpayScriptPromise = null;
      resolve(false);
    };
    document.body.appendChild(script);
  });

  return razorpayScriptPromise;
}

/**
 * Android package names for the UPI apps we offer as one-tap options.
 *
 * Razorpay's checkout can open a specific app through a UPI *intent* block, and
 * that is what makes a "PhonePe" button mean PhonePe. Without this the three
 * branded buttons were decoration: the handler took a method argument and
 * ignored it, so every one of them opened the same generic sheet while the UI
 * promised "1-Click".
 *
 * The intent flow only exists on Android. Elsewhere `show_default_blocks` keeps
 * the ordinary payment options visible, so a desktop user is never left with a
 * sheet offering nothing they can use.
 */
const UPI_APPS = {
  PhonePe: 'com.phonepe.app',
  'Google Pay': 'com.google.android.apps.nbu.paisa.user',
  Paytm: 'net.one97.paytm',
};

/** Whether a chosen payment label is one we can open directly. */
export function isUpiApp(method) {
  return Object.hasOwn(UPI_APPS, method);
}

/**
 * Ask checkout to lead with one specific UPI app.
 *
 * Returns undefined for anything unrecognised, which leaves Razorpay's default
 * sheet exactly as it was.
 */
function upiAppConfig(method) {
  const packageName = UPI_APPS[method];
  if (!packageName) return undefined;

  return {
    display: {
      blocks: {
        preferred: {
          name: `Pay using ${method}`,
          instruments: [{ method: 'upi', flows: ['intent'], apps: [packageName] }],
        },
      },
      sequence: ['block.preferred'],
      // Card, netbanking and the other UPI apps stay available underneath.
      preferences: { show_default_blocks: true },
    },
  };
}

/**
 * Run a full top-up: create intent → collect payment → verify → return balance.
 *
 * @param {number} amountRupees
 * @param {{name?: string, email?: string, phone?: string}} [user]
 * @param {{method?: string}} [options] the payment label the customer chose,
 *   e.g. 'PhonePe'. Opens that app directly where the device supports it.
 * @returns {Promise<{balance: number, credited: boolean}>}
 */
export async function topUpWallet(amountRupees, user = {}, { method = null } = {}) {
  const intent = await createTopUp(amountRupees);

  // Development convenience: with no Razorpay credentials configured the server
  // issues a mock intent, so skip checkout and settle directly. The server
  // refuses mock intents in production.
  if (intent.isMock) {
    return verifyTopUp({
      razorpay_order_id: intent.razorpayOrderId,
      razorpay_payment_id: `pay_mock_${Date.now()}`,
      razorpay_signature: 'mock-signature-not-verified-in-development',
    });
  }

  const loaded = await loadRazorpayScript();
  if (!loaded) throw new Error('Could not load the payment provider. Check your connection.');

  const config = upiAppConfig(method);

  const response = await new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: intent.keyId,
      amount: intent.amountPaise,
      currency: intent.currency,
      order_id: intent.razorpayOrderId,
      name: 'VegDrop',
      description: 'Wallet top-up',
      prefill: {
        name: user.name || '',
        email: user.email || '',
        contact: user.phone || '',
        // Opens straight on UPI instead of the method chooser.
        ...(config ? { method: 'upi' } : {}),
      },
      ...(config ? { config } : {}),
      theme: { color: '#1B4D3E' },
      handler: resolve,
      modal: { ondismiss: () => reject(new Error('Payment cancelled.')) },
    });
    checkout.on('payment.failed', (event) =>
      reject(new Error(event?.error?.description || 'Payment failed.'))
    );
    checkout.open();
  });

  /**
   * Verification is retried once, because by this point the money is gone.
   *
   * Razorpay has captured it and this call is the only thing that turns that
   * into a balance from the browser's point of view. A single flaky request
   * used to report "top-up failed" over a payment that had actually succeeded.
   * The webhook now backstops this on the server, but recovering here means the
   * customer sees their balance immediately rather than whenever they next look.
   */
  try {
    return await verifyTopUp(response);
  } catch (err) {
    await new Promise((r) => setTimeout(r, 1200));
    return verifyTopUp(response);
  }
}
