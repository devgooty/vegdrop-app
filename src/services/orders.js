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
    fulfillmentStatus: order.fulfillment?.status || null,
    sourcingDeadline: order.fulfillment?.sourcingDeadline || null,
    // The moment the stalls committed. Past this the cancel button should go.
    lockedAt: order.fulfillment?.lockedAt || null,
    canCancel: order.market
      ? order.fulfillment?.status === 'sourcing'
      : order.status === 'Pending',
    // How many markets have been tried, so "still looking" can say so honestly.
    sourcingAttempt: order.fulfillment?.attempt || 0,
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
