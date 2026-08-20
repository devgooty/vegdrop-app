/**
 * Developer Console & Database Administration Service
 *
 * All endpoints require the `developer` role. Authorised server-side.
 */

import { api } from './apiClient';

/**
 * Fetch top-level KPIs, 7-day and 30-day revenue trends, and recent orders/users.
 */
export async function fetchDeveloperOverview() {
  const result = await api.get('/developer/overview');
  return result.data;
}

/**
 * Fetch live MongoDB database connection status, collection document counts, and memory/uptime diagnostics.
 */
export async function fetchDatabaseStatus() {
  const result = await api.get('/developer/db-status');
  return result.data;
}

/**
 * Fetch daily active registrations and role distribution over a time window (e.g. 7 or 30 days).
 */
export async function fetchUsageAnalytics(days = 7) {
  const result = await api.get(`/developer/usage-analytics?days=${days}`);
  return result.data;
}

/**
 * Fetch live system alerts (pending KYC, pending stall requests, low stock, unassigned orders).
 */
export async function fetchSystemAlerts() {
  const result = await api.get('/developer/alerts');
  return result.data;
}

/**
 * Fetch list of shopkeepers with their stall details, products count, and KYC state.
 */
export async function fetchShopkeeperAnalytics() {
  const result = await api.get('/developer/shopkeepers');
  return result.data;
}

/**
 * Fetch list of delivery partners with on-duty status, deliveries count, and bank status.
 */
export async function fetchDeliveryAnalytics() {
  const result = await api.get('/developer/riders');
  return result.data;
}

/**
 * Fetch wallet transactions and payout ledger summary.
 */
export async function fetchPaymentLedger() {
  const result = await api.get('/developer/payments');
  return result.data;
}

/**
 * Fetch full database collections snapshot for debugging and inspection.
 */
export async function fetchSystemDump() {
  const result = await api.get('/developer/dump');
  return result.data;
}
