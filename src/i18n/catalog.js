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
 * The `toLocaleDateString` locale for the app language.
 *
 * Derived from what the shopper chose, never from the browser: a screen
 * explicitly set to Telugu should not carry English month names because the
 * phone happens to be en-US. All three are `-IN` regions, so day-then-month
 * order and the Indian digit grouping are the same in each.
 */
export function dateLocale(language) {
  return { te: 'te-IN', hi: 'hi-IN' }[language] || 'en-IN';
}

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

  /**
   * The per-vegetable aisle entries.
   *
   * `initialCategories` is four real aisles followed by one entry per item in
   * `marketVegetables` / `marketLeafyGreens`, and anything rendering that array
   * — the Price Tracker's filter chips, a shopkeeper's category picker — shows
   * all of them together. So they belong in the same map: a caller cannot know
   * which kind of entry it is holding, and should not have to.
   *
   * These are the everyday market word, matching the product names in
   * server/utils/productTranslations.js. Where the product carries a variety
   * ("Button Mushroom", "Iceberg Lettuce") the tile keeps only the plain noun,
   * because the tile is the aisle, not the item.
   */
  tomato: { te: 'టమాటా', hi: 'टमाटर' },
  'green-chilli': { te: 'పచ్చిమిర్చి', hi: 'हरी मिर्च' },
  peas: { te: 'బఠానీలు', hi: 'मटर' },
  brinjal: { te: 'వంకాయ', hi: 'बैंगन' },
  cucumber: { te: 'కీరదోస', hi: 'खीरा' },
  'bottle-gourd': { te: 'సొరకాయ', hi: 'लौकी' },
  onion: { te: 'ఉల్లిపాయ', hi: 'प्याज' },
  cabbage: { te: 'క్యాబేజీ', hi: 'पत्ता गोभी' },
  cauliflower: { te: 'కాలీఫ్లవర్', hi: 'फूल गोभी' },
  carrot: { te: 'క్యారెట్', hi: 'गाजर' },
  beetroot: { te: 'బీట్‌రూట్', hi: 'चुकंदर' },
  potato: { te: 'బంగాళాదుంప', hi: 'आलू' },
  spinach: { te: 'పాలకూర', hi: 'पालक' },
  coriander: { te: 'కొత్తిమీర', hi: 'हरा धनिया' },
  ginger: { te: 'అల్లం', hi: 'अदरक' },
  garlic: { te: 'వెల్లుల్లి', hi: 'लहसुन' },
  'ridge-gourd': { te: 'బీరకాయ', hi: 'तुरई' },
  'bitter-gourd': { te: 'కాకరకాయ', hi: 'करेला' },
  okra: { te: 'బెండకాయ', hi: 'भिंडी' },
  capsicum: { te: 'క్యాప్సికం', hi: 'शिमला मिर्च' },
  'sweet-potato': { te: 'చిలగడదుంప', hi: 'शकरकंद' },
  'green-beans': { te: 'ఫ్రెంచ్ బీన్స్', hi: 'फ्रेंच बीन्स' },
  'spring-onion': { te: 'ఉల్లికాడలు', hi: 'हरा प्याज' },
  turnip: { te: 'టర్నిప్', hi: 'शलगम' },
  pumpkin: { te: 'గుమ్మడికాయ', hi: 'कद्दू' },
  radish: { te: 'ముల్లంగి', hi: 'मूली' },
  mushroom: { te: 'పుట్టగొడుగులు', hi: 'मशरूम' },
  zucchini: { te: 'జుకిని', hi: 'जुकीनी' },
  leek: { te: 'లీక్', hi: 'लीक' },
  celery: { te: 'సెలెరీ', hi: 'सेलेरी' },
  'raw-banana': { te: 'అరటికాయ', hi: 'कच्चा केला' },
  fennel: { te: 'సోంపు', hi: 'सौंफ' },
  asparagus: { te: 'ఆస్పరాగస్', hi: 'शतावरी' },
  lettuce: { te: 'లెట్యూస్', hi: 'सलाद पत्ता' },
  'mustard-greens': { te: 'ఆవాకూర', hi: 'सरसों का साग' },
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
