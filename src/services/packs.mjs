/**
 * How much of something a shopper is buying.
 *
 * `.mjs`, alone in this directory, and deliberately. `package.json` declares
 * `"type": "commonjs"` for the server, so Node reads every `.js` file as
 * CommonJS — including these, which Vite compiles as ESM and never asks Node
 * about. That is fine until something wants to TEST one, and this is the one
 * module that has to be tested: it decides what a shopper is charged.
 * `server/test/packs.test.js` imports it directly, which only works if Node can
 * see it is a module. Vite resolves the extension either way.
 *
 * THE BUG THIS FILE EXISTS TO CLOSE.
 *
 * Every product card offered 250g / 500g / 750g / 1kg and priced the choice on
 * the client — `product.price / nativeWeight * chosenWeight`. Nothing carried
 * that choice to the server. Checkout posts `{ productId, quantity }` and the
 * server recomputes every line from the catalog, exactly as it should, so the
 * order was billed as ONE pack at the pack's own price whatever the shopper
 * picked. A 250g pack of spinach shown as "1kg — ₹140" was charged at ₹35, and
 * the stall was told to pack 250g.
 *
 * It ran the other way too. Iceberg lettuce is a 1kg pack at ₹35; choosing
 * 250g showed ₹9 and charged ₹35.
 *
 * WHY MULTIPLES, AND ONLY MULTIPLES.
 *
 * The fix is not to send the weight — the server would still have to price it,
 * and a stall cannot split a pack it bought whole. What a shop sells IS the
 * pack, so the only quantity an order can honestly carry is a whole number of
 * them. `units` is that number, and price is `pack price × units`, which the
 * server reproduces exactly because it is doing the same multiplication.
 *
 * So a 250g pack offers 250g / 500g / 750g / 1kg (×1 to ×4) and a 1kg pack
 * offers 1kg / 2kg / 3kg / 4kg. A quarter of a 1kg pack is not on the menu,
 * because it was never something anyone could deliver.
 *
 * WHAT STOPPED HAVING A WEIGHT PICKER AT ALL.
 *
 * `isWeightBased` used to accept any weight string containing "g" and not
 * "pack" — which is most of them. "1 bunch (approx 100g)" and "1 pc (approx
 * 600g)" both passed, so a single cauliflower got sold by the quarter-kilo and
 * a bunch of coriander was priced as if it came by the kilo (its ₹X became
 * ₹10X at the default 1kg selection, on first paint, without the shopper
 * touching anything). A pack whose weight is an approximation of a count is
 * sold by the piece; `packGrams` only recognises a bare weight, so those get no
 * picker and are simply added one pack at a time.
 */

/** A bare weight and nothing else — "500g", "1kg", "250 g". Not "1 pc (approx 600g)". */
const BARE_WEIGHT = /^\s*(\d+(?:\.\d+)?)\s*(g|gm|gms|kgs?)\s*$/i;

/** How many packs of one product a single tap may stack up to. */
const MAX_PACKS = 4;

/**
 * The pack's weight in grams, or null when it is not sold by weight.
 *
 * Deliberately strict: anything that is a count with a weight in brackets
 * ("3 pcs (approx 500g)") is a count, and returning 500 for it would put a
 * per-kilo price on three courgettes.
 */
export function packGrams(weight) {
  const match = BARE_WEIGHT.exec(String(weight ?? ''));
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const grams = /^kgs?$/i.test(match[2]) ? amount * 1000 : amount;
  return Math.round(grams);
}

/** "1kg" rather than "1000g", and "1.5kg" rather than "1500g". */
export function formatGrams(grams) {
  if (grams < 1000) return `${grams}g`;
  const kg = grams / 1000;
  return `${Number(kg.toFixed(2))}kg`;
}

/**
 * The sizes this product can actually be sold in, largest quantity last.
 *
 * Empty when it is not sold by weight, which is the signal to render no picker
 * at all rather than one with a single option.
 *
 * @returns {Array<{units: number, label: string, price: number, oldPrice: number|null}>}
 */
export function packOptions(product) {
  const grams = packGrams(product?.weight);
  if (!grams) return [];

  return Array.from({ length: MAX_PACKS }, (_, index) => {
    const units = index + 1;
    return {
      units,
      label: formatGrams(grams * units),
      // Whole multiples of the pack price, so what is shown is what the server
      // recomputes. Never a rounded per-kilo rate, which is where the two
      // numbers used to part company.
      price: product.price * units,
      oldPrice: product.oldPrice ? product.oldPrice * units : null,
    };
  });
}

/**
 * How many packs one basket line stands for.
 *
 * Defaults to 1, which is both the honest reading of a line that never carried
 * the field and the only safe one — a basket saved before this existed holds
 * lines whose price is wrong, and guessing a multiplier from that price would
 * turn a display bug into a billing one.
 */
export function unitsOf(line) {
  const units = Number(line?.units);
  return Number.isInteger(units) && units > 0 ? units : 1;
}

/**
 * The basket row a product-and-size belongs in.
 *
 * A size is part of what a row IS: 500g and 1kg of the same spinach are two
 * rows, not one row that quietly forgets which was asked for.
 */
export function packLineId(productId, units) {
  return units > 1 ? `${productId}-x${units}` : String(productId);
}
