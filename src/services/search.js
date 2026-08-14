/**
 * Catalog search — suggestion building and result matching.
 *
 * Pure functions over the in-memory catalog, deliberately kept out of the
 * components: the header renders suggestions and the results screen renders
 * matches, but neither should own the notion of what "matches" means, or the
 * two would drift and a suggestion would stop leading to its own results.
 *
 * There is no search endpoint. The whole catalog is already in memory (it is a
 * few dozen products), so matching locally is instant and works offline, which
 * is the mode the app degrades to. If the catalog ever grows past the point
 * where scanning it per keystroke is cheap, this is the seam to move server
 * side — the components only ever call the two exported entry points.
 */

/**
 * Fold a string down to something comparable: lowercase, accents removed,
 * punctuation flattened to spaces.
 *
 * Punctuation has to go rather than be preserved, because product names carry
 * it in ways a shopper never types — "Organic Spinach (Palak)" has to be
 * reachable by "palak", and "Coriander/Dhania" by "dhania".
 *
 * The output is limited to [a-z0-9 ], which is what lets the scorer below use
 * plain index arithmetic instead of a RegExp built from user input.
 */
export function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Words that are real parts of a name but useless as a suggestion of their own:
 * every third product is "fresh" something, so offering "Fresh" as a term just
 * pushes the word the shopper actually meant off the list.
 *
 * These are only suppressed as *standalone* terms. They still match inside a
 * full name, so searching "fresh kale" still works.
 */
const WEAK_TERMS = new Set([
  'fresh', 'organic', 'premium', 'natural', 'farm', 'pack', 'packet', 'bunch',
  'box', 'bag', 'piece', 'pieces', 'pcs', 'and', 'the', 'with', 'for', 'of',
]);

/** Significant words of a name, in the casing the catalog used. */
function significantWords(name) {
  return String(name ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => {
      const key = normalize(word);
      return key.length >= 3 && !WEAK_TERMS.has(key) && !/^\d+$/.test(key);
    });
}

/**
 * How well a label answers the query, lower being better. `null` means no match.
 *
 * The tiers are what make the list feel predictable: an exact hit, then things
 * that start with what was typed, then things where a *word* starts with it,
 * and only then a match buried mid-word. Without the word-boundary tier,
 * typing "man" ranks "Edamame Beans" alongside "Mango".
 */
function score(label, normalizedQuery) {
  const haystack = normalize(label);
  const at = haystack.indexOf(normalizedQuery);

  if (at === -1) return null;
  if (haystack === normalizedQuery) return 0;
  if (at === 0) return 1;
  if (haystack[at - 1] === ' ') return 2;
  return 3;
}

/**
 * Suggestions for a partially typed query.
 *
 * Two kinds come back, and they behave differently when picked:
 *
 *   `category` — a section of the shop, which opens that section
 *   `term`     — a name to search for, which opens the results screen
 *
 * A term carries every product it matches, so the row can show a count and the
 * caller can open results without matching a second time. Terms are drawn from
 * whole product names *and* from the significant words inside them, which is
 * what makes "spinach" a suggestion in its own right when no product is called
 * exactly that.
 */
export function buildSuggestions({ products = [], categories = [], query, limit = 8 }) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  const terms = new Map();

  const addTerm = (label, product) => {
    const key = normalize(label);
    if (key.length < 2) return;

    let entry = terms.get(key);
    if (!entry) {
      entry = { key, kind: 'term', label, products: [] };
      terms.set(key, entry);
    }
    // Products are pushed in catalog order and each appears once, so a term's
    // count is the number of distinct options behind it.
    if (!entry.products.includes(product)) entry.products.push(product);
  };

  for (const product of products) {
    addTerm(product.name, product);
    for (const word of significantWords(product.name)) addTerm(word, product);
  }

  const suggestions = [];

  // Categories first, so a section wins the key when its title collides with a
  // word from a product name ("Exotic & Herbs" vs. a product's "Herbs"):
  // opening the section is the more useful of the two.
  for (const category of categories) {
    const rank = score(category.title, normalizedQuery);
    if (rank === null) continue;

    // A section this market stocks nothing in is not an answer to anything, and
    // offering it is actively harmful: the row below deletes the same-named
    // term, so a "Onion" section holding no products would both open an empty
    // screen *and* take the term that had the actual onions behind it. Leave
    // the term standing instead.
    const count = products.filter((p) => p.categoryId === category.id).length;
    if (count === 0) continue;

    terms.delete(normalize(category.title));
    suggestions.push({
      id: `category:${category.id}`,
      kind: 'category',
      label: category.title,
      category,
      count,
      rank,
    });
  }

  for (const entry of terms.values()) {
    const rank = score(entry.label, normalizedQuery);
    if (rank === null) continue;

    suggestions.push({
      id: `term:${entry.key}`,
      kind: 'term',
      label: entry.label,
      products: entry.products,
      count: entry.products.length,
      rank,
    });
  }

  return suggestions
    .sort((a, b) =>
      a.rank - b.rank ||
      // More options behind a term makes it the more likely intent, and a
      // shorter label is the more general one — "Mango" above "Mango Pickle".
      b.count - a.count ||
      a.label.length - b.label.length ||
      a.label.localeCompare(b.label)
    )
    .slice(0, limit);
}

/**
 * Every product answering a query — the "all available options" a picked
 * suggestion opens.
 *
 * Category titles are matched as well as product names so that submitting a
 * section's name from the search box finds its contents, rather than returning
 * nothing because no product happens to repeat the section's name.
 */
export function searchProducts({ products = [], categories = [], query }) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  const titleById = new Map(categories.map((category) => [category.id, category.title]));

  return products
    .map((product) => {
      const byName = score(product.name, normalizedQuery);
      const byCategory = score(titleById.get(product.categoryId), normalizedQuery);
      if (byName === null && byCategory === null) return null;

      // A name match always outranks a category match: someone searching
      // "greens" wants the leaf, not all 12 things filed under Leafy Greens.
      return { product, rank: byName ?? byCategory + 4 };
    })
    .filter(Boolean)
    .sort((a, b) =>
      a.rank - b.rank ||
      (b.product.rating ?? 0) - (a.product.rating ?? 0) ||
      a.product.name.localeCompare(b.product.name)
    )
    .map((hit) => hit.product);
}
