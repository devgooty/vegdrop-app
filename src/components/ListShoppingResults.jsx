import React, { useMemo } from 'react';
import { ArrowLeft, SearchX, ChevronRight } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { searchProducts } from '../services/search';
import ProductGridCard from './ProductGridCard';

/**
 * The written list, answered with what the shop actually sells.
 *
 * A notepad line is freeform text — "tomato", "get onions" — and on its own it
 * cannot be bought. This screen is the bridge: it runs each line through the
 * same `searchProducts` the search box uses, and shows the matches as a row
 * per line, so a list someone dictated in ten seconds becomes a cart without
 * them searching for each item by hand.
 *
 * Matching is deliberately NOT re-implemented here. Sharing `searchProducts`
 * with the header's own results screen is what makes "See All" land on the
 * same set this row is showing a slice of — two matchers would drift, and the
 * row would promise products the full screen then failed to list.
 *
 * The card is likewise `ProductGridCard`, not a fourth copy of the weight and
 * stock arithmetic: that component's own comment records that there were once
 * two of those and they had already disagreed about the stock cap.
 */
export default function ListShoppingResults({
  notes = [],
  products = [],
  categories = [],
  cartItems = [],
  onAddToCart,
  onUpdateQuantity,
  onSelectProduct,
  onSeeAll,
  onBack,
}) {
  const { t } = useLanguage();

  /**
   * One search per line, in list order. Keyed on the note text rather than the
   * note id, so editing a line re-searches while merely ticking one off does
   * not throw away results already on screen.
   */
  const sections = useMemo(
    () =>
      notes.map((note) => ({
        note,
        matches: searchProducts({ products, categories, query: note.text }).slice(0, 12),
      })),
    [notes, products, categories]
  );

  const foundCount = sections.filter((s) => s.matches.length > 0).length;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center z-[210] animate-fade-in">
      <div className="bg-[#F4F6F5] w-full max-w-md h-[100dvh] flex flex-col shadow-2xl overflow-hidden animate-slide-up">
        {/* Header: what this screen is, and how much of the list it answered. */}
        <div className="shrink-0 bg-white border-b border-slate-100 px-4 pt-safe-3 pb-3 flex items-center gap-3 z-10">
          <button
            onClick={onBack}
            aria-label={t('common.back')}
            className="shrink-0 p-2 -ml-1 rounded-xl text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer active:scale-95"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h2 className="font-black text-[#123B2F] text-base leading-tight">{t('listResults.title')}</h2>
            <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">
              {t('listResults.matched', { found: foundCount, total: sections.length })}
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {sections.map(({ note, matches }) => (
            <section key={note.id} className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
                <h3 className="text-[13px] font-semibold text-slate-400 truncate">
                  {t('listResults.resultsFor')}{' '}
                  <span className="font-black text-slate-800">“{note.text}”</span>
                </h3>

                {matches.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onSeeAll?.(note.text)}
                    className="shrink-0 flex items-center gap-0.5 text-[12.5px] font-black text-[#1B4D3E] hover:underline cursor-pointer"
                  >
                    {t('listResults.seeAll')}
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {matches.length === 0 ? (
                /*
                  A line the catalog cannot answer still gets a row. Silently
                  dropping it would leave someone counting the sections against
                  their list to work out which item this market does not carry.
                */
                <div className="px-4 pb-4 flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl bg-slate-50 text-slate-300 flex items-center justify-center shrink-0">
                    <SearchX className="w-5 h-5" />
                  </span>
                  <p className="text-[12.5px] font-bold text-slate-400 leading-snug">
                    {t('listResults.noMatch')}
                  </p>
                </div>
              ) : (
                /*
                  Horizontal, not a wrapped grid: each line owns one row, so the
                  eye runs down the list the way it was written and a long
                  catalog answer never buries the next item off the screen.
                */
                <div className="flex gap-2.5 overflow-x-auto no-scrollbar snap-x px-4 pb-4">
                  {matches.map((product) => (
                    <div key={product.id} className="w-[9.75rem] shrink-0 snap-start">
                      <ProductGridCard
                        item={product}
                        category={categories.find((c) => c.id === product.categoryId)}
                        cartItems={cartItems}
                        onAddToCart={onAddToCart}
                        onUpdateQuantity={onUpdateQuantity}
                        onSelectProduct={onSelectProduct}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
