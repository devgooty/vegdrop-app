/**
 * Names of things that come from data rather than from the UI layer.
 *
 * Kept apart from translations.js on purpose. That file holds the app's own
 * copy — words a developer wrote into a component — and every key is resolvable
 * at build time. These are labels attached to rows: a product from the API, a
 * category from mockData. They can go missing for reasons no amount of
 * translating the UI fixes, so each resolver here falls back to the English name
 * on the row rather than to a key.
 *
 * Product names are resolved from fields the server sends (`nameTe`/`nameHi` on
 * Product), not from a table here — a vendor can add a product tomorrow and a
 * client-side map would have no entry for it. Category names ARE a table,
 * because categories are fixed client-side data in src/data/mockData.js.
 */

/** Which field on a product row holds the name for a given language. */
const PRODUCT_NAME_FIELD = { te: 'nameTe', hi: 'nameHi' };

/**
 * The product's name in the current language.
 *
 * Falls back to English whenever the translation is missing or blank, which is
 * the normal state for anything a vendor added — better a name the shopper can
 * at least match against the photo than an empty label.
 *
 * Cart lines carry a decorated name (`"Tomatoes (500g)"`, built in
 * handleAddToCart), so the weight suffix is preserved: the translated base name
 * is swapped in and the bracketed part left alone.
 */
export function productName(product, language) {
  if (!product) return '';
  const english = product.name || '';
  if (language === 'en') return english;

  const field = PRODUCT_NAME_FIELD[language];
  const translated = field ? product[field] : '';
  if (!translated) return english;

  /**
   * A cart line's name is "<base> (<weight>)" — keep the weight, swap the base.
   *
   * The bracket must contain a digit to count as a weight. Catalog names carry
   * a *transliteration* in the same position ("Organic Spinach (Palak)"), and
   * keeping that produced "పాలకూర (Palak)" — the local name followed by a
   * romanisation of itself, which is precisely the English the translation was
   * meant to remove. "(500g)" has digits; "(Palak)" does not.
   */
  const suffix = /\s(\([^)]*\d[^)]*\))$/.exec(english);
  return suffix ? `${translated} ${suffix[1]}` : translated;
}

/**
 * Category titles and their badges, keyed on the category's `slug`.
 *
 * Slug rather than id or title: ids are positional and titles are editable copy,
 * and either one changing would silently detach the translations from the rows
 * they belong to.
 */
const CATEGORY_TITLES = {
  'leafy-greens': { te: 'ఆకుకూరలు', hi: 'पत्तेदार सब्ज़ियाँ' },
  'fresh-vegetables': { te: 'తాజా కూరగాయలు', hi: 'ताज़ी सब्ज़ियाँ' },
  'organic-fruits': { te: 'సేంద్రియ పండ్లు', hi: 'जैविक फल' },
  // The slug is `exotic-imported`, not `exotic-herbs` — the title says "Herbs"
  // but the slug does not, and keying off the title's wording is exactly the
  // mistake this map avoids.
  'exotic-imported': { te: 'ఎగ్జాటిక్ & మూలికలు', hi: 'विदेशी और जड़ी-बूटियाँ' },
};

const CATEGORY_BADGES = {
  'Fresh Today': { te: 'ఈరోజు తాజా', hi: 'आज ताज़ा' },
  Popular: { te: 'ప్రసిద్ధం', hi: 'लोकप्रिय' },
  '100% Organic': { te: '100% సేంద్రియం', hi: '100% जैविक' },
  Imported: { te: 'దిగుమతి', hi: 'आयातित' },
};

export function categoryTitle(category, language) {
  if (!category) return '';
  if (language === 'en') return category.title || '';
  return CATEGORY_TITLES[category.slug]?.[language] || category.title || '';
}

export function categoryBadge(badge, language) {
  if (!badge || language === 'en') return badge || '';
  return CATEGORY_BADGES[badge]?.[language] || badge;
}

/**
 * Weights as they appear on a card: "500g", "1kg", "2 pcs (approx 350g)".
 *
 * Only the words are translated, never the numbers or the unit symbols — a
 * shopper comparing ₹40/1kg against ₹45/1kg needs those to stay the characters
 * they already recognise, and "kg" is read as kg in all three languages.
 */
const WEIGHT_WORDS = {
  te: { pcs: 'ముక్కలు', pc: 'ముక్క', approx: 'సుమారు', bunch: 'కట్ట' },
  hi: { pcs: 'पीस', pc: 'पीस', approx: 'लगभग', bunch: 'गुच्छा' },
};

export function productWeight(weight, language) {
  if (!weight || language === 'en') return weight || '';
  const words = WEIGHT_WORDS[language];
  if (!words) return weight;

  return weight.replace(/\b(pcs|pc|approx|bunch)\b/gi, (m) => words[m.toLowerCase()] || m);
}
