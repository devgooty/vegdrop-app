import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * The home hero: a peeking carousel of collections cut from the real
 * catalogue, whose colour is handed up to tint the header above it.
 *
 * Each card is a photograph, a headline and one line of honest copy — no
 * item list. It went through a products-list phase first (four rows read off
 * the market's own sheet), which solved the problem a purely photographic
 * banner has — a headline and a discount that nothing checks against stock —
 * but read as a small catalogue grid rather than a banner. This is the
 * photo-banner shape back, with the same guardrail the list version had:
 * every subtitle here is a plain factual line about the collection ("Picked
 * this morning", "Lowest prices right now"), never a discount, a code, or a
 * delivery-time promise the checkout does not enforce.
 *
 * The colour is still the point of the design. Each collection owns a
 * pastel, the card's scrim is built from it, and the same pastel is
 * published upward so the header takes it too — swiping repaints the whole
 * top of the screen, and the header reads as the lid of the card rather than
 * a separate bar sitting above it.
 */

/**
 * A hero photograph, cropped to the banner by the CDN rather than by the
 * browser. The card is under 500px wide at its widest, so the crop is asked
 * for at 700x352 — 2:1, at roughly 1.7x for retina. Naming both `w` and `h`
 * is what makes `fit=crop` do anything: `w` alone leaves it inert, and the
 * browser downloads a whole photograph only to throw most of it away.
 */
function heroPhoto(id) {
  return `https://images.unsplash.com/photo-${id}?w=700&h=352&fit=crop&auto=format&q=70`;
}

/**
 * One collection: how to pick its products (to decide whether it has anything
 * to show), what photograph represents it, and what colour it makes the
 * screen.
 *
 * The photographs are ids already live elsewhere in this app — the category
 * cards on this same home screen, or (the 'savings' harvest-crate shot) a
 * photograph this file shipped to production before. Reusing a verified id
 * beats guessing a fresh one that might 404 or show the wrong thing.
 *
 * The pastels are deliberately far apart in hue, for the same reason as
 * before: two collections a step apart on the colour wheel make the swipe
 * look like a rendering fault rather than a change of section.
 */
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
    // A harvest crate — this exact photograph carried the "Flat 20% OFF"
    // slide in production before the redesign to a products list; verified
    // once, safe to reuse rather than a fresh unverified id.
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
    // Bulk onions — an everyday, unmistakably inexpensive staple, and a
    // different photograph from 'veggies' below so the two do not read as
    // the same card shown twice.
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

/** The tint the header falls back to before any card has claimed the screen. */
export const DEFAULT_HERO_ACCENT = {
  header: 'rgba(250, 247, 242, 0.72)',
  wash: '#FAF7F2',
};

export default function HomeHeroBanner({ products = [], categories = [], onExplore, onAccentChange }) {
  const { t } = useLanguage();
  const trackRef = useRef(null);
  const [active, setActive] = useState(0);

  /**
   * A collection with nothing sellable behind it is dropped rather than
   * shown as an empty promise — a photograph and a "Shop Now" button leading
   * to a market with none of that aisle stocked would be worse than not
   * offering the card at all.
   */
  const cards = useMemo(() => {
    const sellable = products.filter((p) => p?.isActive !== false && Number(p?.stock ?? 0) > 0);
    return COLLECTIONS.filter((c) => c.pick(sellable).length > 0);
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
    const clamped = Math.max(0, Math.min(index, (track?.children.length ?? 1) - 1));
    const child = track?.children[clamped];
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
        {cards.map((card, idx) => {
          const category = categories.find((c) => c.id === card.categoryId);
          return (
            <article
              key={card.key}
              className="group relative snap-center shrink-0 w-[94%] h-80 rounded-3xl overflow-hidden border border-black/5 shadow-sm"
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

              {/*
                A horizontal fade that hands the left side back to the card's
                own colour, not a scrim darkening a photograph to survive
                white text on top of it. The stops are measured against the
                longest headline in the set ("Fresh Vegetables" / "Biggest
                Savings" at this width) rather than picked by eye: solid
                ground runs to 55%, comfortably past where any headline in
                COLLECTIONS ends, and the fade clears by 80% — inside the
                photo's own 64% width, so it never shows a seam where the
                image begins.
              */}
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
                    className="font-vintage text-[22px] font-black leading-[1.1] tracking-tight"
                    style={{ color: card.ink }}
                  >
                    {t(card.title)}
                  </h2>
                  <p className="text-[12px] font-bold opacity-75 leading-snug" style={{ color: card.ink }}>
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

              {/* Manual arrow controls — desktop/hover, the same affordance
                  this banner carried before the collections redesign. Touch
                  has no hover state, so on a phone these stay decorative and
                  swipe/dots do the actual work. */}
              {idx > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollToCard(idx - 1);
                  }}
                  aria-label={t('hero.goToCollection', { name: t(cards[idx - 1].title) })}
                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/85 hover:bg-white text-[#1B4D3E] border border-black/5 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shadow-sm"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}
              {idx < cards.length - 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollToCard(idx + 1);
                  }}
                  aria-label={t('hero.goToCollection', { name: t(cards[idx + 1].title) })}
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/85 hover:bg-white text-[#1B4D3E] border border-black/5 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shadow-sm"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
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
