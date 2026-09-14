import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The cooking-assistant conversation has to survive the customer leaving the
 * tab, and must not survive them leaving the account.
 *
 * Each test imports a fresh copy of the module, because the store reads
 * sessionStorage once at load — which is the reload being simulated.
 */

const KEY = 'vegdrop_assistant_chat';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

async function freshModule() {
  vi.resetModules();
  return import('./useAssistantChat');
}

function saved(storage) {
  const raw = storage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

let storage;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('sessionStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAssistantChat store', () => {
  it('keeps the conversation through a reload, without the in-flight flag', async () => {
    const chat = await freshModule();
    chat.updateAssistantChat(
      'u1',
      (prev) => ({ messages: [...prev.messages, { role: 'user', content: 'cabbage fry' }], busy: true }),
      { claim: true }
    );

    expect(saved(storage).messages.at(-1).content).toBe('cabbage fry');
    // A restored `busy: true` would lock the input with no request behind it.
    expect(saved(storage)).not.toHaveProperty('busy');

    // After a reload the reply can still land without claiming the store, which
    // it only may if the conversation was read back in as u1's.
    const reloaded = await freshModule();
    reloaded.updateAssistantChat('u1', (prev) => ({
      messages: [...prev.messages, { role: 'assistant', content: 'Here is cabbage fry' }],
    }));
    expect(saved(storage).messages.map((m) => m.content).slice(1)).toEqual(['cabbage fry', 'Here is cabbage fry']);
  });

  it('drops a reply that lands after the customer signed out', async () => {
    const chat = await freshModule();
    chat.updateAssistantChat('u1', (prev) => ({ messages: [...prev.messages, { role: 'user', content: 'hi' }] }), {
      claim: true,
    });

    chat.clearAssistantChat();
    expect(storage.getItem(KEY)).toBeNull();

    // The request that was in flight resolves now. Without `claim` it must not
    // write the old account's conversation back into the tab.
    chat.updateAssistantChat('u1', (prev) => ({
      messages: [...prev.messages, { role: 'assistant', content: 'secret reply' }],
    }));
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('starts a different account on a clean conversation', async () => {
    const chat = await freshModule();
    chat.updateAssistantChat('u1', (prev) => ({ messages: [...prev.messages, { role: 'user', content: 'mine' }] }), {
      claim: true,
    });

    chat.updateAssistantChat('u2', (prev) => ({ messages: [...prev.messages, { role: 'user', content: 'theirs' }] }), {
      claim: true,
    });

    const contents = saved(storage).messages.map((m) => m.content);
    expect(saved(storage).userId).toBe('u2');
    expect(contents).not.toContain('mine');
    expect(contents.at(-1)).toBe('theirs');
  });

  it('does not restore an order preview the server has already expired', async () => {
    storage.setItem(
      KEY,
      JSON.stringify({
        userId: 'u1',
        messages: [{ role: 'user', content: 'order it' }],
        proposedOrder: { proposalId: 'p1', expiresAt: Date.now() - 1000 },
      })
    );
    const chat = await freshModule();

    // Taking the store without claiming it proves it loaded as u1's, and the
    // write-back shows what survived the load.
    chat.updateAssistantChat('u1', () => ({}));
    expect(saved(storage).messages).toHaveLength(1);
    expect(saved(storage).proposedOrder).toBeNull();
  });

  it('stamps a fresh preview with an expiry', async () => {
    const chat = await freshModule();
    const before = Date.now();
    chat.updateAssistantChat('u1', () => ({ proposedOrder: { proposalId: 'p1', expiresInMinutes: 10 } }), {
      claim: true,
    });

    const { expiresAt } = saved(storage).proposedOrder;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(chat.liveProposal(saved(storage).proposedOrder)).not.toBeNull();
    expect(chat.liveProposal(saved(storage).proposedOrder, expiresAt)).toBeNull();
  });

  it('ignores storage it cannot make sense of', async () => {
    storage.setItem(KEY, '{not json');
    const chat = await freshModule();
    chat.updateAssistantChat('u1', () => ({}));
    // Unclaimed write to a blank store is refused, so nothing was loaded.
    expect(storage.getItem(KEY)).toBe('{not json');
  });

  it('still works when the browser blocks storage', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    });
    const chat = await freshModule();
    expect(() =>
      chat.updateAssistantChat('u1', () => ({ messages: [{ role: 'user', content: 'hi' }] }), { claim: true })
    ).not.toThrow();
  });
});

describe('historyForServer', () => {
  it('sends no more than the server accepts', async () => {
    const { historyForServer, MAX_HISTORY_MESSAGES } = await freshModule();
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `m${i}`,
      cards: [{ type: 'recipe' }],
    }));

    const history = historyForServer(messages);
    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    // The newest messages are the ones kept — the last one is what was just asked.
    expect(history.at(-1).content).toBe('m39');
    // `.strict()` on the route refuses anything but role and content.
    expect(Object.keys(history[0]).sort()).toEqual(['content', 'role']);
  });

  it('trims a message to the per-message cap and skips empty ones', async () => {
    const { historyForServer } = await freshModule();
    const history = historyForServer([
      { role: 'assistant', content: 'x'.repeat(5000) },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'hi' },
    ]);
    expect(history).toHaveLength(2);
    expect(history[0].content).toHaveLength(4000);
  });
});
