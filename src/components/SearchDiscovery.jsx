import React, { useMemo } from 'react';
import { ChevronRight, Plus, Star, Check, Clock3, TrendingUp } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { popularSearchTerms, readRecentSearches } from '../services/search';

/**
 * What the search screen shows before anything has been typed.
 *
 * Tapping the search field used to do nothing at all: the suggestion panel in
 * `Header` opens only once there is a query (`onFocus={() => { if (query) … }}`)
 * and `SearchResultsView` renders only when `searchQuery` is set, so an empty
 * field left the shopper looking at the home screen with a keyboard over it.
 * This fills that moment with the catalogue instead of a blank.
 *
 * **Every row is derived, never curated by hand.** A hardcoded row of "our
 * picks" goes stale the first time a product sells out or leaves the market's
 * sheet, and this screen is rendered from `products` — which is already scoped
 * to the chosen market, so it cannot advertise something that market does not
 * sell. Rows with nothing in them are dropped rather than rendered empty.
 *
 * **No row promises a delivery time**, though the app this pattern came from
 * puts one on every card. The hero banners had exactly that claim removed;
 * putting "15 min" back on a hundred product cards would reintroduce it in the
 * one place nobody would think to look.
 */

/** Discount as a whole percent, or null when there is nothing to shout about. */
function discountPercent(product) {
  const old = Number(product?.oldPrice);
  const now = Number(product?.price);
  if (!Number.isFinite(old) || !Number.isFinite(now) || old <= now || now <= 0) return null;
  return Math.round(((old - now) / old) * 100);
}

function inStock(product) {
  return product?.isActive !== false && Number(product?.stock ?? 0) > 0;
}

/**
 * One product, sized for a horizontal rail rather than the home grid.
 *
 * The + control sits on the photograph, bottom-right — the quick-commerce
 * register this screen is copying. At this card width an overlaid button still
 * leaves most of the produce visible; tucking it under the image, which this
 * app used to do, read as a different product altogether.
 */
function RailCard({ product, qty, onAdd, onOpen, t, language }) {
  const off = discountPercent(product);
  const name = (language === 'hi' && product.nameHi) || (language === 'te' && product.nameTe) || product.name;

  return (
    <div className="w-[9.5rem] shrink-0 bg-white border border-[#E7E1D5] rounded-2xl p-2 flex flex-col gap-1.5 shadow-xs">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen?.(product)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen?.(product);
          }
        }}
        className="relative block w-full aspect-square rounded-xl overflow-hidden bg-[#F7F3EC] cursor-pointer"
      >
        <img
          src={product.image}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
        />
        {off !== null && (
          <span className="absolute top-1.5 left-1.5 bg-[#1B4D3E] text-white text-[9px] font-black px-1.5 py-0.5 rounded-md">
            {t('discovery.percentOff', { n: off })}
          </span>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdd?.(product);
          }}
          disabled={!inStock(product)}
          aria-label={t('discovery.addNamed', { name })}
          className={`absolute bottom-1.5 right-1.5 w-8 h-8 rounded-lg flex items-center justify-center shadow-md transition-all active:scale-90 ${
            !inStock(product)
              ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
              : qty > 0
                ? 'bg-[#1B4D3E] text-white cursor-pointer'
                : 'bg-white border-2 border-[#1B4D3E] text-[#1B4D3E] hover:bg-[#1B4D3E] hover:text-white cursor-pointer'
          }`}
        >
          {qty > 0 ? <Check className="w-4 h-4 stroke-[3]" /> : <Plus className="w-4 h-4 stroke-[3]" />}
        </button>
      </div>

      {Number(product.rating) > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] font-bold text-[#2D2A26] -mt-0.5">
          <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
          {product.rating}
          {Number(product.reviews) > 0 && (
            <span className="text-[#9A8F7C] font-semibold">
              ({product.reviews >= 1000 ? `${(product.reviews / 1000).toFixed(1)}k` : product.reviews})
            </span>
          )}
        </span>
      )}

      <div className="min-w-0">
        <p className="text-[11px] font-bold text-[#2D2A26] leading-tight line-clamp-2">{name}</p>
        {product.weight && (
          <span className="inline-block mt-1 text-[9px] font-bold text-[#8A7E6B] border border-[#E7E1D5] rounded px-1 py-px">
            {product.weight}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-black text-[#2D2A26]">₹{product.price}</span>
        {off !== null && (
          <span className="text-[10px] font-semibold text-[#9A8F7C] line-through">₹{product.oldPrice}</span>
        )}
      </div>
    </div>
  );
}

function Rail({ title, items, onSeeAll, qtyOf, t, ...cardProps }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-4">
        <h3 className="font-black text-[#2D2A26] text-[15px] tracking-tight leading-tight">{title}</h3>
        {onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            className="flex items-center gap-0.5 text-[11px] font-black text-[#1B4D3E] hover:underline cursor-pointer shrink-0"
          >
            {t('discovery.seeAll')}
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {/*
        The row is padded rather than inset so the last card can sit half off
        the right edge — that overhang is the only thing telling a shopper the
        row scrolls, since a touch device shows no scrollbar.
      */}
      <div className="flex gap-2 overflow-x-auto pb-1 px-4 scrollbar-none">
        {items.map((product) => (
          <RailCard
            key={product.id || product._id}
            product={product}
            qty={qtyOf(product)}
            t={t}
            {...cardProps}
          />
        ))}
      </div>
    </section>
  );
}

function ChipRow({ icon: Icon, label, items, onPick }) {
  if (!items.length) return null;
  return (
    <section className="px-4 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-[#8A7E6B]">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((term) => (
          <button
            key={term}
            type="button"
            onClick={() => onPick(term)}
            className="px-3 py-1.5 rounded-full bg-white border border-[#E0D9C8] text-[12px] font-bold text-[#2D2A26] shadow-xs active:scale-95 cursor-pointer"
          >
            {term}
          </button>
        ))}
      </div>
    </section>
  );
}

export default function SearchDiscovery({
  products = [],
  categories = [],
  cartItems = [],
  onAddToCart,
  onSelectProduct,
  onOpenCategory,
  onSearchTerm,
}) {
  const { t, language } = useLanguage();

  const qtyOf = useMemo(() => {
    const map = new Map();
    for (const line of cartItems) {
      const key = line.id || line._id || line.productId;
      if (key) map.set(String(key), (map.get(String(key)) || 0) + (line.quantity || 0));
    }
    return (product) => map.get(String(product.id || product._id)) || 0;
  }, [cartItems]);

  const available = useMemo(() => products.filter(inStock), [products]);

  const rails = useMemo(() => {
    const byDiscount = available
      .filter((p) => discountPercent(p) !== null)
      .sort((a, b) => discountPercent(b) - discountPercent(a))
      .slice(0, 12);

    const topRated = available
      .filter((p) => Number(p.rating) >= 4.5)
      .sort((a, b) => Number(b.rating) - Number(a.rating))
      .slice(0, 12);

    // Two category rails, chosen by how much of the market's sheet each holds
    // rather than by position — a category with three items reads as a mistake.
    const counts = new Map();
    for (const p of available) counts.set(p.categoryId, (counts.get(p.categoryId) || 0) + 1);
    const catRails = [...counts.entries()]
      .filter(([, n]) => n >= 4)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([categoryId]) => {
        const category = categories.find((c) => c.id === categoryId);
        return {
          key: `cat-${categoryId}`,
          title: category ? t(category.labelKey || '') || category.name : null,
          items: available.filter((p) => p.categoryId === categoryId).slice(0, 12),
          category,
        };
      })
      .filter((r) => r.title);

    return [
      { key: 'deals', title: t('discovery.bestDeals'), items: byDiscount },
      { key: 'rated', title: t('discovery.topRated'), items: topRated },
      ...catRails,
    ].filter((r) => r.items.length > 0);
  }, [available, categories, t]);

  const cardProps = { onAdd: onAddToCart, onOpen: onSelectProduct, t, language };

  const recent = useMemo(() => readRecentSearches(), []);
  const popular = useMemo(
    () => popularSearchTerms({ products: available, language }),
    [available, language]
  );

  /**
   * A chip that names exactly one listing opens that product — "view", not
   * "search for the same string and hope". Several matches, or a recent term
   * the sheet no longer holds, still go through the results screen.
   */
  const pickChip = (term) => {
    const matches = available.filter((product) => {
      const name = (language === 'hi' && product.nameHi)
        || (language === 'te' && product.nameTe)
        || product.name;
      return name === term;
    });
    if (matches.length === 1 && onSelectProduct) {
      onSelectProduct(matches[0]);
      return;
    }
    onSearchTerm?.(term);
  };

  return (
    <div className="pb-6 space-y-5 animate-fade-in pt-3">
      {(onSearchTerm || onSelectProduct) && (
        <>
          <ChipRow
            icon={Clock3}
            label={t('discovery.recent')}
            items={recent}
            onPick={pickChip}
          />
          <ChipRow
            icon={TrendingUp}
            label={t('discovery.popular')}
            items={popular}
            onPick={pickChip}
          />
        </>
      )}
      {rails.length === 0 ? (
        <p className="px-4 pt-6 text-xs font-semibold text-[#8A7E6B] text-center">
          {t('discovery.empty')}
        </p>
      ) : (
        rails.map((rail) => (
          <Rail
            key={rail.key}
            title={rail.title}
            items={rail.items}
            onSeeAll={rail.category && onOpenCategory ? () => onOpenCategory(rail.category) : undefined}
            qtyOf={qtyOf}
            {...cardProps}
          />
        ))
      )}
    </div>
  );
}
