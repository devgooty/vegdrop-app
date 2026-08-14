/**
 * Vendor KYC.
 *
 * Thin wrappers over the server endpoints. Nothing here decides whether a vendor
 * is verified — `canUpdateStock` is read from the server's answer and the API
 * re-checks it on every catalog write, so hiding the stock controls in the UI is
 * a courtesy, not a security boundary.
 *
 * The full bank account number is write-only from the client's point of view: it
 * is sent once and only ever read back masked.
 */

import { api } from './apiClient';

/**
 * @returns {Promise<{status: string, isVerified: boolean, canUpdateStock: boolean, bankName?: string, bankAccount?: string, upiVpa?: string, pennyDrop?: object}>}
 */
export async function fetchKycStatus() {
  const result = await api.get('/kyc/me');
  return result.data;
}

/**
 * Submit identity and settlement details. Re-submitting replaces them and voids
 * any outstanding verification transfer.
 */
export async function submitKycDetails({ legalName, bankName, bankAccount, ifsc, upiVpa }) {
  const result = await api.post('/kyc/me', { legalName, bankName, bankAccount, ifsc, upiVpa });
  return result.data;
}

/** Ask the server to send the verification transfer to the registered UPI ID. */
export async function requestPennyDrop() {
  const result = await api.post('/kyc/me/penny-drop');
  return result.data;
}

/**
 * Confirm the exact amount received. This is what unlocks catalog writes.
 * @param {number} amountPaise the figure from the vendor's own statement
 */
export async function verifyPennyDrop(amountPaise) {
  const result = await api.post('/kyc/me/penny-drop/verify', { amountPaise });
  return result.data;
}

// --- Client-side format guidance -------------------------------------------
// Advisory only, to give immediate feedback. The server enforces the real rules
// and its answer is the one that counts.

export function describeBankNameProblem(value) {
  if (!value || !value.trim()) return 'Enter your bank name.';
  return null;
}

export function describeIfscProblem(value) {
  if (!value) return 'Enter the IFSC code.';
  if (!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(value.trim())) {
    return 'IFSC must be 4 letters, a zero, then 6 characters (e.g. HDFC0001234).';
  }
  return null;
}

export function describeAccountProblem(value) {
  if (!value) return 'Enter your bank account number.';
  if (!/^\d{9,18}$/.test(value.trim())) return 'Account number must be 9 to 18 digits.';
  return null;
}

export function describeUpiProblem(value) {
  if (!value) return 'Enter your UPI ID.';
  if (!/^[\w.\-]{2,60}@[a-zA-Z]{2,30}$/.test(value.trim())) {
    return 'UPI ID must look like name@bank.';
  }
  return null;
}
