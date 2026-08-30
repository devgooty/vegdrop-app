/**
 * The customer's saved-for-later list.
 *
 * Lives in localStorage rather than on the server, for the same reason the
 * basket does (`vegdrop_cart` in App.jsx): liking a product is not a fact
 * the platform needs to be authoritative about — nothing here is charged,
 * fulfilled, or visible to anyone but the browser that set it. Building a
 * server model, route and migration for it would be machinery with nothing
 * to protect.
 *
 * Snapshots the product it was toggled on, exactly as the basket does,
 * rather than storing a bare id and re-resolving it against the live catalog
 * later — a wishlisted item still has to render (image, name, price) on a
 * screen that only ever receives the wishlist itself, not the full product
 * list a given visit happened to load.
 */

const WISHLIST_KEY = 'vegdrop_wishlist';

/**
 * What a wishlist ENTRY is, deliberately the same question `catalogKeyOf` in
 * App.jsx asks of a basket line: the catalog item behind a shop's listing, or
 * the id itself when the row already IS the catalog item. Two shops' listings
 * of the same produce would otherwise both be "likeable" as separate entries.
 */
function wishlistKeyOf(item) {
  return String(item.catalogItem || item.originalId || item.id);
}

function readAll() {
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt JSON or private-mode Safari throwing on read; either way there
    // is nothing usable to recover.
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(WISHLIST_KEY, JSON.stringify(list));
  } catch {
    // Nothing to do: the toggle still reflects in the caller's own state for
    // this session, it just will not survive a reload.
  }
}

/** The saved products, most recently liked first. */
export function getWishlist() {
  return readAll();
}

export function isWishlisted(item) {
  const key = wishlistKeyOf(item);
  return readAll().some((entry) => entry.key === key);
}

/**
 * Add or remove `item`, depending on whether it is already saved.
 * Returns the new liked state.
 */
export function toggleWishlist(item) {
  const key = wishlistKeyOf(item);
  const list = readAll();
  const already = list.some((entry) => entry.key === key);

  if (already) {
    writeAll(list.filter((entry) => entry.key !== key));
    return false;
  }

  writeAll([{ ...item, key }, ...list]);
  return true;
}

export function removeFromWishlist(key) {
  writeAll(readAll().filter((entry) => entry.key !== key));
}
