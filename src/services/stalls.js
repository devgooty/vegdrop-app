/**
 * The shopkeeper's side: see what has been offered, take what you can fill,
 * bag it for the rider.
 *
 * A stall is never shown the customer — no name, no phone, no address. It is
 * being asked "can you supply 2kg of tomatoes", and that is all these responses
 * carry.
 */

import { api } from './apiClient';

export async function fetchMyStall() {
  const result = await api.get('/stalls/me');
  return result.data;
}

/** Open or close the shutter, switch automatic accepting on or off. */
export async function updateMyStall(changes) {
  const result = await api.patch('/stalls/me', changes);
  return result.data;
}

/**
 * Everything this stall should be looking at right now.
 *
 * `offers` are live in this market with lines still going; `packing` is work
 * already committed to. Poll this on the same 5s cycle the apps already use —
 * a new offer surfaces within five seconds with no push infrastructure at all.
 *
 * @returns {Promise<{offers: Array, packing: Array, stall: object}>}
 */
export async function fetchStallOrders() {
  const result = await api.get('/stalls/me/orders');
  return result.data;
}

/**
 * Take some lines.
 *
 * Partial success is normal — another stall may have taken one of them a moment
 * ago. The response says exactly what was won and what was lost, so the screen
 * can show the truth rather than an optimistic echo of what was tapped.
 *
 * @throws {ApiRequestError} 409 ALREADY_TAKEN, 409 NOT_SOURCING, 409 STALL_CLOSED
 */
export async function claimLines(orderId, lineIds) {
  const result = await api.post(`/stalls/orders/${orderId}/claim`, { lineIds });
  return result.data;
}

/** Bagged. Omit `lineIds` to pack everything this stall holds on the order. */
export async function packOrder(orderId, lineIds) {
  const result = await api.post(`/stalls/orders/${orderId}/pack`, lineIds ? { lineIds } : {});
  return result.data;
}

export async function fetchStallInventory() {
  const result = await api.get('/stalls/me/inventory');
  return result.data;
}

/**
 * Declare what is on the table.
 *
 * This is the only thing auto-accept runs on: a stall answers automatically
 * only where it has declared enough stock for the line. Declaring nothing is
 * fine — the stall simply accepts by hand instead.
 *
 * @param {Array<{productId: string, stock: number}>} items
 */
export async function saveStallInventory(items) {
  const result = await api.put('/stalls/me/inventory', { items });
  return result.data;
}

/**
 * What this stall is owed, what has been paid, and when the rest arrives.
 *
 * Nothing appears here until a customer has actually taken delivery — an order
 * that was accepted, packed, then cancelled pays nothing, because nothing was
 * sold.
 *
 * @returns {Promise<{pendingPaise, releasedPaise, nextReleaseAt, canWithdrawNow,
 *   minEarlyPayoutPaise, holdHours, recent: Array}>}
 */
export async function fetchEarnings() {
  const result = await api.get('/stalls/me/earnings');
  return result.data;
}

/**
 * Take the held money now instead of waiting for it.
 *
 * Releases everything pending, not just the minimum — a partial payout would
 * leave dust that could never be withdrawn again.
 *
 * @throws {ApiRequestError} 409 BELOW_MINIMUM when there is not enough yet
 */
export async function withdrawEarnings() {
  const result = await api.post('/stalls/me/earnings/withdraw');
  return result.data;
}

/** "in about 4 hours" / "in 20 minutes" — for the next automatic payout. */
export function timeUntil(when) {
  if (!when) return null;
  const ms = new Date(when).getTime() - Date.now();
  if (ms <= 0) return 'any moment now';

  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Seconds left on an offer, floored at zero. Drives the countdown on the card. */
export function secondsLeft(deadline) {
  if (!deadline) return 0;
  return Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
}

/**
 * Paise to something a person reads.
 *
 * Grouped Indian-style — ₹1,23,456 rather than ₹123456 — because these numbers
 * are now large enough to need it: a market owner's monthly takings ran
 * together into an unreadable string of digits. Whole rupees drop the paise, so
 * the common case stays short.
 */
export function formatPaise(paise) {
  const rupees = (paise || 0) / 100;
  const fractionDigits = Number.isInteger(rupees) ? 0 : 2;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}
