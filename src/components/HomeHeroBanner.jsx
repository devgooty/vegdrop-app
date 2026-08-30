import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ChevronRight } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { productName } from '../i18n/catalog';

/**
 * The home hero: a peeking carousel of collections, each cut from the real
 * catalogue, whose colour is handed up to tint the header above it.
 *
 * It replaced three photographic offer slides. The problem with those was not
 * that they looked bad, it was that they said things the shop did not have to
 * honour — a headline, a discount and a coupon code, none of which the products
 * below were checked against. A card here IS its products: four rows read off
 * the market's own sheet, at the price checkout will charge. There is no copy
 * that can go stale, because there is no copy making a claim.
 *
 * The colour is the point of the design, not decoration. Each collection owns a
 * pastel, the card is built from it, and the same pastel is published upward so
 * the header takes it too — so swiping the carousel repaints the whole top of
 * the screen, and the header reads as the lid of the card rather than a
 * separate bar sitting above it.
 */

/**
 * One collection: how to pick its products, and what colour it makes the screen.
 *
 * `header` carries its own alpha because it lands on the frosted header, which
 * has to keep blurring what passes underneath — an opaque tint there would turn
 * the glass back into a solid bar and undo the frosting entirely. `wash` is
 * solid, because it is used as a gradient stop that fades to nothing on its own.
 *
 * The pastels are deliberately far apart in hue. Two collections a step apart on
 * the colour wheel make the swipe look like a rendering fault rather than a
 * change of section — the repaint has to be legible at a glance to read as
 * intentional.
 */
const COLLECTIONS = [
  {
    key: 'leafy',
    title: 'hero.leafyTitle',
    subtitle: 'hero.leafySub',
    categoryId: 1,
    header: 'rgba(226, 242, 229, 0.86)',
    wash: '#E2F2E5',
    cardFrom: '#EAF6EC',
    cardTo: '#D6EBDB',
    ink: '#1B4D3E',
    pick: (list) => list.filter((p) => p.categoryId === 1),
  },
  {
    key: 'organic',
    title: 'hero.organicPicksTitle',
    subtitle: 'hero.organicPicksSub',
    categoryId: 3,
    header: 'rgba(250, 240, 219, 0.86)',
    wash: '#FAF0DB',
    cardFrom: '#FDF6E7',
    cardTo: '#F5E6C4',
    ink: '#7A5A16',
    pick: (list) => list.filter((p) => p.isOrganic),
  },
  {
    key: 'exotic',
    title: 'hero.exoticPicksTitle',
    subtitle: 'hero.exoticPicksSub',
    categoryId: 4,
    header: 'rgba(238, 232, 250, 0.86)',
    wash: '#EEE8FA',
    cardFrom: '#F3EEFC',
    cardTo: '#E2D8F6',
    ink: '#4B3A7A',
    pick: (list) => list.filter((p) => p.categoryId === 4),
  },
  {
    key: 'savings',
    title: 'hero.savingsTitle',
    subtitle: 'hero.savingsSub',
    categoryId: 2,
    header: 'rgba(252, 230, 233, 0.86)',
    wash: '#FCE6E9',
    cardFrom: '#FDEFF1',
    cardTo: '#F8D8DD',
    ink: '#8C2F3C',
    // Sorted by how much is actually taken off, not by how cheap the item is —
    // "biggest savings" naming the cheapest rows would just be a price list.
    pick: (list) =>
      list
        .filter((p) => p.oldPrice > p.price)
        .sort((a, b) => b.oldPrice - b.price - (a.oldPrice - a.price)),
  },
];

const ROWS_PER_CARD = 4;

/** The tint the header falls back to before any card has claimed the screen. */
export const DEFAULT_HERO_ACCENT = {
  header: 'rgba(250, 247, 242, 0.72)',
  wash: '#FAF7F2',
};

export default function HomeHeroBanner({
  products = [],
  categories = [],
  onExplore,
  onSelectProduct,
  onAccentChange,
}) {
  const { t, language } = useLanguage();
  const trackRef = useRef(null);
  const [active, setActive] = useState(0);

  /**
   * A collection with nothing in it is dropped rather than rendered empty.
   *
   * The catalogue is the chosen market's sheet, so which of these have stock is
   * a per-market fact — a market with no exotic aisle would otherwise get a
   * violet card containing four blank rows, and a dot in the strip that leads
   * nowhere.
   */
  const cards = useMemo(() => {
    const sellable = products.filter((p) => p?.isActive !== false && Number(p?.stock ?? 0) > 0);
    return COLLECTIONS.map((c) => ({ ...c, items: c.pick(sellable).slice(0, ROWS_PER_CARD) })).filter(
      (c) => c.items.length > 0
    );
  }, [products]);

  // A shrinking set must not leave the pointer past its end — switching to a
  // market with fewer aisles would otherwise index into nothing and blank the
  // accent.
  useEffect(() => {
    setActive((i) => (i >= cards.length ? Math.max(0, cards.length - 1) : i));
  }, [cards.length]);

  /**
   * Publish the active card's colour upward.
   *
   * Reported from here rather than read by the header, because only this
   * component knows which card is centred — and it is reported as a value, not
   * written to the DOM, so leaving the home tab restores the default tint
   * through ordinary React state instead of a cleanup that has to remember to
   * run.
   */
  useEffect(() => {
    const card = cards[active];
    onAccentChange?.(card ? { header: card.header, wash: card.wash } : DEFAULT_HERO_ACCENT);
  }, [active, cards, onAccentChange]);

  useEffect(() => () => onAccentChange?.(DEFAULT_HERO_ACCENT), [onAccentChange]);

  /**
   * Which card is centred, measured from the scroll position.
   *
   * Derived from geometry rather than tracked as the source of truth, because
   * the carousel is a native scroll-snap track: a flick lands wherever the
   * browser decides, and an index we incremented ourselves would disagree with
   * what is on screen. Measuring means the dots and the tint cannot drift from
   * the card.
   */
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
    setActive(nearest);
  }, []);

  const frame = useRef(0);
  const handleScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(syncActive);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const scrollToCard = (index) => {
    const track = trackRef.current;
    const child = track?.children[index];
    if (!track || !child) return;
    track.scrollTo({
      left: child.offsetLeft - (track.clientWidth - child.offsetWidth) / 2,
      behavior: 'smooth',
    });
  };

  if (cards.length === 0) return null;

  return (
    <section className="relative pt-2 pb-1">
      {/*
        Carries the header's colour down past the card and dissolves it into the
        page, so the tint ends as a fade rather than an edge.

        It stays strictly inside this section. The obvious version reached up
        behind the header with a negative top, to guarantee the colour existed
        under the frosted glass — and it painted straight over the search bar,
        which cost an hour to find. `-z-10` does not escape to the page: the
        home tab is wrapped in PageTransition, which animates and therefore
        opens a stacking context, so the whole subtree paints as one layer above
        the header regardless of how negative a child's z-index is. The header
        does not need this element anyway; it takes the same colour through the
        --vd-hero-accent variable, which inheritance carries across the stacking
        context this cannot cross.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 bottom-0 -z-10 transition-[background-image] duration-700 ease-out"
        style={{
          backgroundImage: `linear-gradient(to bottom, ${cards[active]?.wash ?? DEFAULT_HERO_ACCENT.wash} 0%, ${
            cards[active]?.wash ?? DEFAULT_HERO_ACCENT.wash
          } 55%, transparent 100%)`,
        }}
      />

      {/*
        A native scroll-snap track, not a transform carousel.

        Swiping this is the whole feature — the tint follows the finger — and a
        transform slider only moves in completed steps, so the colour would jump
        at the end of a swipe instead of arriving with the card. `snap-center`
        with cards narrower than the track is also what produces the peek at both
        edges, rather than it having to be faked with padding.
      */}
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className="vd-hero-track flex gap-3 overflow-x-auto snap-x snap-mandatory px-4 pb-2"
      >
        {cards.map((card) => {
          const category = categories.find((c) => c.id === card.categoryId);
          return (
            <article
              key={card.key}
              className="snap-center shrink-0 w-[86%] rounded-3xl overflow-hidden border border-black/5 shadow-sm flex flex-col"
              style={{ backgroundImage: `linear-gradient(160deg, ${card.cardFrom} 0%, ${card.cardTo} 100%)` }}
            >
              <header className="px-4 pt-3.5 pb-2">
                <h2 className="font-vintage text-[19px] font-black leading-tight tracking-tight" style={{ color: card.ink }}>
                  {t(card.title)}
                </h2>
                <p className="text-[11px] font-bold opacity-70 leading-snug" style={{ color: card.ink }}>
                  {t(card.subtitle)}
                </p>
              </header>

              <ul className="px-2.5 space-y-1.5 flex-1">
                {card.items.map((item) => {
                  const off =
                    item.oldPrice > item.price
                      ? Math.round(((item.oldPrice - item.price) / item.oldPrice) * 100)
                      : 0;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onSelectProduct?.(item)}
                        className="w-full flex items-center gap-2.5 rounded-2xl bg-white/70 hover:bg-white/90 px-2 py-1.5 text-left transition-colors active:scale-[0.99] cursor-pointer"
                      >
                        <img
                          src={item.image}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          className="w-10 h-10 rounded-xl object-cover bg-white shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11.5px] font-bold text-[#2D2A26] truncate leading-tight">
                            {productName(item, language)}
                          </span>
                          <span className="block text-[10px] font-semibold text-[#8A7E6B] leading-tight">
                            {item.weight}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-[12px] font-black leading-tight" style={{ color: card.ink }}>
                            ₹{item.price}
                          </span>
                          {off > 0 && (
                            <span className="block text-[9px] font-bold text-[#8A7E6B] line-through leading-tight">
                              ₹{item.oldPrice}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <button
                type="button"
                onClick={() => onExplore?.(category)}
                className="mt-2 w-full py-2.5 flex items-center justify-center gap-1 text-[11.5px] font-black bg-white/40 hover:bg-white/60 transition-colors cursor-pointer"
                style={{ color: card.ink }}
              >
                <span>{t('hero.seeAll')}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </article>
          );
        })}
      </div>

      <div className="flex justify-center gap-1.5 pt-1">
        {cards.map((card, idx) => (
          <button
            key={card.key}
            onClick={() => scrollToCard(idx)}
            aria-label={t('hero.goToCollection', { name: t(card.title) })}
            aria-current={active === idx}
            className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
              active === idx ? 'w-5' : 'w-1.5 bg-black/15'
            }`}
            style={active === idx ? { backgroundColor: card.ink } : undefined}
          />
        ))}
      </div>
    </section>
  );
}
