/**
 * Basket helpers.
 *
 * The basket is persisted (`vegdrop_cart` in localStorage), which is what makes
 * this file necessary rather than merely tidy: a bug that corrupted the basket
 * once keeps serving that corruption back on every future visit, long after the
 * code that caused it is gone. Fixing the writer is only half a fix.
 */

/**
 * Total items, counting quantities rather than lines.
 *
 * The bottom-nav badge has always counted this way, while the basket header
 * counted `cartItems.length` — so a basket holding nine things announced "9" on
 * the tab and "(6)" in the title. Both now call this.
 */
export function cartItemCount(items = []) {
  return items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

/**
 * Collapse repeated lines for the same id into one, summing their quantities.
 *
 * Adding the same product several times in one React batch used to append a
 * fresh line per tap, because the "is it already in the basket?" lookup read a
 * render-time snapshot instead of the updater's `prev`. The writer is fixed, but
 * baskets saved while it was broken still hold rows like three separate
 * "Broccoli (500g) x1", and those persist across deploys.
 *
 * Returns the SAME array reference when there is nothing to merge. Callers run
 * this against stored state on mount, and handing back a fresh array every time
 * would rewrite localStorage and re-render on every load for no reason.
 *
 * Order is preserved by first appearance, so a repaired basket does not
 * reshuffle itself under the shopper.
 */
export function mergeCartLines(items = []) {
  const byId = new Map();

  for (const item of items) {
    const existing = byId.get(item.id);
    if (existing) {
      existing.quantity += Number(item.quantity) || 0;
    } else {
      byId.set(item.id, { ...item, quantity: Number(item.quantity) || 0 });
    }
  }

  // A line whose quantity summed to zero or less is dropped: it cannot be
  // interacted with — the stepper would need a negative tap to reach it — and
  // it would sit in the basket contributing nothing but a confusing row.
  const merged = [...byId.values()].filter((item) => item.quantity > 0);

  return merged.length === items.length ? items : merged;
}
