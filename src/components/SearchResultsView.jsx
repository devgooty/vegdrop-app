import React, { useMemo, useState } from 'react';
import { ArrowLeft, Search, Filter, SearchX } from 'lucide-react';
import ProductGridCard from './ProductGridCard';
import { searchProducts } from '../services/search';
import { dedupeByCatalogItem } from '../services/products';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * Everything the shop stocks under one name — what picking a suggestion opens.
 *
 * The query is owned by App, not by this screen, so the header search box and
 * the box here are the same value: editing either refines the same result set
 * instead of leaving two search terms on screen disagreeing about what is being
 * shown.
 *
 * Matching is delegated to services/search so a suggestion always leads to its
 * own results. Sorting and the organic filter are local — they are how this
 * screen is read, not what it is about, and resetting them per search is the
 * behaviour a shopper expects.
 */
export default function SearchResultsView({
  query,
  onQueryChange,
  products,
  categories,
  cartItems,
  onAddToCart,
  onUpdateQuantity,
  onSelectProduct,
  onBack,
}) {
  const { t } = useLanguage();
  const [filterOrganic, setFilterOrganic] = useState(false);
  const [sortBy, setSortBy] = useState('relevance');

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories]
  );

  const results = useMemo(() => {
    // Already ordered by relevance, so 'relevance' is the absence of a sort
    // rather than a comparator of its own. Deduped after, not before: collapsing
    // stall duplicates preserves whichever survivor came first in that order.
    let found = dedupeByCatalogItem(searchProducts({ products, categories, query }));

    if (filterOrganic) found = found.filter((p) => p.isOrganic);

    if (sortBy === 'price-low') found = [...found].sort((a, b) => a.price - b.price);
    else if (sortBy === 'price-high') found = [...found].sort((a, b) => b.price - a.price);
    else if (sortBy === 'rating') found = [...found].sort((a, b) => b.rating - a.rating);

    return found;
  }, [products, categories, query, filterOrganic, sortBy]);

  const trimmedQuery = query.trim();

  return (
    <div className="min-h-screen bg-[#F6F3EC] flex flex-col pb-20 animate-fade-in">
      <header className="bg-[#FAF7F2] p-3 pt-safe-3 shadow-xs sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-[#DCD5C6]">
        <button
          onClick={onBack}
          className="skeuo-btn-light p-1 px-2.5 rounded-full transition-all flex items-center gap-1 text-xs font-bold cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5 text-[#1B4D3E]" />
          <span>{t('common.back')}</span>
        </button>

        <h1 className="font-vintage font-extrabold text-sm text-[#1B4D3E] truncate tracking-tight">
          {t('search.resultsFor', { query: trimmedQuery })}
        </h1>

        <span className="bg-[#EAE4D7] text-[#1B4D3E] text-[11.5px] font-bold px-2 py-0.5 rounded-full border border-[#D5CDBC] shadow-2xs shrink-0">
          {results.length === 1
            ? t('search.itemOne')
            : t('search.itemCount', { count: results.length })}
        </span>
      </header>

      {/* Refine — same value as the header box, so there is one query, not two */}
      <div className="p-4 py-3 space-y-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 relative">
            <label htmlFor="search-results-query" className="sr-only">{t('search.refine')}</label>
            <input
              id="search-results-query"
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={t('search.wholeShop')}
              className="w-full skeuo-inset-input rounded-full py-1.5 pl-8 pr-3 text-xs font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
            />
            <Search className="w-3.5 h-3.5 text-[#8A7E6B] absolute left-2.5 top-2" />
          </div>

          <button
            onClick={() => setFilterOrganic(!filterOrganic)}
            aria-pressed={filterOrganic}
            className={`px-2.5 py-1.5 rounded-full text-[12.5px] font-bold border transition-all cursor-pointer flex-shrink-0 ${
              filterOrganic ? 'skeuo-btn-emerald' : 'skeuo-btn-light'
            }`}
          >
            {t('search.organic')}
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-[#7A7060]">
          <span className="font-semibold text-[#2D2A26] text-[12.5px]">
            {results.length === 1
              ? t('search.showingOne')
              : t('search.showing', { count: results.length })}
          </span>
          <div className="flex items-center gap-1">
            <Filter className="w-3 h-3 text-[#8A7E6B]" />
            <label htmlFor="search-results-sort" className="sr-only">{t('search.sort')}</label>
            <select
              id="search-results-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-transparent font-bold text-[#1B4D3E] text-[12.5px] focus:outline-none cursor-pointer"
            >
              <option value="relevance">{t('search.bestMatch')}</option>
              <option value="price-low">{t('search.priceLowHigh')}</option>
              <option value="price-high">{t('search.priceHighLow')}</option>
              <option value="rating">{t('search.topRated')}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="px-4 grid grid-cols-2 gap-3 items-start pb-6">
        {results.length === 0 ? (
          <div className="col-span-2 skeuo-card rounded-2xl p-8 text-center">
            <SearchX className="w-10 h-10 mx-auto mb-3 text-[#C9C0AC]" aria-hidden="true" />
            <p className="text-[#2D2A26] text-sm font-bold">
              {t('search.nothingMatching', { query: trimmedQuery })}
            </p>
            <p className="text-[#8A7E6B] text-xs font-medium mt-1">
              {filterOrganic ? t('search.tryWithoutOrganic') : t('search.checkSpelling')}
            </p>
          </div>
        ) : (
          results.map((item) => (
            <ProductGridCard
              key={item.id}
              item={item}
              category={categoryById.get(item.categoryId)}
              cartItems={cartItems}
              onAddToCart={onAddToCart}
              onUpdateQuantity={onUpdateQuantity}
              onSelectProduct={onSelectProduct}
            />
          ))
        )}
      </div>
    </div>
  );
}
