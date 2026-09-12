import React from 'react';
import { ArrowLeft, Camera, Package, Plus, Search, ShieldAlert } from 'lucide-react';

/**
 * Shopkeeper shared-catalog picker — same visual language as the customer
 * aisle cards (warm frame, skeuo surface), not a grey admin table.
 *
 * Flow: categories → items in that aisle → parent opens the price/stock step.
 * Search jumps straight to a flat item grid.
 */
export default function CatalogBrowseScreen({
  categories = [],
  items = [],
  search,
  onSearchChange,
  categoryFilter,
  onCategoryFilterChange,
  busy = false,
  canUpdateStock = true,
  onBack,
  onPick,
  onCustom,
  onOpenKyc,
  kycBanner = null,
}) {
  const query = search.trim().toLowerCase();
  const showingAisles = !query && categoryFilter === 'all';

  const groups = categories
    .map((cat) => ({
      category: cat,
      items: items.filter((item) => Number(item.categoryId) === Number(cat.id)),
    }))
    .filter((g) => g.items.length > 0);

  const activeCategory = groups.find((g) => String(g.category.id) === String(categoryFilter));
  const scoped = activeCategory && !query ? activeCategory.items : items;
  const gridItems = query
    ? scoped.filter((item) => {
        const hay = `${item.name || ''} ${item.weight || ''}`.toLowerCase();
        return hay.includes(query);
      })
    : scoped;

  const title = showingAisles
    ? 'Choose an aisle'
    : query
      ? 'Search results'
      : activeCategory
        ? activeCategory.category.title
        : 'Catalog';

  const subtitle = showingAisles
    ? `${items.length} ready-to-add products`
    : `${gridItems.length} item${gridItems.length === 1 ? '' : 's'}`;

  const handleBack = () => {
    if (!showingAisles && (categoryFilter !== 'all' || query)) {
      onSearchChange('');
      onCategoryFilterChange('all');
      return;
    }
    onBack();
  };

  const handlePick = (item) => {
    if (!canUpdateStock) {
      onOpenKyc?.();
      return;
    }
    onPick(item);
  };

  return (
    <div className="animate-fade-in min-h-[70vh] bg-[#F8F5EF]">
      <div className="sticky top-0 z-20 bg-[#F8F5EF]/95 backdrop-blur-md border-b border-[#E5DFD1] px-4 pt-3 pb-3 space-y-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleBack}
            className="p-2 rounded-full bg-[#FFFDF9] border border-[#E0D9C8] shadow-xs"
            aria-label="Back"
          >
            <ArrowLeft className="w-5 h-5 text-[#1B4D3E]" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="font-vintage font-bold text-lg text-[#1B4D3E] tracking-tight leading-tight truncate">
              {title}
            </h2>
            <p className="text-[11.5px] font-semibold text-[#6B6560]">{subtitle}</p>
          </div>
        </div>

        {kycBanner}

        <div className="relative">
          <Search className="w-4 h-4 text-[#9A948A] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search spinach, tomato…"
            className="w-full bg-[#FFFDF9] border border-[#E0D9C8] rounded-2xl pl-10 pr-3 py-2.5 font-semibold text-sm text-[#2D2A26] outline-none focus:border-[#1B4D3E] shadow-xs placeholder:text-[#A89F92]"
          />
        </div>
      </div>

      <div className="px-4 pt-4 pb-28 space-y-4">
        {showingAisles ? (
          <div className="grid grid-cols-1 gap-3">
            {groups.map(({ category, items: aisleItems }, idx) => (
              <button
                key={category.id}
                type="button"
                onClick={() => onCategoryFilterChange(String(category.id))}
                className="skeuo-card-interactive ripple-effect rounded-2xl overflow-hidden text-left flex items-stretch animate-fade-in"
                style={{ animationDelay: `${idx * 60}ms` }}
              >
                <div className="w-[88px] shrink-0 bg-[#F3EFE6] border-r border-[#E5DFD1]">
                  {category.imageUrl ? (
                    <img
                      src={category.imageUrl}
                      alt=""
                      className="w-full h-full min-h-[88px] object-cover"
                    />
                  ) : (
                    <div className="w-full h-full min-h-[88px] flex items-center justify-center">
                      <Package className="w-7 h-7 text-[#C4BBA8]" />
                    </div>
                  )}
                </div>
                <div className="flex-1 p-3.5 flex flex-col justify-center min-w-0">
                  <h3 className="font-vintage font-bold text-[15px] text-[#23201C] truncate">
                    {category.title}
                  </h3>
                  {category.badge && (
                    <span className="mt-1 inline-block w-fit text-[10.5px] font-bold text-[#1B4D3E] bg-[#EAE4D7] px-1.5 py-0.5 rounded-md border border-[#D5CDBC]">
                      {category.badge}
                    </span>
                  )}
                  <p className="mt-1.5 text-[12.5px] font-extrabold text-[#1B4D3E]">
                    {aisleItems.length} products ›
                  </p>
                </div>
              </button>
            ))}
            {groups.length === 0 && !busy && (
              <EmptyState
                title="Catalog is empty"
                body="No shared products are available yet."
              />
            )}
          </div>
        ) : (
          <>
            {busy && gridItems.length === 0 && (
              <div className="grid grid-cols-2 gap-3">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeuo-card rounded-2xl p-2.5 h-[200px] animate-pulse">
                    <div className="h-24 rounded-xl bg-[#EAE4D7] mb-2" />
                    <div className="h-3 bg-[#EAE4D7] rounded w-4/5 mb-2" />
                    <div className="h-2.5 bg-[#EAE4D7] rounded w-1/3" />
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {gridItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handlePick(item)}
                  className="skeuo-card-interactive rounded-2xl p-2.5 text-left flex flex-col h-[210px] group"
                >
                  <div className="relative mb-1.5">
                    <div className="w-full h-24 rounded-xl overflow-hidden bg-[#F3EFE6] border border-[#E5DFD1] shadow-inner">
                      {item.image ? (
                        <img
                          src={item.image}
                          alt=""
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Camera className="w-6 h-6 text-[#C4BBA8]" />
                        </div>
                      )}
                    </div>
                    {item.weight && (
                      <span className="absolute bottom-1 right-1 bg-[#FFFDF9]/95 backdrop-blur-xs px-1.5 py-0.5 rounded-md text-[10px] font-bold text-[#2D2A26] border border-[#E0D9C8]">
                        {item.weight}
                      </span>
                    )}
                  </div>
                  <h3 className="font-semibold text-xs text-[#2D2A26] line-clamp-2 leading-snug group-hover:text-[#1B4D3E] transition-colors flex-1">
                    {item.name}
                  </h3>
                  <span className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-extrabold text-[#0B7A37]">
                    <Plus className="w-3.5 h-3.5" />
                    {canUpdateStock ? 'Add' : 'Verify to add'}
                  </span>
                </button>
              ))}
            </div>

            {!busy && gridItems.length === 0 && (
              <EmptyState
                title="No matches"
                body="Try another search, or add a custom product below."
              />
            )}
          </>
        )}
      </div>

      <div className="fixed bottom-[4.75rem] left-1/2 -translate-x-1/2 w-full max-w-md px-4 z-30">
        <button
          type="button"
          onClick={() => {
            if (!canUpdateStock) {
              onOpenKyc?.();
              return;
            }
            onCustom();
          }}
          className="w-full py-3 text-[13px] font-extrabold text-[#1B4D3E] bg-[#FFFDF9] border border-[#D5CDBC] rounded-2xl shadow-md"
        >
          Not listed? Add a custom product
        </button>
      </div>
    </div>
  );
}

function EmptyState({ title, body }) {
  return (
    <div className="text-center py-14 px-6">
      <div className="w-14 h-14 rounded-2xl bg-[#EAE4D7] border border-[#D5CDBC] flex items-center justify-center mx-auto mb-3">
        <Package className="w-7 h-7 text-[#1B4D3E]" />
      </div>
      <p className="font-vintage font-bold text-[#1B4D3E] text-base">{title}</p>
      <p className="text-xs font-semibold text-[#6B6560] mt-1 leading-relaxed">{body}</p>
    </div>
  );
}

/** Compact KYC strip for the cream catalog surface. */
export function CatalogKycStrip({ kyc, onOpenKyc }) {
  if (!kyc || kyc.canUpdateStock) return null;
  const isPending = kyc.status === 'penny_sent';
  return (
    <button
      type="button"
      onClick={onOpenKyc}
      className="w-full text-left bg-[#FFF8E8] border border-[#E8D4A8] rounded-2xl p-3 flex items-start gap-2.5 active:scale-[0.99] transition-transform"
    >
      <ShieldAlert className="w-4.5 h-4.5 text-amber-700 shrink-0 mt-0.5" />
      <div>
        <p className="font-extrabold text-xs text-amber-950">
          {isPending ? 'Confirm your UPI amount' : 'Verify to list products'}
        </p>
        <p className="text-[11px] font-semibold text-amber-900/80 mt-0.5 leading-snug">
          {isPending
            ? 'Enter the exact amount we sent, then come back to add stock.'
            : 'Bank details + a small UPI check unlocks adding to your shop.'}
        </p>
      </div>
    </button>
  );
}
