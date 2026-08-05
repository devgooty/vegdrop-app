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
 * @returns {Promise<{balance: number, balancePaise: number, transactions: Array}>}
 */
export async function fetchWallet() {
  const result = await api.get('/wallet');
  return result.data;
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
 * Run a full top-up: create intent → collect payment → verify → return balance.
 *
 * @param {number} amountRupees
 * @param {{name?: string, email?: string, phone?: string}} [user]
 * @returns {Promise<{balance: number, credited: boolean}>}
 */
export async function topUpWallet(amountRupees, user = {}) {
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

  const response = await new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: intent.keyId,
      amount: intent.amountPaise,
      currency: intent.currency,
      order_id: intent.razorpayOrderId,
      name: 'VegDrop',
      description: 'Wallet top-up',
      prefill: { name: user.name || '', email: user.email || '', contact: user.phone || '' },
      theme: { color: '#1B4D3E' },
      handler: resolve,
      modal: { ondismiss: () => reject(new Error('Payment cancelled.')) },
    });
    checkout.on('payment.failed', (event) =>
      reject(new Error(event?.error?.description || 'Payment failed.'))
    );
    checkout.open();
  });

  return verifyTopUp(response);
}
