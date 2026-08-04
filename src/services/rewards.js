/**
 * Reward tokens.
 *
 * The rule: every ₹100 of a single order earns 4 tokens.
 *
 * Accrual is **per order**, not against a running lifetime total, because the
 * rule is worded as something a purchase does — buy ₹100 worth, get 4 tokens.
 * The practical difference is what happens to the remainder: two ₹99 orders
 * earn nothing, where one ₹198 order earns 4. That is how shop loyalty
 * normally behaves, and it is the reading that lets the screen show an honest
 * per-order ledger instead of a single number nobody can check.
 *
 * IMPORTANT — this is derived, not banked. There is no reward model on the
 * server: no balance field, no ledger collection, no redemption endpoint. Every
 * figure here is recomputed from the order list on each render, so it cannot
 * drift out of step with the orders it is drawn from, and there is nothing to
 * spend it on yet. If tokens ever become redeemable they must move server side
 * first, exactly as the wallet already is — a balance a client can compute is a
 * balance a client can forge.
 */

/** Rupees of a single order that earn one batch of tokens. */
export const RUPEES_PER_BATCH = 100;

/** Tokens granted per completed batch. */
export const TOKENS_PER_BATCH = 4;

/**
 * Tokens a single order is worth.
 *
 * Cancelled orders earn nothing — the goods went back, so the reward does too.
 * Anything else counts, which matches how the account's "Total Lifetime Spent"
 * already treats the same list; tokens and spend disagreeing about which orders
 * are real would be worse than either rule on its own.
 */
export function tokensForOrder(order) {
  if (!order || order.status === 'Cancelled') return 0;

  const amount = Number(order.totalAmount) || 0;
  if (amount <= 0) return 0;

  return Math.floor(amount / RUPEES_PER_BATCH) * TOKENS_PER_BATCH;
}

/**
 * A shopper's whole reward position, derived from their orders.
 *
 * `shortfall` is what the most recent qualifying order left on the table — the
 * rupees that did not complete another batch. It is shown as a nudge rather
 * than as a balance, because per-order accrual means that remainder is gone,
 * not carried.
 */
export function summarizeRewards(orders = []) {
  const earning = orders
    .map((order) => ({ order, tokens: tokensForOrder(order) }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => (b.order.timestamp ?? 0) - (a.order.timestamp ?? 0));

  const totalTokens = earning.reduce((sum, entry) => sum + entry.tokens, 0);

  const counted = orders.filter((order) => order.status !== 'Cancelled');
  const totalSpent = counted.reduce((sum, order) => sum + (Number(order.totalAmount) || 0), 0);

  const latest = [...counted].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
  const latestAmount = Number(latest?.totalAmount) || 0;
  const remainder = latestAmount % RUPEES_PER_BATCH;

  return {
    totalTokens,
    totalSpent,
    entries: earning,
    ordersCounted: counted.length,
    // How much more that last order would have needed for another batch.
    // Zero when there is no order yet, or when it divided exactly.
    shortfall: latestAmount > 0 && remainder > 0 ? RUPEES_PER_BATCH - remainder : 0,
  };
}
