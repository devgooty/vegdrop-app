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
 * @param {{items: Array<{productId: string, quantity: number}>, address: string,
 *          paymentMethod: 'wallet'|'cod'}} payload
 * @returns {Promise<object>} the created order, priced by the server
 * @throws {ApiRequestError} 402 INSUFFICIENT_FUNDS, 409 INSUFFICIENT_STOCK
 */
export async function createOrder({ items, address, paymentMethod }) {
  const result = await api.post('/orders', { items, address, paymentMethod });
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
