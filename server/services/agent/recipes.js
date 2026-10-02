'use strict';

/**
 * The cooking assistant's recipe book and the matching that answers from it.
 *
 * Nothing here is learned: `recipes.json` is a hand-checked recipe book and
 * `produce.json` is the vocabulary that ties a vegetable's many names (aloo,
 * bangaladumpa, urulaikizhangu) to the one catalog product it is sold as.
 * Every answer the assistant gives about a dish comes from these two files,
 * so an answer is only ever as accurate as they are — and `test/agentAccuracy`
 * pins how real customer phrasing resolves against them.
 *
 * Matching works on canonical tokens, not strings: every vegetable name in a
 * query or a dish name is rewritten to `veg:<key>` first, so "bhindi masala",
 * "okra masala" and "bendakaya masala" are the same request.
 */

const RECIPES = require('../../data/recipes.json');
const PRODUCE = require('../../data/produce.json');

const DEFAULT_SERVINGS = 2;
const MAX_SERVINGS = 12;

/** Words that carry no meaning about WHICH dish is wanted. */
const STOPWORDS = new Set(
  (
    'a an the of for to in on at and or with me my i we us you your pls plz please kindly tell give show ' +
    'send share want need like would could can should how what which make making made cook cooking cooked ' +
    'prepare preparing preparation recipe recipes procedure method process steps step way ways do does ' +
    'style simple easy quick quickly homemade home today tonight dinner lunch breakfast some any about ' +
    'people person persons members member servings serving serves serve family ' +
    'kaise banaye banayein banate banana banao banaen hai hain ka ke ki ko se aur mujhe batao bataiye ' +
    'ela cheyali cheyyali cheyadam cheppandi chepandi chesukovali elaa ' +
    'eppadi seivathu seivadhu seyyanum sollunga epdi ' +
    'dish dishes item food ppl pax no not without extra little bit ' +
    'have has had got pada pade padi rakha rakhe ghar pe par mein me kuch bata batao bol kya ' +
    'unnayi unnai undi intlo irukku veettula only just fridge available ' +
    // Hinglish chatter: "recipe bhej do bhai", "udupi jaisa sambar banana hai"
    'bnana banani banane bana bnao bhej bhejo do de dena dijiye chahiye chaiye sakte sakta sakti karu karun karo ' +
    'kare karein bhai bhaiya yaar yar bro dost didi ji jaldi jaisa jaise jaisi wala wali wale saath sath liye ' +
    'toh to nahi na ho hoga gaya gayi abhi aaj accha acha ek koi ya bhi sirf ' +
    // Telugu / Tamil chatter: "chesi pettu", "kavali", "venum"
    'cheyyi chey cheppu cheppandi chesi pettu kavali kavalenu enti emiti lo ni tho kosam ivvu chupinchu ' +
    'venum vendum oru ku la kuda sollu sollunga pannu panna'
  ).split(/\s+/)
);

/** Words that say what FORM a dish takes; they refine a match but never make one. */
const FORM_GROUPS = [
  ['curry', 'kura', 'koora', 'kuura', 'kari', 'gravy', 'salan', 'kurma', 'tari', 'rasa', 'rassa', 'rasedar', 'jhol'],
  ['fry', 'vepudu', 'vepadu', 'roast', 'sukha', 'sukhi', 'dry'],
  ['sabzi', 'sabji', 'subzi', 'subji', 'sabjee', 'sabziyan'],
  ['dal', 'daal', 'dhal', 'pappu', 'paruppu', 'lentil', 'lentils'],
  ['masala'],
  ['poriyal', 'thoran'],
  ['rice', 'bath', 'annam', 'sadam', 'saadam', 'chawal'],
  ['soup', 'shorba'],
  ['salad'],
  ['chutney', 'pachadi', 'thokku'],
  ['paratha', 'parantha', 'parata'],
  ['pulao', 'pulav', 'pilaf'],
  ['biryani', 'biriyani', 'biriani'],
  ['stir', 'stirfry', 'saute', 'sauteed', 'sauted'],
  ['kootu', 'koottu'],
  ['kuzhambu', 'kulambu', 'kozhambu'],
];
/**
 * Spellings of the same dish word. Applied to dish names and queries alike,
 * because both spellings are "correct" — so neither is a typo the fuzzy pass
 * would fix, and without this "sambhar" and "sambar" never meet.
 */
const CANONICAL = new Map(
  Object.entries({
    sambhar: 'sambar', saambar: 'sambar', sambaar: 'sambar',
    panner: 'paneer', paner: 'paneer', panir: 'paneer', pneer: 'paneer',
    pakora: 'pakoda', pakoras: 'pakoda', pakodas: 'pakoda', pakodi: 'pakoda', bajji: 'pakoda', bhajji: 'pakoda',
    raitha: 'raita', manchoorian: 'manchurian', manchuri: 'manchurian',
    tikkis: 'tikki', tikiya: 'tikki', cutlets: 'cutlet', parathas: 'paratha', parotta: 'parotta',
    bharta: 'bharta', bhartha: 'bharta', bharita: 'bharta', bhurta: 'bharta',
    kootu: 'kootu', kofta: 'kofta', koftas: 'kofta',
  })
);

const FORM_OF = new Map();
for (const group of FORM_GROUPS) for (const word of group) FORM_OF.set(word, `form:${group[0]}`);

/** Everyday words within a typo of a vegetable name ("butter"/mutter, "better"/beet…). */
const REAL_WORDS = new Set(
  ('butter better matter batter bitter litter potter tomorrow ginger garlic onions pepper paper bread beans beets leaves plants ' +
    // Hindi/Telugu/Tamil function words a four-letter correction would eat:
    // "mere paas" (I have) became peas, and the cart then held green peas.
    'paas pas par mere meri mera apna apne ghar abhi sirf thoda thodi kuch bahut bohot kani kuda koda tho ' +
    'unna undi inka inko iska isko idhi adhi ela elaa epdi naku nuvu meeru tagga mind kind find lost cost'
  ).split(' ')
);

/** Every word that appears in any dish name — filled when the dish index is built. */
const DISH_VOCABULARY = new Set();

const NONVEG =/\b(chicken|mutton|lamb|goat|beef|pork|fish|prawns?|shrimps?|crabs?|eggs?|omelett?e|anda|murgh|murg|gosht|keema|kheema|meat|kodi|chepala|chapala|royyalu|mamsam|koli|meen|yera|natu kodi)\b/;

function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** alias (normalized) → produce key, longest first so "patta gobi" beats "gobi". */
const PRODUCE_ALIASES = (() => {
  const rows = [];
  for (const [key, spec] of Object.entries(PRODUCE)) {
    for (const alias of new Set([key, ...(spec.aliases || [])])) {
      const norm = normalize(alias);
      if (norm) rows.push([norm, key]);
    }
  }
  return rows.sort((a, b) => b[0].length - a[0].length);
})();

const SINGLE_WORD_PRODUCE = new Map(
  PRODUCE_ALIASES.filter(([alias]) => !alias.includes(' ') && alias.length >= 4)
);

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function typoBudget(word) {
  if (word.length >= 8) return 2;
  if (word.length >= 4) return 1;
  return 0;
}

/**
 * Rewrite normalized text into canonical tokens. Vegetable phrases become
 * `veg:<key>` (longest alias first, and a matched span is consumed so "sweet
 * potato" never also yields potato); form words become `form:<group>`;
 * stopwords and numbers are dropped; everything else is kept as a word.
 */
function tokenize(text, { fuzzy = true } = {}) {
  const fuzzyVocabulary = fuzzy ? DISH_VOCABULARY : null;
  let rest = ` ${normalize(text)} `;
  const veg = [];
  for (const [alias, key] of PRODUCE_ALIASES) {
    const needle = ` ${alias} `;
    let at = rest.indexOf(needle);
    while (at !== -1) {
      rest = `${rest.slice(0, at)} @${veg.length} ${rest.slice(at + needle.length)}`;
      veg.push(key);
      at = rest.indexOf(needle);
    }
  }

  const tokens = [];
  for (const word of rest.split(' ')) {
    if (!word) continue;
    if (word.startsWith('@')) {
      tokens.push(`veg:${veg[Number(word.slice(1))]}`);
      continue;
    }
    if (/^\d+$/.test(word) || STOPWORDS.has(word)) continue;
    if (FORM_OF.has(word)) {
      tokens.push(FORM_OF.get(word));
      continue;
    }
    if (CANONICAL.has(word)) {
      tokens.push(CANONICAL.get(word));
      continue;
    }
    let resolved = word;
    // A word a dish name already uses is a word, not a typo: "butter" is one
    // letter from "mutter" (peas), and correcting it turned paneer butter
    // masala into matar paneer.
    const budget = fuzzy && !DISH_VOCABULARY.has(word) && !REAL_WORDS.has(word) ? typoBudget(word) : 0;
    if (budget > 0) {
      let best = null;
      for (const [alias, key] of SINGLE_WORD_PRODUCE) {
        // Four-letter words are only corrected toward a vegetable sharing their
        // first letter ("plak" → palak), never toward anything else.
        if (word.length === 4 && alias[0] !== word[0]) continue;
        const d = levenshtein(word, alias, budget);
        if (d <= budget && (!best || d < best.d)) best = { d, token: `veg:${key}` };
      }
      if (word.length === 4) {
        if (best) resolved = best.token;
        tokens.push(resolved);
        continue;
      }
      for (const [form, token] of FORM_OF) {
        if (form.length < 5) continue;
        const d = levenshtein(word, form, 1);
        if (d <= 1 && (!best || d < best.d)) best = { d, token };
      }
      if (fuzzyVocabulary && !fuzzyVocabulary.has(word)) {
        for (const known of fuzzyVocabulary) {
          if (known.length < 5) continue;
          const d = levenshtein(word, known, budget);
          if (d <= budget && (!best || d < best.d)) best = { d, token: known };
        }
      }
      if (best) resolved = best.token;
    }
    tokens.push(resolved);
  }
  return tokens;
}

/**
 * Vegetables the customer HAS, as produce keys.
 *
 * Negated spans are removed first, so "I have potato but no onion" is potato
 * alone. This feeds both the suggestion list and the cart's "leave out what
 * they already have", where getting it backwards is worst: the one vegetable
 * they told us they lacked was the one thing not ordered.
 */
function extractVegetables(text) {
  const keys = tokenize(cleanQuery(text))
    .filter((t) => t.startsWith('veg:'))
    .map((t) => t.slice(4));
  return [...new Set(keys)];
}

function normalizeVeg(raw) {
  const found = extractVegetables(raw);
  return found[0] || normalize(raw);
}

/** The words as typed, minus filler — "kakarakaya fry ela cheyali" → [kakarakaya, fry]. */
function surfaceWords(text) {
  return normalize(text)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function produceLines(recipe) {
  return recipe.ingredients.filter((ing) => ing.produce && !ing.optional);
}

function mainVegetables(recipe) {
  const mains = produceLines(recipe).filter((ing) => ing.role === 'main').map((ing) => ing.produce);
  return [...new Set(mains.length ? mains : produceLines(recipe).map((ing) => ing.produce))];
}

function allVegetables(recipe) {
  return [...new Set(produceLines(recipe).map((ing) => ing.produce))];
}

function totalMinutes(recipe) {
  return (Number(recipe.prepMinutes) || 0) + (Number(recipe.cookMinutes) || 0);
}

/* ---------------------------------------------------------------- dish index */

/**
 * What the customer says they do NOT have, or do not want in the dish.
 *
 * Read as plain vegetable names, "I have potato and tomato but no onion" put
 * onion on the have-list — so the cart then left out the one thing they were
 * missing. Everything after the negation to the end of that clause goes, since
 * "I don't have onion and tomato" negates both.
 */
const NEGATED_BEFORE =
  '\\b(?:without|not|no|dont|don t|do not|didnt|didn t|out of|run out of|except|excluding|apart from|other than|less|minus|avoid|skip|hate|allergic to|bina|lekunda|illama)\\b[^,.;!?]*';

/**
 * Telugu, Tamil and Hindi put the negation AFTER the noun — "ullipaya ledu",
 * "vengayam illai", "pyaz nahi hai" — so a leading-only rule read every one of
 * them as a vegetable the customer had.
 */
const NEGATED_AFTER =
  '(?:\\b[a-z]+\\b[ ]+){0,2}\\b(?:ledu|leda|leru|ayipoyindi|illa|illai|nahi|nahin|khatam|khatm|finished)\\b';

const NEGATED = new RegExp(`${NEGATED_BEFORE}|${NEGATED_AFTER}`, 'g');

const ACCOMPANIMENT ='(?:roti|rotis|chapati|chapatis|chapathi|phulka|naan|paratha|poori|puri|rice|chawal|annam|sadam|dosa|idli|bread|pav)';
const SERVED_WITH = new RegExp(
  `\\b(?:with|for|along with|served with)\\s+(?:hot\\s+)?${ACCOMPANIMENT}\\b|\\b${ACCOMPANIMENT}\\s+(?:ke|ki|ka)?\\s*(?:saath|sath|liye)\\b|\\b${ACCOMPANIMENT}\\s+(?:tho|kooda|kuda|ku|loki)\\b`,
  'g'
);

/**
 * The part of a message that can name a dish. "no gravy" / "without onion" say
 * what it is NOT, and "roti ke saath" / "with rice" say what it is eaten WITH;
 * neither is the dish, and both were being read as unknown dish names. Dish
 * names go through the same cleaning, so the two sides stay comparable.
 */
function cleanQuery(text) {
  return normalize(text)
    .replace(SERVED_WITH, ' ')
    .replace(NEGATED, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DISH_INDEX = RECIPES.map((recipe) => {
  // Cleaned exactly as queries are: "tomato chutney for dosa" names a chutney,
  // and left whole it made "masala dosa" look like a request for it.
  const phrases = [...new Set([recipe.name, ...(recipe.aliases || []), recipe.id.replace(/-/g, ' ')].map(cleanQuery))].filter(Boolean);
  const variants = phrases.map((phrase) => {
    const tokens = tokenize(phrase, { fuzzy: false });
    for (const t of tokens) if (!t.includes(':')) DISH_VOCABULARY.add(t);
    return { phrase, tokens, words: surfaceWords(phrase) };
  });
  return { recipe, variants };
});

function splitTokens(tokens) {
  const content = new Set(tokens.filter((t) => !t.startsWith('form:')));
  const form = new Set(tokens.filter((t) => t.startsWith('form:')));
  return { content, form };
}

/**
 * How well one name variant of a dish explains the query, 0..1.
 *
 * Content (vegetables and distinctive words such as paneer, gutti, bharta) is
 * what identifies a dish; form (curry, fry, dal) only separates dishes whose
 * content already matches. A variant whose content is not fully present in the
 * query is capped well below the confident line — "palak" alone is not "palak
 * paneer", and "curry" alone is not any curry.
 */
function scoreVariant(query, variant) {
  const q = splitTokens(query);
  const v = splitTokens(variant.tokens);
  if (q.content.size === 0) {
    // "dal", "curry", "soup" alone: a kind of dish, not a dish — list, never pick.
    return q.form.size && [...v.form].some((f) => q.form.has(f)) ? 0.6 : 0;
  }
  if (v.content.size === 0) return 0;

  let hit = 0;
  for (const t of v.content) if (q.content.has(t)) hit += 1;
  if (hit === 0) return 0;

  const recall = hit / v.content.size;
  // One word out of "onion tomato chutney for dosa" is not that dish — at
  // least half of what identifies a dish has to be asked for.
  if (recall < 0.5) return 0;
  const precision = hit / q.content.size;
  let formScore = 0.5;
  if (v.form.size && q.form.size) {
    formScore = [...v.form].some((f) => q.form.has(f)) ? 1 : 0;
  } else if (!v.form.size && q.form.size) {
    formScore = 0.4;
  }

  let score = 0.5 * recall + 0.35 * precision + 0.15 * formScore;
  if (recall < 1) score = Math.min(score, 0.7);
  // Below an exact phrase, always: a name typed in full beats a reconstruction.
  return Math.min(score, 0.97);
}

/** Query words that name nothing in the recipe book — "rajma", "upma". */
function unknownWords(text) {
  return tokenize(cleanQuery(text)).filter((t) => !t.includes(':') && !DISH_VOCABULARY.has(t));
}

/**
 * Whether the top match is clear enough to answer with that one recipe.
 *
 * A dish's own name or alias typed in full is decisive on its own: "bendakaya
 * fry" means the Andhra dish even though "bhindi fry" reconstructs to the
 * same vegetable-plus-form and scores within a point of it.
 */
function isConfidentMatch(matches) {
  const [top, second] = matches;
  if (!top || top.matchScore < 90) return false;
  if (top.exact && !second?.exact) return true;
  return !second || second.matchScore <= top.matchScore - 10;
}

/**
 * Find dishes by name, nickname or description ("gutti vankaya", "aloo gobi",
 * "bhindi masala recipe for 4"). Returns cards with `matchScore` 0..100.
 *
 * An exact phrase — a dish's name or alias appearing whole in the query — wins
 * outright, longest phrase first, so "aloo matar curry" is not answered with
 * the dry aloo matar.
 */
function containsSequence(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** A name variant that can stand as a dish on its own — not a lone vegetable or form word. */
function isNameLike(tokens) {
  return tokens.length >= 2 || (tokens.length === 1 && !tokens[0].includes(':'));
}

function findRecipesByDishName(query, { limit = 5 } = {}) {
  const norm = cleanQuery(query);
  if (!norm || norm.length < 3) return [];
  const qTokens = tokenize(norm);
  const qWords = surfaceWords(norm);

  const rows = [];
  for (const { recipe, variants } of DISH_INDEX) {
    let best = 0;
    let phraseKey = 0;
    let phraseIsDishWord = false;
    for (const variant of variants) {
      // An exact name is matched on canonical tokens, so "aloo mattar" is the
      // phrase "aloo matar" and "patta gobhi matar" is NOT "gobhi matar".
      if (isNameLike(variant.tokens) && containsSequence(qTokens, variant.tokens)) {
        // The longer exact name wins ("dry aloo matar" over "aloo matar"); at
        // equal length, one also typed word-for-word outranks one that only
        // means the same — "kakarakaya fry" and "karela fry" are both
        // bitter-gourd-fry, but whoever wrote the Telugu name wants the Andhra dish.
        const verbatim = variant.words.length > 0 && containsSequence(qWords, variant.words);
        const key = variant.tokens.length * 10 + (verbatim ? 1 : 0);
        if (key > phraseKey) {
          phraseKey = key;
          phraseIsDishWord = variant.tokens.some((t) => !t.startsWith('veg:'));
        }
        best = Math.max(best, 1);
        continue;
      }
      best = Math.max(best, scoreVariant(qTokens, variant));
    }
    if (best > 0) rows.push({ recipe, score: best, phraseKey, phraseIsDishWord });
  }

  const topKey = Math.max(0, ...rows.map((r) => r.phraseKey));
  const ranked = rows
    .map((r) => ({
      ...r,
      // A lesser exact name ("aloo matar" inside "aloo matar curry", or the
      // Hindi name when the Telugu one was typed) is still a strong match, but
      // not the winning one.
      score: r.phraseKey && r.phraseKey < topKey ? Math.min(r.score, 0.84) : r.score,
    }))
    .filter((r) => r.score >= 0.55)
    .sort((a, b) => b.score - a.score || b.phraseKey - a.phraseKey || totalMinutes(a.recipe) - totalMinutes(b.recipe));

  return ranked.slice(0, limit).map((row, index) => ({
    index: index + 1,
    id: row.recipe.id,
    name: row.recipe.name,
    cuisine: row.recipe.cuisine,
    dishType: row.recipe.type,
    difficulty: row.recipe.difficulty,
    minutes: totalMinutes(row.recipe),
    matchScore: Math.round(row.score * 100),
    exact: row.phraseKey > 0 && row.phraseKey === topKey,
    // True when the typed name says more than its vegetables ("veg clear SOUP",
    // "palak PANEER") — only then does it outrank an explicit "I have …".
    namesDish: row.phraseKey > 0 && row.phraseKey === topKey && row.phraseIsDishWord,
    covered: allVegetables(row.recipe),
    missing: [],
  }));
}

/**
 * Dishes that can be made from the vegetables a customer has.
 *
 * Ranked on the dish's MAIN vegetables — onion and tomato are in half of all
 * Indian cooking, so having them says little about which dish to cook, while
 * having okra says a great deal. A dish only qualifies if at least one of its
 * main vegetables is in hand.
 */
function listMatchingRecipes(vegetables, { limit = 5 } = {}) {
  const have = new Set((vegetables || []).map(normalizeVeg).filter(Boolean));
  if (have.size === 0) return [];

  const scored = [];
  for (const recipe of RECIPES) {
    const mains = mainVegetables(recipe);
    const all = allVegetables(recipe);
    const mainHit = mains.filter((v) => have.has(v));
    if (mainHit.length === 0) continue;
    const used = all.filter((v) => have.has(v));
    const missing = all.filter((v) => !have.has(v));
    const missingMains = mains.filter((v) => !have.has(v));
    const mainCoverage = mainHit.length / mains.length;
    const usesOfHave = used.length / have.size;
    const score = 0.6 * mainCoverage + 0.3 * usesOfHave + 0.1 * (used.length / all.length);
    scored.push({ recipe, score, used, missing, missingMains });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.missingMains.length - b.missingMains.length ||
      a.missing.length - b.missing.length ||
      totalMinutes(a.recipe) - totalMinutes(b.recipe)
  );

  return scored.slice(0, limit).map((row, index) => ({
    index: index + 1,
    id: row.recipe.id,
    name: row.recipe.name,
    cuisine: row.recipe.cuisine,
    dishType: row.recipe.type,
    difficulty: row.recipe.difficulty,
    minutes: totalMinutes(row.recipe),
    matchScore: Math.round(row.score * 100),
    covered: row.used,
    missing: row.missing,
  }));
}

/* ------------------------------------------------------------------ scaling */

function roundGrams(grams) {
  if (grams < 20) return Math.max(1, Math.round(grams));
  if (grams < 200) return Math.round(grams / 5) * 5;
  return Math.round(grams / 10) * 10;
}

function roundPantry(qty) {
  if (qty == null) return null;
  if (qty >= 10) return Math.round(qty);
  return Math.round(qty * 4) / 4;
}

function produceDisplayName(key) {
  return key;
}

function clampServings(servings) {
  return Math.min(MAX_SERVINGS, Math.max(1, Math.round(Number(servings)) || DEFAULT_SERVINGS));
}

function getRecipe(recipeId, servings = DEFAULT_SERVINGS) {
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe) return null;
  const n = clampServings(servings);

  const ingredients = recipe.ingredients.map((ing) => {
    if (ing.produce) {
      const grams = roundGrams(Number(ing.gramsPerServing) * n);
      return {
        name: ing.item,
        produce: ing.produce,
        grams,
        quantity: grams >= 1000 ? Math.round(grams / 100) / 10 : grams,
        unit: grams >= 1000 ? 'kg' : 'g',
        prep: ing.prep || null,
        role: ing.role || 'main',
        ...(ing.optional ? { optional: true } : {}),
      };
    }
    return {
      name: ing.item,
      pantry: true,
      quantity: ing.qtyPerServing == null ? null : roundPantry(Number(ing.qtyPerServing) * n),
      unit: ing.unit,
      ...(ing.optional ? { optional: true } : {}),
    };
  });

  return {
    id: recipe.id,
    name: recipe.name,
    cuisine: recipe.cuisine,
    // Not `type`: every card spreads a recipe into `{ type: 'recipe', ... }`,
    // and a field of that name would overwrite the card's own type.
    dishType: recipe.type,
    vegan: Boolean(recipe.vegan),
    difficulty: recipe.difficulty,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    minutes: totalMinutes(recipe),
    servings: n,
    servesWith: recipe.servesWith || null,
    vegetables: allVegetables(recipe).map(produceDisplayName),
    ingredients,
    steps: recipe.steps,
    tips: recipe.tips || [],
  };
}

/**
 * Meat, egg or fish asked FOR.
 *
 * Vegetable PHRASES are blanked first, so "egg plant" cannot read as egg — but
 * the fuzzy pass is deliberately skipped, because it is one letter from turning
 * a meat word into produce: `keema` (minced meat) became `keera`, a cucumber,
 * and the request was answered with a vegetable dish. Negated spans are already
 * gone, so "veg cutlet without egg" is a vegetarian request.
 */
function isNonVegRequest(text) {
  let masked = ` ${cleanQuery(text)} `;
  for (const [alias] of PRODUCE_ALIASES) {
    const needle = ` ${alias} `;
    while (masked.includes(needle)) masked = masked.replace(needle, ' - ');
  }
  return NONVEG.test(masked);
}

module.exports = {
  RECIPES,
  PRODUCE,
  DEFAULT_SERVINGS,
  normalize,
  cleanQuery,
  surfaceWords,
  tokenize,
  normalizeVeg,
  extractVegetables,
  listMatchingRecipes,
  findRecipesByDishName,
  getRecipe,
  clampServings,
  isNonVegRequest,
  isConfidentMatch,
  unknownWords,
  mainVegetables,
};
