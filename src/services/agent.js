/**
 * Cooking / order assistant — customer chat against /api/agent.
 */

import { api } from './apiClient';

/**
 * @param {{messages: Array<{role: string, content: string}>, context?: object}} payload
 * @returns {Promise<{reply: string, cards: array, proposedOrder: object|null}>}
 */
export async function sendAssistantMessage({ messages, context }) {
  const body = { messages };
  if (context) body.context = context;
  const result = await api.post('/agent/chat', body);
  return result.data;
}

/**
 * @param {{proposalId: string, address?: string, lat?: number, lng?: number}} payload
 */
export async function confirmAssistantOrder(payload) {
  const result = await api.post('/agent/confirm-order', payload);
  return result.data;
}
