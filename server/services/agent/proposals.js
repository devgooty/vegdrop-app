'use strict';

const crypto = require('crypto');

/**
 * Short-lived order proposals and per-user chat session hints.
 *
 * Proposals are frozen item lists the confirm step must honour — the model
 * (or local agent) cannot change quantities between propose and place.
 */

const TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, { userId: string, payload: object, expiresAt: number }>} */
const proposals = new Map();

/** @type {Map<string, object>} */
const sessions = new Map();

function prune() {
  const now = Date.now();
  for (const [id, row] of proposals) {
    if (row.expiresAt <= now) proposals.delete(id);
  }
}

function getSession(userId) {
  const key = String(userId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      lastMatches: [],
      lastRecipeId: null,
      lastProposalId: null,
      vegetables: [],
      servings: 2,
    });
  }
  return sessions.get(key);
}

function saveProposal(userId, payload) {
  prune();
  const id = crypto.randomUUID();
  proposals.set(id, {
    userId: String(userId),
    payload,
    expiresAt: Date.now() + TTL_MS,
  });
  const session = getSession(userId);
  session.lastProposalId = id;
  return id;
}

function takeProposal(proposalId, userId) {
  prune();
  const row = proposals.get(String(proposalId));
  if (!row) return null;
  if (row.userId !== String(userId)) return null;
  if (row.expiresAt <= Date.now()) {
    proposals.delete(String(proposalId));
    return null;
  }
  proposals.delete(String(proposalId));
  return row.payload;
}

function peekProposal(proposalId, userId) {
  prune();
  const row = proposals.get(String(proposalId));
  if (!row || row.userId !== String(userId)) return null;
  if (row.expiresAt <= Date.now()) {
    proposals.delete(String(proposalId));
    return null;
  }
  return row.payload;
}

module.exports = {
  getSession,
  saveProposal,
  takeProposal,
  peekProposal,
};
