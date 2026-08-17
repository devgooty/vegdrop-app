/**
 * Order access.
 *
 * Checkout sends only product ids and quantities. Every price, fee, and total is
 * recomputed by the server from the live catalog — the client cannot influence
 * what an order costs, and the returned order is the authoritative record.
 */

import { api } from './apiClient';

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
     * or the pickup code.
     */
    riderAccepted: Boolean(order.riderAcceptedAt),
    // The rider's own code to relay to the shopkeeper. Only ever present in
    // the assigned rider's own view of the order — the server never sends it
    // to anyone else.
    pickupCode: order.pickupCode || null,
    // Set once riderAccepted is true, for whoever is allowed to see it.
    riderName: order.riderName || null,
    riderPhone: order.riderPhone || null,

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

/**
 * The shopkeeper types in what the rider just told them, standing at the
 * counter. The only way an independent-shop order moves to Out for Delivery
 * once a rider has accepted.
 *
 * @throws {ApiRequestError} 400 WRONG_CODE, 409 NOT_ACCEPTED_YET
 */
export async function verifyPickupCode(orderId, code) {
  const result = await api.post(`/orders/${orderId}/verify-pickup`, { code });
  return toUiOrder(result.data);
}
