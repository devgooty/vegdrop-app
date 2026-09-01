import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ChevronRight, ChevronLeft, Minus, Plus } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { productName, productWeight } from '../i18n/catalog';
import { unitsOf } from '../services/packs';

/**
 * The home hero: a peeking carousel of collection photographs AND two
 * store-list cards, all cut from the market's own sheet, whose colour is
 * handed up to tint the header above them.
 *
 * The photo slides are the original banners — a headline, one honest line,
 * Shop Now. The store slides are the ₹1-store shape (badge, four rows, See
 * all) without the ₹1 price, because checkout does not run that deal.
 *
 * The track auto-advances. It pauses while a finger or mouse is on it, and
 * while the tab is hidden, so it cannot steal a tap or burn frames in the
 * background. `prefers-reduced-motion` turns the timer off entirely.
 */

const ROW_COUNT = 4;
const AUTO_MS = 5000;

function heroPhoto(id) {
  return `https://images.unsplash.com/photo-${id}?w=700&h=500&fit=crop&auto=format&q=70`;
}

const COLLECTIONS = [
  {
    key: 'leafy',
    title: 'hero.leafyTitle',
    subtitle: 'hero.leafySub',
    categoryId: 1,
    photo: heroPhoto('1540420773420-3366772f4999'),
    header: 'rgba(226, 242, 229, 0.86)',
    wash: '#E2F2E5',
    cardFrom: '#EAF6EC',
    ink: '#1B4D3E',
    pick: (list) => list.filter((p) => p.categoryId === 1),
  },
  {
    key: 'savings',
    title: 'hero.savingsTitle',
    subtitle: 'hero.savingsSub',
    categoryId: 2,
    photo: heroPhoto('1624668430039-0175a0fbf006'),
    header: 'rgba(252, 230, 233, 0.86)',
    wash: '#FCE6E9',
    cardFrom: '#FDEFF1',
    ink: '#8C2F3C',
    pick: (list) => list.filter((p) => p.oldPrice > p.price),
  },
  {
    key: 'organic',
    title: 'hero.organicPicksTitle',
    subtitle: 'hero.organicPicksSub',
    categoryId: 3,
    photo: heroPhoto('1619566636858-adf3ef46400b'),
    header: 'rgba(250, 240, 219, 0.86)',
    wash: '#FAF0DB',
    cardFrom: '#FDF6E7',
    ink: '#7A5A16',
    pick: (list) => list.filter((p) => p.isOrganic),
  },
  {
    key: 'budget',
    title: 'hero.budgetTitle',
    subtitle: 'hero.budgetSub',
    categoryId: 2,
    photo: heroPhoto('1678954157605-38cc2f12c780'),
    header: 'rgba(224, 238, 250, 0.86)',
    wash: '#E0EEFA',
    cardFrom: '#ECF5FD',
    ink: '#1D4E6B',
    pick: (list) => list.filter((p) => p.price <= 50),
  },
  {
    key: 'veggies',
    title: 'hero.veggiesTitle',
    subtitle: 'hero.veggiesSub',
    categoryId: 2,
    photo: heroPhoto('1566385101042-1a0aa0c1268c'),
    header: 'rgba(251, 233, 219, 0.86)',
    wash: '#FBE9DB',
    cardFrom: '#FDF1E8',
    ink: '#8A4B1B',
    pick: (list) => list.filter((p) => p.categoryId === 2),
  },
  {
    key: 'exotic',
    title: 'hero.exoticPicksTitle',
    subtitle: 'hero.exoticPicksSub',
    categoryId: 4,
    photo: heroPhoto('1608686207856-001b95cf60ca'),
    header: 'rgba(238, 232, 250, 0.86)',
    wash: '#EEE8FA',
    cardFrom: '#F3EEFC',
    ink: '#4B3A7A',
    pick: (list) => list.filter((p) => p.categoryId === 4),
  },
];

const STORES = [
  {
    key: 'deal-budget',
    title: 'deal.budgetTitle',
    subtitle: 'hero.budgetSub',
    badge: 'deal.budgetBadge',
    pick: (list) => [...list.filter((p) => p.price <= 50)].sort((a, b) => a.price - b.price),
    header: 'rgba(238, 234, 248, 0.86)',
    theme: {
      wash: '#EEEAF8',
      footer: '#E4DDF4',
      badge: '#5B3AA8',
      badgeInk: '#F4E27A',
      badgeRing: '#E8D56A',
      ink: '#2D2A26',
      accent: '#4A3A8A',
      selectBorder: '#C5D4F0',
      selectFill: '#EEF3FB',
      selectInk: '#2F4A8A',
      coin: 'rgba(123, 92, 196, 0.22)',
      dot: '#5B3AA8',
    },
  },
  {
    key: 'deal-savings',
    title: 'deal.savingsTitle',
    subtitle: 'hero.savingsSub',
    badge: 'deal.savingsBadge',
    pick: (list) =>
      [...list.filter((p) => Number(p.oldPrice) > Number(p.price))].sort(
        (a, b) => discountPercent(b) - discountPercent(a)
      ),
    header: 'rgba(231, 243, 238, 0.86)',
    theme: {
      wash: '#E7F3EE',
      footer: '#D7EBE3',
      badge: '#1B4D3E',
      badgeInk: '#F4E27A',
      badgeRing: '#C9A227',
      ink: '#2D2A26',
      accent: '#1B4D3E',
      selectBorder: '#B7D4C8',
      selectFill: '#EEF7F3',
      selectInk: '#1B4D3E',
      coin: 'rgba(27, 77, 62, 0.18)',
      dot: '#1B4D3E',
    },
  },
];

/** The tint the header falls back to before any card has claimed the screen. */
export const DEFAULT_HERO_ACCENT = {
  header: 'rgba(250, 247, 242, 0.72)',
  wash: '#FAF7F2',
};

/**
 * One short buzz when the carousel settles on a different card.
 *
 * `navigator.vibrate` is Android-only — Safari has never implemented the
 * Vibration API on iOS, in-app or otherwise — so this is a no-op there rather
 * than a broken feature; nothing here needs to detect that, an absent method
 * just fails the `typeof` check silently. 15ms rather than a longer buzz: this
 * fires on every card change, and anything longer starts to feel like the UI
 * is complaining rather than confirming a swipe landed.
 */
function vibrateOnce() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(15);
  }
}

function inStock(product) {
  return product?.isActive !== false && Number(product?.stock ?? 0) > 0;
}

function discountPercent(product) {
  const old = Number(product?.oldPrice);
  const now = Number(product?.price);
  if (!Number.isFinite(old) || !Number.isFinite(now) || old <= now || now <= 0) return 0;
  return Math.round(((old - now) / old) * 100);
}

function lineKey(item) {
  const units = unitsOf(item);
  const catalog = String(item.catalogItem || item.originalId || item.id);
  return units > 1 ? `${catalog}::x${units}` : catalog;
}

function qtyInCart(cartItems, product) {
  const key = lineKey(product);
  return cartItems.find((line) => lineKey(line) === key)?.quantity ?? 0;
}

function majorityCategory(items, categories) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.categoryId, (counts.get(item.categoryId) || 0) + 1);
  }
  let bestId = items[0]?.categoryId;
  let best = 0;
  for (const [id, count] of counts) {
    if (count > best) {
      best = count;
      bestId = id;
    }
  }
  return categories.find((c) => c.id === bestId) || categories[0];
}

function cardTitle(card) {
  return card.kind === 'store' ? card.store.title : card.title;
}

function cardAccent(card) {
  if (!card) return DEFAULT_HERO_ACCENT;
  if (card.kind === 'store') {
    return { header: card.store.header, wash: card.store.theme.wash };
  }
  return { header: card.header, wash: card.wash };
}

function cardDot(card) {
  return card.kind === 'store' ? card.store.theme.dot : card.ink;
}

function CoinDecor({ color }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <span className="absolute top-2 right-16 h-5 w-5 rounded-full" style={{ background: color }} />
      <span className="absolute top-7 right-8 h-3.5 w-3.5 rounded-full" style={{ background: color }} />
      <span className="absolute -top-1 right-28 h-2.5 w-2.5 rounded-full" style={{ background: color }} />
    </div>
  );
}

function DealRow({ product, qty, theme, onAdd, onAdjust, onOpen, t, language }) {
  const name = productName(product, language);
  const weight = productWeight(product.weight, language);
  const soldOut = !inStock(product);
  const hasOld = Number(product.oldPrice) > Number(product.price);

  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <button
        type="button"
        onClick={() => onOpen(product)}
        className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-white border border-black/5 cursor-pointer"
        aria-label={name}
      >
        <img
          src={product.image}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(e) => {
            e.target.src = 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=300';
          }}
        />
      </button>

      <button
        type="button"
        onClick={() => onOpen(product)}
        className="min-w-0 flex-1 text-left cursor-pointer"
      >
        <p className="text-[13.5px] font-bold text-[#2D2A26] leading-tight truncate">{name}</p>
        {weight ? (
          <p className="text-[11.5px] font-semibold text-[#8A7E6B] mt-0.5">{weight}</p>
        ) : null}
      </button>

      {soldOut ? (
        <span className="shrink-0 text-[11.5px] font-bold text-slate-400 px-2">
          {t('product.soldOut')}
        </span>
      ) : qty > 0 ? (
        <div className="shrink-0 flex items-center rounded-lg border border-black/5 bg-white">
          <button
            type="button"
            onClick={(e) => onAdjust(product, -1, e)}
            className="p-1.5 cursor-pointer active:scale-90"
            title={t('product.decreaseQty')}
            aria-label={t('product.decreaseQty')}
          >
            <Minus className="w-3 h-3 stroke-[3]" style={{ color: theme.selectInk }} />
          </button>
          <span className="text-[12.5px] font-black min-w-4 text-center" style={{ color: theme.selectInk }}>
            {qty}
          </span>
          <button
            type="button"
            onClick={(e) => onAdjust(product, 1, e)}
            className="p-1.5 cursor-pointer active:scale-90"
            title={t('product.increaseQty')}
            aria-label={t('product.increaseQty')}
          >
            <Plus className="w-3 h-3 stroke-[3]" style={{ color: theme.selectInk }} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => onAdd(product, e)}
          aria-label={t('discovery.addNamed', { name })}
          className="shrink-0 text-[12.5px] font-extrabold px-2.5 py-1 rounded-lg cursor-pointer active:scale-95"
          style={{
            color: theme.selectInk,
            background: theme.selectFill,
            boxShadow: `inset 0 0 0 1px ${theme.selectBorder}`,
          }}
        >
          {t('deal.select')}
        </button>
      )}

      <div className="shrink-0 w-10 text-right leading-tight">
        {hasOld ? (
          <p className="text-[10.5px] font-semibold text-[#9A8F7C] line-through">₹{product.oldPrice}</p>
        ) : null}
        <p className="text-[14.5px] font-black text-[#2D2A26]">₹{product.price}</p>
      </div>
    </div>
  );
}

function NavArrows({ idx, count, prevLabel, nextLabel, onPrev, onNext }) {
  return (
    <>
      {idx > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          aria-label={prevLabel}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-10 bg-white/85 hover:bg-white text-[#1B4D3E] border border-black/5 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shadow-sm"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      {idx < count - 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label={nextLabel}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 bg-white/85 hover:bg-white text-[#1B4D3E] border border-black/5 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shadow-sm"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </>
  );
}

export default function HomeHeroBanner({
  products = [],
  categories = [],
  cartItems = [],
  onAddToCart,
  onUpdateQuantity,
  onSelectProduct,
  onExplore,
  onAccentChange,
}) {
  const { t, language } = useLanguage();
  const trackRef = useRef(null);
  const pausedRef = useRef(false);
  const resumeTimer = useRef(0);
  const activeRef = useRef(0);
  /**
   * The index syncActive last vibrated for — written synchronously, unlike
   * `active` state. A hard flick fires two native `scroll` events at the same
   * settled position (the instant jump, then the browser's own snap
   * correction), and both schedule a rAF call to syncActive before React has
   * committed the first one's setState — so comparing against the `prev`
   * argument of a functional setActive update saw the same stale value twice
   * and buzzed twice for one card change. A ref has no commit to wait for.
   */
  const lastVibratedRef = useRef(0);
  const [active, setActive] = useState(0);

  const cards = useMemo(() => {
    const sellable = products.filter(inStock);
    const photos = COLLECTIONS.filter((c) => c.pick(sellable).length > 0).map((c) => ({
      kind: 'photo',
      ...c,
    }));
    const stores = STORES.map((store) => ({
      kind: 'store',
      key: store.key,
      store,
      items: store.pick(sellable),
    })).filter((c) => c.items.length >= 2);
    return [...stores, ...photos];
  }, [products]);

  useEffect(() => {
    setActive((i) => (i >= cards.length ? Math.max(0, cards.length - 1) : i));
  }, [cards.length]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    onAccentChange?.(cardAccent(cards[active]));
  }, [active, cards, onAccentChange]);

  useEffect(() => () => onAccentChange?.(DEFAULT_HERO_ACCENT), [onAccentChange]);

  const syncActive = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const mid = track.scrollLeft + track.clientWidth / 2;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < track.children.length; i += 1) {
      const child = track.children[i];
      const centre = child.offsetLeft + child.offsetWidth / 2;
      const gap = Math.abs(centre - mid);
      if (gap < best) {
        best = gap;
        nearest = i;
      }
    }
    // A single buzz the moment the midpoint crosses into a new card — not on
    // every scroll frame, which would turn one swipe into a rattle, and not
    // only once the snap has fully settled, which would feel late against
    // when the eye and the finger already agree the card has changed.
    if (nearest !== lastVibratedRef.current) {
      vibrateOnce();
      lastVibratedRef.current = nearest;
    }
    setActive(nearest);
  }, []);

  const frame = useRef(0);
  const handleScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(syncActive);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const scrollToCard = useCallback((index) => {
    const track = trackRef.current;
    const clamped = Math.max(0, Math.min(index, (track?.children.length ?? 1) - 1));
    const child = track?.children[clamped];
    if (!track || !child) return;
    track.scrollTo({
      left: child.offsetLeft - (track.clientWidth - child.offsetWidth) / 2,
      behavior: 'smooth',
    });
  }, []);

  useEffect(() => {
    if (cards.length < 2) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduce.matches) return undefined;

    const id = window.setInterval(() => {
      if (pausedRef.current || document.hidden) return;
      const len = cards.length;
      if (len < 2) return;
      scrollToCard((activeRef.current + 1) % len);
    }, AUTO_MS);

    return () => window.clearInterval(id);
  }, [cards.length, scrollToCard]);

  useEffect(
    () => () => {
      window.clearTimeout(resumeTimer.current);
    },
    []
  );

  const pauseAuto = () => {
    pausedRef.current = true;
    window.clearTimeout(resumeTimer.current);
  };

  const resumeAutoSoon = () => {
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => {
      pausedRef.current = false;
    }, AUTO_MS);
  };

  const handleAdd = (product, event) => {
    onAddToCart?.(product, event);
  };

  const handleAdjust = (product, delta, event) => {
    if (delta > 0) {
      onAddToCart?.(product, event);
      return;
    }
    const line = cartItems.find((item) => lineKey(item) === lineKey(product));
    if (line) onUpdateQuantity?.(line.id, delta);
  };

  if (cards.length === 0) return null;

  const activeWash = cardAccent(cards[active]).wash;

  return (
    <section
      className="relative pt-2 pb-1"
      onMouseEnter={pauseAuto}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
      onTouchStart={pauseAuto}
      onTouchEnd={resumeAutoSoon}
    >
      {/*
        A colour fade behind the carousel, kept in step with the header's own
        `--vd-hero-accent` transition above it — both move on the same 700ms
        ease-out, because a browser will not interpolate one `background-image`
        gradient into another; it snaps at the very first frame. That was the
        actual bug: the header takes 700ms to fade to a new card's tint, this
        layer used to jump the instant the card changed, and for as long as the
        header lagged, two mismatched hues sat flush against each other at the
        seam between them — a visible line that grew and healed on every card
        change, including the automatic ones nobody had touched.

        `background-color` animates natively, so the fix moves the colour onto
        that (matching the header's own mechanism) and gets the vertical fade
        from a static mask instead of a gradient that has to change colour —
        a mask's shape never needs to transition, only the fill underneath it.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 bottom-0 -z-10 transition-colors duration-700 ease-out"
        style={{
          backgroundColor: activeWash,
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 55%, transparent 100%)',
          maskImage: 'linear-gradient(to bottom, black 0%, black 55%, transparent 100%)',
        }}
      />

      {/*
        snap-mandatory alone only guarantees the track SETTLES on a card —
        it says nothing about how many it may pass through to get there. A
        fast flick has enough momentum to sail two or three cards past the
        next one before the browser decelerates enough to lock on, which is
        the "scrolls too much" a single swipe was producing. `snap-always`
        (scroll-snap-stop) on each card below is what turns "nearest card
        once it stops" into "the very next card, always" — supported in
        every evergreen browser, iOS Safari included since 15.
      */}
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className="vd-hero-track flex gap-3 overflow-x-auto snap-x snap-mandatory px-4 pb-2 items-stretch"
      >
        {cards.map((card, idx) => {
          const prevLabel = t('hero.goToCollection', { name: t(cardTitle(cards[idx - 1] || card)) });
          const nextLabel = t('hero.goToCollection', { name: t(cardTitle(cards[idx + 1] || card)) });

          if (card.kind === 'store') {
            const { store, items } = card;
            const { theme } = store;
            const rows = items.slice(0, ROW_COUNT);
            const category = majorityCategory(items, categories);
            return (
              <article
                key={card.key}
                className="group relative snap-center snap-always shrink-0 w-[94%] min-h-80 rounded-3xl overflow-hidden border border-black/[0.04] shadow-sm"
                style={{ backgroundColor: theme.wash }}
              >
                <header className="relative px-3 pt-3 pb-2">
                  <CoinDecor color={theme.coin} />
                  <div className="relative flex items-center gap-2.5">
                    <div
                      className="h-11 min-w-11 px-1.5 shrink-0 rounded-xl flex items-center justify-center shadow-sm"
                      style={{
                        backgroundColor: theme.badge,
                        boxShadow: `inset 0 0 0 1.5px ${theme.badgeRing}`,
                      }}
                    >
                      <span
                        className="text-[14.5px] font-black tracking-tight leading-none"
                        style={{ color: theme.badgeInk }}
                      >
                        {t(store.badge)}
                      </span>
                    </div>
                    <h2 className="text-[23.5px] font-black tracking-tight leading-none" style={{ color: theme.ink }}>
                      {t(store.title)}
                    </h2>
                    <p
                      className="ml-auto max-w-[42%] text-right text-[11.5px] font-bold leading-snug"
                      style={{ color: theme.accent }}
                    >
                      {t(store.subtitle)}
                    </p>
                  </div>
                </header>

                <div className="divide-y divide-black/[0.05]">
                  {rows.map((product) => (
                    <DealRow
                      key={product.id}
                      product={product}
                      qty={qtyInCart(cartItems, product)}
                      theme={theme}
                      onAdd={handleAdd}
                      onAdjust={handleAdjust}
                      onOpen={(item) => onSelectProduct?.(item)}
                      t={t}
                      language={language}
                    />
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => onExplore?.(category)}
                  className="w-full py-2.5 text-[14.5px] font-extrabold cursor-pointer active:opacity-80"
                  style={{ backgroundColor: theme.footer, color: theme.accent }}
                >
                  {t('hero.seeAll')}
                  <span className="tracking-tighter"> &gt;&gt;</span>
                </button>

                <NavArrows
                  idx={idx}
                  count={cards.length}
                  prevLabel={prevLabel}
                  nextLabel={nextLabel}
                  onPrev={() => scrollToCard(idx - 1)}
                  onNext={() => scrollToCard(idx + 1)}
                />
              </article>
            );
          }

          const category = categories.find((c) => c.id === card.categoryId);
          return (
            <article
              key={card.key}
              className="group relative snap-center snap-always shrink-0 w-[94%] min-h-80 self-stretch rounded-3xl overflow-hidden border border-black/5 shadow-sm"
              style={{ backgroundColor: card.cardFrom }}
            >
              <img
                src={card.photo}
                alt=""
                aria-hidden="true"
                loading="lazy"
                fetchPriority={idx === 0 ? 'high' : 'low'}
                className="absolute right-0 top-0 h-full w-[64%] object-cover"
              />
              <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{
                  backgroundImage: `linear-gradient(to right, ${card.cardFrom} 0%, ${card.cardFrom} 55%, transparent 80%)`,
                }}
              />

              <div className="absolute inset-0 flex flex-col justify-center gap-2 p-5 w-[62%]">
                <div className="space-y-1">
                  <h2
                    className="font-vintage text-[23.5px] font-black leading-[1.1] tracking-tight"
                    style={{ color: card.ink }}
                  >
                    {t(card.title)}
                  </h2>
                  <p className="text-[13.5px] font-bold opacity-75 leading-snug" style={{ color: card.ink }}>
                    {t(card.subtitle)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => onExplore?.(category)}
                  className="self-start flex items-center gap-1 px-5 py-2.5 rounded-full text-sm font-extrabold text-white shadow-sm cursor-pointer active:scale-95 transition-transform"
                  style={{ backgroundColor: card.ink }}
                >
                  <span>{t('hero.shopNow')}</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <NavArrows
                idx={idx}
                count={cards.length}
                prevLabel={prevLabel}
                nextLabel={nextLabel}
                onPrev={() => scrollToCard(idx - 1)}
                onNext={() => scrollToCard(idx + 1)}
              />
            </article>
          );
        })}
      </div>

      <div className="flex justify-center gap-1.5 pt-1">
        {cards.map((card, idx) => (
          <button
            key={card.key}
            onClick={() => scrollToCard(idx)}
            aria-label={t('hero.goToCollection', { name: t(cardTitle(card)) })}
            aria-current={active === idx}
            className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
              active === idx ? 'w-5' : 'w-1.5 bg-black/15'
            }`}
            style={active === idx ? { backgroundColor: cardDot(card) } : undefined}
          />
        ))}
      </div>
    </section>
  );
}
