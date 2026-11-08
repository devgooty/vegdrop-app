import { describe, it, expect } from 'vitest';
import { normalize, buildSuggestions, searchProducts, popularSearchTerms } from './search';

/**
 * Search, in the three languages the catalog is named in.
 *
 * The rows are the seeded catalog's real names and translations
 * (server/utils/seed.js, server/utils/productTranslations.js). Searching used
 * to keep `[a-z0-9]` only, so a Telugu or Hindi query folded to nothing and
 * found nothing, and only the English name was ever indexed.
 */

const row = (id, name, nameTe, nameHi, extra = {}) => ({ id, name, nameTe, nameHi, categoryId: 2, stock: 10, ...extra });

const PRODUCTS = [
  row('tomato', 'Desi Tomatoes (Tamatar)', 'టమాటా', 'टमाटर'),
  row('okra', 'Fresh Okra (Bhindi)', 'బెండకాయ', 'भिंडी'),
  row('potato', 'Fresh Potato (Aloo)', 'బంగాళాదుంప', 'आलू'),
  row('sweetpotato', 'Sweet Potato (Shakarkandi)', 'చిలగడదుంప', 'शकरकंद'),
  row('spinach', 'Organic Spinach (Palak)', 'పాలకూర', 'पालक'),
  row('mango', 'Mango', '', ''),
  row('edamame', 'Edamame Beans', '', ''),
];

const ids = (list) => list.map((p) => p.id);

describe('normalize', () => {
  it('folds English as it always did', () => {
    expect(normalize('  Organic Spinach (Palak)! ')).toBe('organic spinach palak');
    expect(normalize('Jalapeño')).toBe('jalapeno');
  });

  it('keeps Telugu and Devanagari instead of erasing them', () => {
    expect(normalize('టమాటా')).toBe('టమాటా');
    expect(normalize('टमाटर।')).toBe('टमाटर');
    expect(normalize('బీట్‌రూట్')).toBe(normalize('బీట్రూట్'));
  });
});

describe('searchProducts', () => {
  it('finds a product by its Telugu or Hindi name', () => {
    expect(ids(searchProducts({ products: PRODUCTS, query: 'టమాటా' }))).toEqual(['tomato']);
    expect(ids(searchProducts({ products: PRODUCTS, query: 'బెండ' }))).toEqual(['okra']);
    expect(ids(searchProducts({ products: PRODUCTS, query: 'आलू' }))).toEqual(['potato']);
    expect(ids(searchProducts({ products: PRODUCTS, query: 'पालक' }))).toEqual(['spinach']);
  });

  it('still finds English names and the bracketed Hindi alias', () => {
    expect(ids(searchProducts({ products: PRODUCTS, query: 'potato' }))).toEqual(['potato', 'sweetpotato']);
    expect(ids(searchProducts({ products: PRODUCTS, query: 'palak' }))).toEqual(['spinach']);
  });

  it('finds nothing for nothing', () => {
    expect(searchProducts({ products: PRODUCTS, query: '' })).toEqual([]);
    expect(searchProducts({ products: PRODUCTS, query: '!!' })).toEqual([]);
  });
});

describe('buildSuggestions', () => {
  it('suggests from Telugu and Hindi names', () => {
    const te = buildSuggestions({ products: PRODUCTS, query: 'టమా' });
    expect(te[0]).toMatchObject({ kind: 'term', label: 'టమాటా' });
    expect(ids(te[0].products)).toEqual(['tomato']);

    const hi = buildSuggestions({ products: PRODUCTS, query: 'भिं' });
    expect(hi[0]).toMatchObject({ kind: 'term', label: 'भिंडी' });
  });

  it('keeps the word-start tier for English', () => {
    // "man" must rank Mango above Edamame, as it always has.
    const labels = buildSuggestions({ products: PRODUCTS, query: 'man' }).map((s) => s.label);
    expect(labels[0]).toBe('Mango');
  });
});

describe('popularSearchTerms', () => {
  it('offers the names in the shopper’s language', () => {
    // These were skipped entirely: a Telugu name folded to "" and was dropped
    // as a duplicate of nothing, so the chips were empty in Telugu and Hindi.
    expect(popularSearchTerms({ products: PRODUCTS, language: 'te', limit: 3 })).toEqual(['టమాటా', 'బెండకాయ', 'బంగాళాదుంప']);
    expect(popularSearchTerms({ products: PRODUCTS, language: 'hi', limit: 2 })).toEqual(['टमाटर', 'भिंडी']);
  });
});
