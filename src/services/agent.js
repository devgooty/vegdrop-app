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

/**
 * What one spoken sentence meant, when the offline keyword table could not
 * tell.
 *
 * The table in `lib/voiceCommands.js` is still tried first, because it answers
 * instantly and with no connection. This is the fallback for the phrasings it
 * does not cover — and it returns a NAME, never an action: the app runs the
 * same handler a tap runs, under the mode the shopper chose.
 *
 * @param {{utterance: string, language?: string, screen?: object}} payload
 * @returns {Promise<{intent: string, target?: string, items?: Array<{name: string, quantity: number}>, reply: string}>}
 */
export async function classifySpokenCommand({ utterance, language, screen }) {
  const body = { utterance };
  if (language) body.language = language;
  if (screen) body.screen = screen;
  const result = await api.post('/agent/voice', body);
  return result.data;
}
