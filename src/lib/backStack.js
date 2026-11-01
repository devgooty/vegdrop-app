/**
 * The back button — Android's or the browser's — steps back through whatever
 * is on screen, one thing at a time.
 *
 * In the Android app MainActivity hands the button to the WebView, which goes
 * back one history entry, so what the button does is exactly what this history
 * says. Before this module only bottom-nav tab changes were recorded, and badly:
 * back on a product page, the basket or the sign-in screen changed the tab
 * underneath and left the overlay where it was, and in the app — where nothing
 * handled the button at all — it closed VegDrop from every screen.
 *
 * Two kinds of entry sit above the first one, which is Home:
 *
 * Tabs and layers share one ordered stack. Back always removes the newest
 * screen, even when a tab was opened over an existing layer.
 *
 * Entries mean nothing but their count. That is what lets a layer closed by its
 * own button consume an entry with history.go(-1) — leaving it would give back
 * a dead entry to land on, a press that does nothing.
 *
 * Every operation goes through one queue, because history.go() lands later and
 * asynchronously: a pushState issued before it lands is the entry it then steps
 * back over. Closing the basket and switching tab in one tap is exactly that.
 */

// A history.go() with nothing to go back to fires no popstate.
const TRAVERSAL_TIMEOUT_MS = 700;

const entries = []; // tabs and layers in actual opening order
let nextLayerId = 1;
const queue = []; // history operations not yet applied
let traversing = false; // one of our own history.go() calls is in flight
let traversalTimer = null;
let drainScheduled = false;
let onTabPop = null;
// Off once the customer app hands over to another role's app: an unmount
// closing its layers must not step that app's history back.
let enabled = true;

const win = typeof window === 'undefined' ? null : window;

function depth() {
  return entries.length;
}

function currentTab() {
  return entries.findLast((entry) => entry.type === 'tab')?.tab || 'home';
}

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  // Deferred so every close and open in one React commit is queued before any
  // of it reaches history, and consecutive closes merge into one go(-n).
  queueMicrotask(() => {
    drainScheduled = false;
    drain();
  });
}

function drain() {
  while (!traversing && queue.length > 0) {
    const op = queue.shift();
    if (op.type === 'back') {
      traversing = true;
      win.history.go(-op.n);
      traversalTimer = setTimeout(endTraversal, TRAVERSAL_TIMEOUT_MS);
    } else if (op.type === 'push') {
      win.history.pushState(op.state, '');
    } else {
      win.history.replaceState(op.state, '');
    }
  }
}

function endTraversal() {
  clearTimeout(traversalTimer);
  traversing = false;
  drain();
}

function enqueue(op) {
  if (!enabled) return;
  queue.push(op);
  scheduleDrain();
}

function enqueueBack(n) {
  if (!enabled || n <= 0) return;
  const last = queue[queue.length - 1];
  if (last && last.type === 'back') last.n += n;
  else queue.push({ type: 'back', n });
  scheduleDrain();
}

function onPopState(event) {
  if (!enabled) return;
  if (traversing) {
    // Our own go(); the entry it consumed was already accounted for.
    endTraversal();
    return;
  }

  // Each entry records its position, so a browser's forward button (Android
  // has none) is recognisable — and undone, since the layer it would reopen is
  // gone. Treated as back, it would close something that is still open.
  const position = event.state?.vegdropIdx;
  if (typeof position === 'number' && position > depth()) {
    traversing = true;
    win.history.go(depth() - position);
    traversalTimer = setTimeout(endTraversal, TRAVERSAL_TIMEOUT_MS);
    return;
  }

  const previousTab = currentTab();
  const target = typeof position === 'number' ? Math.max(0, position) : depth() - 1;
  while (entries.length > target) {
    const top = entries.pop();
    if (top.type === 'layer') top.close();
  }
  if (currentTab() !== previousTab) onTabPop?.(currentTab());
}

if (win) {
  win.history.replaceState({ ...(win.history.state || {}), vegdropIdx: 0 }, '');
  win.addEventListener('popstate', onPopState);
}

/**
 * Give history an entry for something just opened. `close` is called when back
 * is pressed while it is the newest thing open; it must actually close it.
 * @returns {number} the id to pass to closeLayer when it closes another way
 */
export function openLayer(close) {
  const id = nextLayerId++;
  if (!enabled) return id;
  entries.push({ type: 'layer', id, close });
  enqueue({ type: 'push', state: { vegdropIdx: depth() }, layerId: id });
  return id;
}

/** It closed by its own control (or unmounted): consume its entry. */
export function closeLayer(id) {
  const index = entries.findIndex((entry) => entry.type === 'layer' && entry.id === id);
  // Back already closed it, and took its entry with it.
  if (index === -1) return;
  entries.splice(index, 1);

  // Opened and closed before history ever saw it.
  const last = queue[queue.length - 1];
  if (last && last.type === 'push' && last.layerId === id) {
    queue.pop();
    return;
  }
  // Removing a covered layer must preserve every screen above it. Rebuild
  // that suffix after traversal; consuming only one entry would remove the top.
  const above = entries.slice(index);
  enqueueBack(above.length + 1);
  above.forEach((entry, offset) => {
    enqueue({ type: 'push', state: {
      vegdropIdx: index + offset + 1,
      ...(entry.type === 'tab' ? { vegdropTab: entry.tab } : {}),
    }, ...(entry.type === 'layer' ? { layerId: entry.id } : {}) });
  });
}

/** Keep history in step with the tab on screen. Calling it with the current tab is a no-op. */
export function setTab(tab) {
  if (!enabled || tab === currentTab()) return;

  entries.push({ type: 'tab', tab });
  enqueue({ type: 'push', state: { vegdropIdx: depth(), vegdropTab: tab } });
}

/** `onPop(tab)` is told which tab back landed on. */
export function startBackStack(onPop) {
  onTabPop = onPop;
  enabled = true;
}

/**
 * Forget everything without touching history — the app using it is going
 * away (a role redirect), and its layers with it.
 */
export function resetBackStack() {
  enabled = false;
  entries.length = 0;
  clearTimeout(traversalTimer);
  traversing = false;
  queue.length = 0;
  onTabPop = null;
}
