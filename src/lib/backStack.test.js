import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The back button's history, against a fake History that behaves like the
 * real one where it matters: go() lands later, asynchronously, and fires
 * popstate; pushState drops any forward entries.
 *
 * In the Android app the back button is webView.goBack(), which is
 * `history.back()` here — so "user presses back" below is exactly that.
 */

function fakeWindow() {
  const listeners = [];
  const entries = [{ state: null }];
  let index = 0;
  const history = {
    get state() {
      return entries[index].state;
    },
    pushState(state) {
      entries.splice(index + 1);
      entries.push({ state });
      index += 1;
    },
    replaceState(state) {
      entries[index] = { state };
    },
    go(n) {
      const target = Math.max(0, Math.min(entries.length - 1, index + n));
      if (target === index) return;
      setTimeout(() => {
        index = target;
        listeners.forEach((fn) => fn({ state: entries[index].state }));
      }, 1);
    },
    back() {
      this.go(-1);
    },
    forward() {
      this.go(1);
    },
  };
  return {
    history,
    addEventListener: (type, fn) => {
      if (type === 'popstate') listeners.push(fn);
    },
    get index() {
      return index;
    },
    get entries() {
      return entries;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 3));
};

let win;
let stack;

beforeEach(async () => {
  vi.resetModules();
  win = fakeWindow();
  globalThis.window = win;
  stack = await import('./backStack');
});

afterEach(() => {
  delete globalThis.window;
});

describe('tabs', () => {
  it('returns through previously visited bottom-nav tabs before Home', async () => {
    const onPop = vi.fn();
    stack.startBackStack(onPop);

    stack.setTab('prices');
    await settle();
    expect(win.index).toBe(1);

    // Each destination preserves the tab it was opened from.
    stack.setTab('assistant');
    await settle();
    expect(win.index).toBe(2);
    expect(win.history.state.vegdropTab).toBe('assistant');

    win.history.back();
    await settle();
    expect(win.index).toBe(1);
    expect(onPop).toHaveBeenLastCalledWith('prices');

    win.history.back();
    await settle();
    expect(win.index).toBe(0);
    expect(onPop).toHaveBeenLastCalledWith('home');
  });

  it('choosing Home preserves the previous tab for Back', async () => {
    const onPop = vi.fn();
    stack.startBackStack(onPop);
    stack.setTab('account');
    await settle();
    stack.setTab('home');
    await settle();
    expect(win.index).toBe(2);
    win.history.back();
    await settle();
    expect(onPop).toHaveBeenLastCalledWith('account');
    expect(win.index).toBe(1);
  });

  it('stacks a page opened from a tab, so back returns to that tab', async () => {
    const onPop = vi.fn();
    stack.startBackStack(onPop);
    stack.setTab('account');
    stack.setTab('orders');
    await settle();
    expect(win.index).toBe(2);

    win.history.back();
    await settle();
    expect(onPop).toHaveBeenLastCalledWith('account');
    expect(win.index).toBe(1);
  });

  it('records nothing for the tab already showing — the first launch pushed a duplicate before', async () => {
    stack.startBackStack(() => {});
    stack.setTab('home');
    stack.setTab('home');
    await settle();
    expect(win.entries).toHaveLength(1);
  });
});

describe('layers', () => {
  it('returns from settings to Account, then the previous tab', async () => {
    const onPop = vi.fn();
    stack.startBackStack(onPop);
    stack.setTab('prices');
    stack.setTab('account');
    const closeSettings = vi.fn();
    stack.openLayer(closeSettings);
    await settle();
    win.history.back();
    await settle();
    expect(closeSettings).toHaveBeenCalledTimes(1);
    expect(onPop).not.toHaveBeenCalled();
    expect(win.index).toBe(2);
    win.history.back();
    await settle();
    expect(onPop).toHaveBeenLastCalledWith('prices');
    expect(win.index).toBe(1);
  });

  it('back closes the newest layer and nothing else', async () => {
    stack.startBackStack(() => {});
    const closeCategory = vi.fn();
    const closeProduct = vi.fn();
    stack.openLayer(closeCategory);
    stack.openLayer(closeProduct);
    await settle();
    expect(win.index).toBe(2);

    win.history.back();
    await settle();
    expect(closeProduct).toHaveBeenCalledTimes(1);
    expect(closeCategory).not.toHaveBeenCalled();
  });

  it('a layer closed by its own button gives its entry back', async () => {
    stack.startBackStack(() => {});
    const id = stack.openLayer(() => {});
    await settle();
    expect(win.index).toBe(1);

    stack.closeLayer(id);
    await settle();
    expect(win.index).toBe(0);
  });

  it('opened and closed in one tick never reaches history', async () => {
    stack.startBackStack(() => {});
    const id = stack.openLayer(() => {});
    stack.closeLayer(id);
    await settle();
    expect(win.entries).toHaveLength(1);
  });

  it('closing the basket and switching tab in one tap lands on the new tab', async () => {
    const onPop = vi.fn();
    stack.startBackStack(onPop);
    const cart = stack.openLayer(() => {});
    const product = stack.openLayer(() => {});
    await settle();

    // BottomNav: both close, then the tab changes — all in one commit.
    stack.closeLayer(product);
    stack.closeLayer(cart);
    stack.setTab('prices');
    await settle();
    expect(win.index).toBe(1);
    expect(win.history.state.vegdropTab).toBe('prices');

    win.history.back();
    await settle();
    expect(onPop).toHaveBeenCalledWith('home');
    expect(win.index).toBe(0);
  });

  it('closing a layer that back already closed does not step back again', async () => {
    stack.startBackStack(() => {});
    let id;
    const close = vi.fn(() => stack.closeLayer(id));
    id = stack.openLayer(close);
    await settle();

    win.history.back();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(win.index).toBe(0);
  });
});

describe('edges', () => {
  it("undoes the browser's forward button instead of treating it as back", async () => {
    stack.startBackStack(() => {});
    const close = vi.fn();
    stack.openLayer(close);
    await settle();
    win.history.back();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);

    win.history.forward();
    await settle();
    expect(win.index).toBe(0);
  });

  it('touches nothing once reset — the app has handed over to a role app', async () => {
    stack.startBackStack(() => {});
    const id = stack.openLayer(() => {});
    await settle();
    stack.resetBackStack();
    stack.closeLayer(id);
    stack.setTab('prices');
    await settle();
    expect(win.index).toBe(1);
  });
});


describe('screen ordering', () => {
  it('backs out of a tab opened above an overlay before closing that overlay', async () => {
    const onPop = vi.fn();
    const close = vi.fn();
    stack.startBackStack(onPop);
    stack.setTab('prices');
    stack.openLayer(close);
    stack.setTab('account');
    await settle();
    win.history.back();
    await settle();
    expect(onPop).toHaveBeenLastCalledWith('prices');
    expect(close).not.toHaveBeenCalled();
    win.history.back();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('removes a covered layer without losing the top screen history', async () => {
    stack.startBackStack(() => {});
    const lower = stack.openLayer(vi.fn());
    const closeUpper = vi.fn();
    stack.openLayer(closeUpper);
    await settle();
    stack.closeLayer(lower);
    await settle();
    expect(win.index).toBe(1);
    expect(win.history.state.vegdropIdx).toBe(1);
    win.history.back();
    await settle();
    expect(closeUpper).toHaveBeenCalledTimes(1);
    expect(win.index).toBe(0);
  });

  it('handles a browser jump across several screens in one traversal', async () => {
    const onPop = vi.fn();
    const close = vi.fn();
    stack.startBackStack(onPop);
    stack.setTab('account');
    stack.openLayer(close);
    stack.setTab('orders');
    await settle();
    win.history.go(-3);
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onPop).toHaveBeenLastCalledWith('home');
    stack.setTab('prices');
    await settle();
    expect(win.history.state.vegdropIdx).toBe(1);
  });
});
