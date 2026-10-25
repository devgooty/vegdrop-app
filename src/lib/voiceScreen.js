/**
 * What is on screen, as one sentence the agent can say.
 *
 * This is the "medium mode" answer — "what am I looking at?" — and it is a
 * pure function of the view the app is already holding, deliberately. The
 * alternative is reading the DOM aloud, which answers with whatever happens to
 * be rendered: a spinner, a toast, an empty list that is merely still loading.
 * A screen names itself better than its markup does.
 *
 * It takes `t` rather than importing it, so the sentence comes out in the
 * shopper's language and this file stays testable without a provider.
 */

/** Topmost first: a sheet over a tab is what the shopper is looking at. */
const LAYERS = [
  ['signIn', 'voice.screen.signIn'],
  ['mapPicker', 'voice.screen.mapPicker'],
  ['product', 'voice.screen.product'],
  ['category', 'voice.screen.category'],
  ['search', 'voice.screen.search'],
  ['wallet', 'voice.screen.wallet'],
  ['offers', 'voice.screen.offers'],
  ['basket', 'voice.screen.cart'],
];

const TABS = {
  home: 'voice.screen.home',
  prices: 'voice.screen.prices',
  cook: 'voice.screen.cook',
  cart: 'voice.screen.cart',
  orders: 'voice.screen.orders',
  account: 'voice.screen.account',
};

/**
 * @param {object} view    what the app has open — one layer key, or a tab
 * @param {(key: string, vars?: object) => string} t
 */
export function describeScreen(view = {}, t) {
  const open = LAYERS.find(([key]) => view[key]);
  if (open) {
    const [key, phrase] = open;
    // A product or a category has a name, and saying it is the whole value of
    // the answer: "you are on a product page" tells the shopper nothing they
    // did not know from tapping it.
    const named = key === 'product' ? view.productName : key === 'category' ? view.categoryName : null;
    if (named) return t(`${phrase}Named`, { name: named });
    if (key === 'search' && view.query) return t('voice.screen.searchFor', { query: view.query });
    return t(phrase);
  }

  const tab = TABS[view.tab];
  if (!tab) return t('voice.screen.unknown');

  // The cart is the one tab whose contents change what is worth saying about
  // it, and "your cart is empty" is the answer to both questions at once.
  if (view.tab === 'cart') return describeCart(view, t);
  if (view.tab === 'home' && view.marketName) {
    return t('voice.screen.homeAt', { market: view.marketName });
  }
  return t(tab);
}

/** Rupees from paise, without the trailing `.00` nobody says out loud. */
function rupees(paise) {
  const n = Number(paise) || 0;
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2);
}

/**
 * The cart, spoken.
 *
 * Long carts are summarised rather than recited: a shopper with fourteen lines
 * does not want all fourteen read back, and the ones they are most likely to be
 * asking about are the ones they added last. The count is always exact, so the
 * sentence never implies the cart holds only what was read.
 */
export function describeCart(view = {}, t, { maxNamed = 4 } = {}) {
  const lines = Array.isArray(view.cartLines) ? view.cartLines : [];
  if (lines.length === 0) return t('voice.cart.empty');

  const named = lines.slice(0, maxNamed).map((line) => {
    const quantity = Number(line.quantity) || 1;
    return quantity > 1 ? t('voice.cart.line', { name: line.name, count: quantity }) : line.name;
  });

  const rest = lines.length - named.length;
  const items = named.join(', ');
  const total = rupees(view.cartTotalPaise);

  return rest > 0
    ? t('voice.cart.someAndMore', { items, more: rest, total })
    : t('voice.cart.all', { items, total });
}

/** What this mode will and will not do, asked for by "help". */
export function describeHelp(mode, t) {
  if (mode === 'high') return t('voice.help.high');
  if (mode === 'medium') return t('voice.help.medium');
  if (mode === 'low') return t('voice.help.low');
  return t('voice.help.off');
}
