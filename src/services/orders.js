/**
 * Order access.
 *
 * Checkout sends only product ids and quantities. Every price, fee, and total is
 * recomputed by the server from the live catalog — the client cannot influence
 * what an order costs, and the returned order is the authoritative record.
 */

import { api } from './apiClient';

/**
 * The server's order statuses, in the order an order moves through them.
 *
 * Mirrors `ORDER_STATUSES` in `server/models/Order.js`. It is spelled out here
 * rather than fetched because a filter row has to render before any order has
 * loaded — but it lives in ONE client module, because it did not before: the
 * Developer Console's Orders table carried its own copy reading 'Placed', which
 * has never been a member. That chip filtered to an empty table, and 'Pending',
 * the state every new order is in, had no chip at all.
 */
export const ORDER_STATUSES = [
  'Pending',
  'Preparing',
  'Out for Delivery',
  'Delivered',
  'Cancelled',
];

/**
 * Adapt a server order to the shape the existing panels render.
 * Keeps `totalAmount`/`price` in rupees for display while the wire format
 * stays in integer paise.
 */
export function toUiOrder(order) {
  if (!order) return null;
  return {
    id: order.orderNumber || order.id,
    serverId: order.id,
    customerName: order.customerName,
    phone: order.phone,
    address: order.address,
    deliveryAddress: order.address,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    // Present once a rider has claimed the order; who reads that from here
    // decides what it does with it — see the shopkeeper's rider-location card.
    assignedTo: order.assignedTo || null,

    /**
     * True only once the assigned rider has actively accepted an
     * independent-shop pickup — not merely been picked as nearest. This is
     * what gates the shopkeeper/customer seeing `riderName`/`riderPhone`
     * below, and what tells the delivery app whether to show Accept/Decline
     * or the box for the shop's pickup code.
     */
    riderAccepted: Boolean(order.riderAcceptedAt),
    /**
     * The independent shop this order was placed with. Decides whether there is
     * a pickup code at all: a legacy order has no single shop to hold one.
     *
     * No handover code ever arrives on an order payload - not for the shop, not
     * for the customer, least of all for the rider who types both. Each holder
     * fetches its own with `fetchPickupCode` / `fetchDeliveryCode` below.
     */
    shopId: order.shop ? String(order.shop) : null,
    // Set once riderAccepted is true, for whoever is allowed to see it.
    riderName: order.riderName || null,
    riderPhone: order.riderPhone || null,

    /** Door photo from the rider, when they took one. View-only for customers. */
    deliveryProofUrl: order.deliveryProof?.url || null,
    deliveryProofAt: order.deliveryProof?.takenAt || null,

    /**
     * Market fulfillment, when the order has it.
     *
     * `status` above stays the coarse label every existing screen renders.
     * These carry the detail a customer actually wants while they wait: which
     * market, whether stalls are still deciding, and — the one that changes
     * what the UI offers them — whether it is too late to cancel.
     */
    marketName: order.marketName || null,
    // The independent shop it was placed with, when it was not a market.
    shopName: order.shopName || null,
    // Where to physically go to collect it — only ever present for the rider
    // who accepted the pickup, once they have accepted it. See the customer
    // `address` above for the second leg, after handover.
    shopAddress: order.shopAddress || null,
    shopLat: order.shopLat ?? null,
    shopLng: order.shopLng ?? null,
    shopPhone: order.shopPhone || null,
    fulfillmentStatus: order.fulfillment?.status || null,
    sourcingDeadline: order.fulfillment?.sourcingDeadline || null,
    // The moment the stalls committed. Past this the cancel button should go.
    lockedAt: order.fulfillment?.lockedAt || null,
    canCancel: order.market
      ? ['sourcing', 'partial_review'].includes(order.fulfillment?.status)
      : order.status === 'Pending',
    // How many markets have been tried, so "still looking" can say so honestly.
    sourcingAttempt: order.fulfillment?.attempt || 0,

    /**
     * The market could fill some of this order but not all of it, and is
     * waiting on an answer.
     *
     * `droppedItems` is what would be lost by continuing, and `refundIfAccepted`
     * what would come back — both shown up front, because "continue" is a
     * decision about money and the customer should not have to work it out.
     */
    awaitingPartialChoice: order.fulfillment?.status === 'partial_review',
    partialDeadline: order.fulfillment?.partialDeadline || null,
    unavailableItems: (order.items || [])
      .filter((item) => !item.claim?.stall)
      .map((item) => ({ name: item.name, quantity: item.quantity })),
    availableItems: (order.items || [])
      .filter((item) => item.claim?.stall)
      .map((item) => ({ name: item.name, quantity: item.quantity })),
    /**
     * What continuing would be worth, and whether it comes BACK or is simply
     * never charged.
     *
     * COD has paid nothing yet, so there is no refund — the total drops and
     * less is collected at the door. Saying "₹170 back" there would promise a
     * credit that never arrives, so the two cases are kept apart rather than
     * collapsed into one number.
     */
    unavailableValue:
      (order.items || [])
        .filter((item) => !item.claim?.stall)
        .reduce((sum, item) => sum + (item.lineTotalPaise ?? 0), 0) / 100,
    alreadyPaid: order.paymentStatus === 'paid',
    /** Lines already dropped by an accepted partial, kept for the receipt. */
    droppedItems: (order.fulfillment?.droppedItems || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      refunded: (item.refundedPaise ?? 0) / 100,
    })),
    totalAmount: (order.totalAmountPaise ?? 0) / 100,
    subtotal: (order.subtotalPaise ?? 0) / 100,
    deliveryFee: (order.deliveryFeePaise ?? 0) / 100,
    timestamp: order.createdAt ? new Date(order.createdAt).getTime() : Date.now(),
    time: formatRelativeTime(order.createdAt),
    items: (order.items || []).map((item) => ({
      id: item.product,
      name: item.name,
      quantity: item.quantity,
      price: (item.unitPricePaise ?? 0) / 100,
    })),
  };
}

function formatRelativeTime(iso) {
  if (!iso) return 'Just now';
  const deltaSeconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (deltaSeconds < 60) return 'Just now';
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)} min ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)} hr ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * @param {{status?: string, limit?: number}} [filters]
 * @returns {Promise<Array>} orders scoped to what the caller may see
 */
export async function fetchOrders(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.limit) params.set('limit', String(filters.limit));

  const query = params.toString();
  const result = await api.get(`/orders${query ? `?${query}` : ''}`);
  return result.data.map(toUiOrder);
}

/**
 * The list the caller already has, when the list just fetched is the same one.
 *
 * All three role apps refresh orders on a five-second timer, and `fetchOrders`
 * necessarily returns a brand new array of brand new objects every time. Handed
 * straight to `setOrders` that is a new identity on every tick, so React
 * re-rendered the whole app twelve times a minute to redraw pixel-identical
 * output — measured at ~85ms of main-thread work per poll on the customer app,
 * which is a dropped frame at any refresh rate.
 *
 * That is invisible while the screen is still, and reads as the app lurching
 * when one lands mid-gesture — which is how it was reported: scrolling to the
 * top feeling laggy. The poll is not triggered by scrolling and has nothing to
 * do with the top of the page; it just collides with whatever the thumb is
 * doing, every five seconds, forever.
 *
 * Returning the PREVIOUS array when nothing changed is the whole mechanism.
 * React bails out of the render when a state setter returns the identical
 * reference, so an unchanged poll costs one comparison and no render at all.
 *
 * Compared by serialising rather than by an id/status signature, because an
 * order changes in more ways than a signature would think to look at — rider
 * assignment, partial acceptance, payment state, per-line quantities — and a
 * comparison that misses a real change is a stale screen, which is a far worse
 * bug than the render it saves. At 9 orders / 19KB this measures 0.024ms
 * against the ~85ms it replaces, so there is no reason to be cleverer.
 *
 * Use it for any REPEATING refresh. A one-shot load after a user action can set
 * state directly; it is the timer that makes the waste add up.
 *
 * @param {Array} previous the array currently in state
 * @param {Array} next the array just fetched
 * @returns {Array} `previous` if the two are equivalent, otherwise `next`
 */
export function sameOrdersOrPrevious(previous, next) {
  if (previous === next) return previous;
  if (!Array.isArray(previous) || !Array.isArray(next)) return next;
  if (previous.length !== next.length) return next;
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/**
 * Place an order.
 *
 * `marketId` is optional and decides which of two worlds the order lives in.
 * Without it, nothing changes: one flat catalog, one implicit shop, exactly as
 * before. With it, the order is priced from that market's own sheet and offered
 * to every stall in it — and `lat`/`lng` let the server find the next nearest
 * market if the first one cannot fill it.
 *
 * @param {{items: Array<{productId: string, quantity: number}>, address: string,
 *          paymentMethod: 'wallet'|'cod', marketId?: string, shopId?: string,
 *          lat?: number, lng?: number}} payload
 *   `marketId` and `shopId` are mutually exclusive — an order has one seller,
 *   and the server refuses a request naming both.
 * @returns {Promise<object>} the created order, priced by the server
 * @throws {ApiRequestError} 402 INSUFFICIENT_FUNDS, 409 INSUFFICIENT_STOCK,
 *   409 MARKET_CANNOT_FILL, 400 MARKET_UNAVAILABLE, 400 SHOP_UNAVAILABLE,
 *   409 SHOP_JOINED_MARKET, 400 MIXED_SELLERS
 */
export async function createOrder({ items, address, paymentMethod, marketId, shopId, lat, lng }) {
  const body = { items, address, paymentMethod };
  if (marketId) body.marketId = marketId;
  else if (shopId) body.shopId = shopId;

  /**
   * Sent whenever they are known, not only alongside a market.
   *
   * They were gated behind `marketId`, so a marketless order stored no delivery
   * point at all and the rider had only the address text to work from.
   */
  if (typeof lat === 'number' && typeof lng === 'number') {
    body.lat = lat;
    body.lng = lng;
  }

  const result = await api.post('/orders', body);
  return toUiOrder(result.data);
}

/**
 * Cancel an order.
 *
 * Only possible while stalls are still deciding. Once one has accepted, the
 * produce is set aside and the order locks — the server answers `ORDER_LOCKED`
 * and the button should disappear rather than fail.
 *
 * @throws {ApiRequestError} 409 ORDER_LOCKED
 */
export async function cancelOrder(orderId) {
  const result = await api.patch(`/orders/${orderId}/status`, { status: 'Cancelled' });
  return toUiOrder(result.data);
}

/**
 * Take what the market could supply. The rest is dropped and refunded.
 *
 * Only valid while the order is in `partial_review`. If the decision window
 * lapsed first the server has already done this on the customer's behalf, and
 * this returns 409 — refresh and the order is simply on its way.
 *
 * @throws {ApiRequestError} 409 NOT_PARTIAL
 */
export async function acceptPartialOrder(orderId) {
  const result = await api.post(`/orders/${orderId}/partial/accept`);
  return { ...toUiOrder(result.data), refund: (result.data.refundPaise ?? 0) / 100 };
}

/**
 * Look in another market for the whole order instead.
 *
 * Everything the current market had claimed is handed back, so this genuinely
 * starts over rather than adding to what is already there.
 *
 * @throws {ApiRequestError} 409 NO_MARKET when there is nowhere left to try
 */
export async function retryPartialOrder(orderId) {
  const result = await api.post(`/orders/${orderId}/partial/retry`);
  return toUiOrder(result.data);
}

/** Server enforces both the transition graph and which roles may drive it. */
export async function updateOrderStatus(orderId, status) {
  const result = await api.patch(`/orders/${orderId}/status`, { status });
  return toUiOrder(result.data);
}

/**
 * Assigned rider uploads a door photo. Optional; customers only ever see the URL.
 * @param {string} orderId
 * @param {string} dataUri JPEG/WebP from imageCapture
 */
export async function uploadDeliveryProof(orderId, dataUri) {
  const result = await api.put(`/orders/${orderId}/delivery-proof`, { image: dataUri });
  return result.data;
}

/** Delivery agents claim an unassigned order; first writer wins. */
export async function claimOrder(orderId) {
  const result = await api.post(`/orders/${orderId}/claim`);
  return toUiOrder(result.data);
}

/**
 * The assigned rider's live GPS fix for one order, for the shop (or market
 * office) waiting on them — `null` while unassigned, un-fixed, or stale.
 * @returns {Promise<{lat: number, lng: number, updatedAt: string}|null>}
 */
export async function fetchRiderLocation(orderId) {
  const result = await api.get(`/orders/${orderId}/rider-location`);
  return result.data;
}

// --- Handover codes -----------------------------------------------------------
//
// Two per order, and the RIDER types both: the shop's code at the counter, the
// customer's at the door. So each holder fetches its own code here, on demand,
// and it is never kept anywhere but the component showing it - not on the
// polled order list, and never in web storage.
//
// A code view is `{ code, locked, verified, attemptsRemaining, stage }`. `code`
// is null once the code is used or locked.

/**
 * The code a shop reads out to the rider collecting this order. Available from
 * the moment the shop accepts until the rider collects.
 *
 * @throws {ApiRequestError} 409 CODE_NOT_AVAILABLE outside that window
 */
export async function fetchPickupCode(orderId) {
  const result = await api.get(`/orders/${orderId}/pickup-code`);
  return result.data;
}

/** A fresh pickup code - after it locks, or if the shop thinks it was overheard. */
export async function reissuePickupCode(orderId) {
  const result = await api.post(`/orders/${orderId}/pickup-code/reissue`);
  return result.data;
}

/**
 * The code a customer reads out at the door. Only once the order is on its way.
 *
 * @throws {ApiRequestError} 409 CODE_NOT_AVAILABLE before then
 */
export async function fetchDeliveryCode(orderId) {
  const result = await api.get(`/orders/${orderId}/delivery-code`);
  return result.data;
}

export async function reissueDeliveryCode(orderId) {
  const result = await api.post(`/orders/${orderId}/delivery-code/reissue`);
  return result.data;
}

/**
 * The rider types the code the shop is showing. The only way an independent
 * shop's order leaves `Preparing`.
 *
 * @throws {ApiRequestError} 400 WRONG_CODE (details.attemptsRemaining),
 *   409 CODE_LOCKED, 409 CODE_NOT_ISSUED
 */
export async function verifyPickupCode(orderId, code) {
  const result = await api.post(`/orders/${orderId}/verify-pickup`, { code });
  return toUiOrder(result.data);
}

/**
 * The rider types the code the customer is showing, for an order with no
 * market. A market order is closed with `markDelivered` in services/rider.js.
 *
 * @throws {ApiRequestError} same as `verifyPickupCode`
 */
export async function verifyDeliveryCode(orderId, code) {
  const result = await api.post(`/orders/${orderId}/verify-delivery`, { code });
  return toUiOrder(result.data);
}
