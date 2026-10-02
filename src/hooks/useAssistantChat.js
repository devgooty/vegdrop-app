import { useSyncExternalStore } from 'react';

/**
 * The cooking-assistant conversation, kept outside the component that shows it.
 *
 * `CookingAssistant` is unmounted whenever another bottom-nav tab is showing,
 * and it used to hold the conversation in its own state — so opening Cart to
 * check a price and coming back wiped the whole chat. It lives here instead,
 * and ends only when the customer closes the app or stops being the person
 * signed in.
 *
 * Two layers, for the two ways a page goes away without the customer leaving:
 *
 *  - a module variable carries it across tab switches;
 *  - sessionStorage carries it across a reload, including the one a phone does
 *    by itself when it discards a backgrounded tab — which, to the customer, is
 *    not closing anything. sessionStorage belongs to one tab and is discarded
 *    when that tab or the installed app is closed, which is exactly the lifetime
 *    wanted. localStorage would outlive it, and must not be used here.
 *
 * Web storage is kept away from credentials in this codebase (`apiClient.js`),
 * and nothing here is one: a `proposalId` only redeems for the account that
 * created it (`takeProposal` is scoped to the caller) and expires in ten
 * minutes. What is personal is the conversation itself, so it is stamped with
 * the account it belongs to, never rendered for any other, and cleared by
 * `App.jsx` `onIdentityLost` on sign-out or an account swap.
 */

const STORAGE_KEY = 'vegdrop_assistant_chat';

/** `POST /api/agent/chat` refuses a longer history — see `routes/agent.js`. */
export const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 4000;

/** Bounds what is written to storage; the server only ever sees the tail. */
const MAX_KEPT_MESSAGES = 100;

/** Server-side proposal lifetime, used when a preview does not state its own. */
const DEFAULT_PROPOSAL_MINUTES = 10;

export const GREETING = Object.freeze({
  role: 'assistant',
  content:
    "Hi! Name a dish — gutti vankaya, aloo gobi, palak paneer — or tell me the vegetables you have. I'll give you a tested recipe and can put the vegetables in your cart.",
});

/**
 * Shown to anyone the stored chat does not belong to. One reference, so snapshots stay stable.
 *
 * `busy` lives here rather than in the component so that leaving mid-reply and
 * coming back still shows "Thinking…" and still blocks a second send. It is
 * never written to storage: a reload abandons the request, and a restored
 * `busy: true` would lock the input for good.
 */
const BLANK = Object.freeze({ userId: null, messages: Object.freeze([GREETING]), proposedOrder: null, busy: false });

const listeners = new Set();
let state = load();

/** Reading `sessionStorage` itself throws when the browser blocks site data. */
function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isMessage(m) {
  return (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string';
}

/** A preview whose proposal the server has already forgotten cannot be confirmed. */
export function liveProposal(proposal, now = Date.now()) {
  return proposal && typeof proposal.expiresAt === 'number' && proposal.expiresAt > now ? proposal : null;
}

function load() {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return BLANK;
    const saved = JSON.parse(raw);
    const messages = Array.isArray(saved?.messages) ? saved.messages.filter(isMessage) : [];
    if (typeof saved?.userId !== 'string' || messages.length === 0) return BLANK;
    return { userId: saved.userId, messages, proposedOrder: liveProposal(saved.proposedOrder), busy: false };
  } catch {
    return BLANK;
  }
}

function persist() {
  const store = storage();
  if (!store) return;
  try {
    if (state.userId) {
      const { userId, messages, proposedOrder } = state;
      store.setItem(STORAGE_KEY, JSON.stringify({ userId, messages, proposedOrder }));
    } else {
      store.removeItem(STORAGE_KEY);
    }
  } catch {
    // Quota or blocked storage. The module copy still covers tab switches.
  }
}

function commit(next) {
  state = next;
  persist();
  for (const listener of listeners) listener();
}

/**
 * Change the conversation belonging to `userId`.
 *
 * `claim` decides what happens when the store belongs to nobody or to someone
 * else. Pass it only for a change the customer is making right now — a message
 * typed, a button tapped — which starts their conversation afresh. Leave it off
 * for anything that lands later, like a reply: if the customer signed out while
 * it was in flight, the store has been cleared, and writing the reply would put
 * the old account's conversation back into a tab someone else may now be using.
 */
export function updateAssistantChat(userId, change, { claim = false } = {}) {
  if (!userId) return;
  const id = String(userId);

  let base = state;
  if (state.userId !== id) {
    if (!claim) return;
    base = { userId: id, messages: [GREETING], proposedOrder: null, busy: false };
  }

  const next = { ...base, ...change(base), userId: id };
  if (next.messages.length > MAX_KEPT_MESSAGES) {
    next.messages = next.messages.slice(-MAX_KEPT_MESSAGES);
  }
  if (next.proposedOrder && typeof next.proposedOrder.expiresAt !== 'number') {
    const minutes = Number(next.proposedOrder.expiresInMinutes) || DEFAULT_PROPOSAL_MINUTES;
    next.proposedOrder = { ...next.proposedOrder, expiresAt: Date.now() + minutes * 60 * 1000 };
  }
  commit(next);
}

export function clearAssistantChat() {
  if (state !== BLANK) commit(BLANK);
}

/**
 * The part of the conversation the server is sent.
 *
 * The whole history used to go up, and `routes/agent.js` caps it at 24
 * messages — so the thirteenth question in one conversation failed with a 400.
 * That took a long session before; a conversation that survives page changes
 * reaches it routinely.
 */
export function historyForServer(messages) {
  return messages
    .filter((m) => isMessage(m) && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

/** The conversation for `userId`, or a fresh one if the stored chat is not theirs. */
export default function useAssistantChat(userId) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return userId && snapshot.userId === String(userId) ? snapshot : BLANK;
}
