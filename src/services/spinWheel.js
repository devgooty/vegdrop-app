/**
 * The rewards spin wheel.
 *
 * READ services/rewards.js FIRST — the same caveat governs this file, only
 * harder. Token balances here are derived on the client, and so is the spin
 * outcome: `pickPrize` runs in the browser, and the spend log lives in
 * localStorage. Anyone with devtools can force a win or refund their own
 * tokens. That is a deliberate, temporary position while the wheel is a teaser,
 * and it is why `SpinWheel` states on screen that prizes are not yet
 * redeemable.
 *
 * Before a win can be exchanged for an actual egg basket, the draw has to move
 * server side: an endpoint that decides the prize, a record of what was won, and
 * a token ledger it debits inside the same transaction — exactly the shape the
 * wallet already has. Do not add a redemption flow on top of this file.
 */

/**
 * The wheel face, in segment order.
 *
 * `weight` is relative, not a percentage, so a segment can be re-tuned without
 * having to rebalance every other number to keep a total of 100. The blank
 * outweighs the prizes combined on purpose: a wheel that pays out most of the
 * time reads as fake, and would be ruinous if these are ever real goods.
 *
 * `label`/`short` are the English wording; `labelKey`/`shortKey` are what the
 * component actually renders. Both are kept: the keys live here rather than in a
 * lookup inside SpinWheel so an id and its translation cannot drift apart, and
 * the English stays as the readable name in a spin log or a test assertion.
 */
export const PRIZES = [
  { id: 'egg-basket', label: 'Egg Basket', short: 'Egg Basket', labelKey: 'spin.prize.eggBasket', shortKey: 'spin.prize.short.eggBasket', emoji: '🧺', weight: 8, color: '#1B4D3E' },
  { id: 'knife', label: 'Kitchen Knife', short: 'Knife', labelKey: 'spin.prize.knife', shortKey: 'spin.prize.short.knife', emoji: '🔪', weight: 8, color: '#B45309' },
  { id: 'juice-glass', label: 'Juice Glass', short: 'Juice Glass', labelKey: 'spin.prize.juiceGlass', shortKey: 'spin.prize.short.juiceGlass', emoji: '🥤', weight: 10, color: '#0F766E' },
  { id: 'slicer', label: '2-in-1 Vegetable Slicer', short: 'Slicer', labelKey: 'spin.prize.slicer', shortKey: 'spin.prize.short.slicer', emoji: '🔧', weight: 4, color: '#7C2D12' },
  { id: 'none', label: 'Better Luck Next Time', short: 'Try Again', labelKey: 'spin.prize.none', shortKey: 'spin.prize.short.none', emoji: '🍀', weight: 70, color: '#57534E' },
];

/** Tokens burned by one spin. */
export const TOKENS_PER_SPIN = 20;

/** A win worth announcing — everything except the blank. */
export function isWin(prize) {
  return Boolean(prize) && prize.id !== 'none';
}

/**
 * Weighted draw across PRIZES.
 *
 * `random` is injected so tests can pin the outcome; it must return [0, 1).
 * The final segment is returned as the fallback rather than `undefined` when
 * floating-point error leaves the cursor a hair past the last threshold.
 */
export function pickPrize(random = Math.random) {
  const total = PRIZES.reduce((sum, prize) => sum + prize.weight, 0);
  let cursor = random() * total;

  for (const prize of PRIZES) {
    cursor -= prize.weight;
    if (cursor < 0) return prize;
  }
  return PRIZES[PRIZES.length - 1];
}

/* ── Spin log ────────────────────────────────────────────────────────────────
   Keyed per user id, never per phone: a phone number is PII and this lands in
   web storage, which CLAUDE.md is emphatic about. The log holds prize ids and
   timestamps only — nothing about the account, and nothing another role's app
   could read anything meaningful out of. */

const STORAGE_PREFIX = 'vegdrop_spins_';

function storageKey(userId) {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * Every spin this shopper has taken, newest first.
 *
 * Storage is treated as hostile input: it survives deploys, so a shape from an
 * older release can still be sitting there, and Safari's private mode throws on
 * read outright. Anything unparseable reads as "no spins" rather than taking the
 * rewards screen down with it.
 */
export function loadSpins(userId) {
  if (!userId) return [];

  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry) => entry && typeof entry.prizeId === 'string' && typeof entry.at === 'number'
    );
  } catch {
    return [];
  }
}

/**
 * Append a spin and return the updated log.
 *
 * Returns the new list rather than mutating so callers drive React state with
 * it. A storage failure still returns the updated list: losing the record of a
 * spin is much better than the wheel appearing frozen.
 */
export function recordSpin(userId, prize, spins) {
  const entry = { prizeId: prize.id, at: Date.now() };
  const next = [entry, ...spins];

  if (userId) {
    try {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(next));
    } catch {
      /* Quota or private mode. The spin still happened on screen. */
    }
  }
  return next;
}

/**
 * Tokens left to spend, given lifetime earnings and the spins already taken.
 *
 * Floored at zero: earnings are recomputed from the live order list, so an order
 * that later cancels can shrink the lifetime total below what has already been
 * spent. A negative balance on screen would be a bug report; zero is the honest
 * reading of "nothing left to spin with".
 */
export function availableTokens(totalTokens, spins) {
  return Math.max(0, totalTokens - spins.length * TOKENS_PER_SPIN);
}
