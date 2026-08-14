/**
 * Sharing a product.
 *
 * The link is built from `sku`, not from `id`. A product's `id` is its Mongo
 * `_id`, and the same item exists as a separate document per market sheet, so an
 * id-based link would resolve for the sender and 404 for anyone browsing a
 * different market. `sku` is globally unique (see server/models/Product.js), so
 * it names the item itself rather than one market's copy of it.
 *
 * Falls back to the sender's current URL when a product somehow has no sku —
 * a share that lands on the shop is worth more than a share that throws.
 */
export function productShareUrl(product, origin = window.location.origin) {
  if (!product?.sku) return `${origin}/`;
  return `${origin}/#/p/${encodeURIComponent(product.sku)}`;
}

/**
 * Hand a product to the OS share sheet, or to the clipboard.
 *
 * Returns how it was shared so the caller can decide whether to say anything:
 * the native sheet is its own confirmation, but a silent clipboard write is
 * indistinguishable from a dead button and needs a toast.
 *
 *   'shared'    — went to the native share sheet
 *   'copied'    — URL is on the clipboard
 *   'cancelled' — the sheet opened and the user dismissed it; say nothing
 *   'failed'    — neither worked
 *
 * `navigator.share` is not just a mobile/desktop split: it is unavailable on
 * insecure origins and throws NotAllowedError outside a user gesture, so the
 * clipboard path is a real fallback rather than a desktop-only branch.
 */
export async function shareProduct(product, { origin } = {}) {
  const url = productShareUrl(product, origin);
  const price = product?.price != null ? ` — ₹${product.price}` : '';
  const title = product?.name || 'VegDrop';

  if (navigator.share) {
    try {
      await navigator.share({ title, text: `${title}${price} on VegDrop`, url });
      return 'shared';
    } catch (err) {
      // The user dismissing the sheet is not a failure, and must not fall
      // through to the clipboard — that would silently copy something they
      // just declined to share.
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * The sku in `#/p/<sku>`, or null when the hash is not a product link.
 *
 * Kept here beside the writer so the two cannot drift apart.
 */
export function productSkuFromHash(hash = window.location.hash) {
  const match = /^#?\/p\/([^/?#]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
}
