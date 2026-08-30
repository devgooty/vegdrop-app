import React, { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * A hero photograph, cropped to the banner by the CDN rather than by the browser.
 *
 * The card is 414x208 at its widest, so the crop is asked for at 700x352 — the
 * same 2:1, at 1.7x for retina. Passing `w` ALONE, as this used to, leaves
 * `fit=crop` inert: with no height there is nothing to crop to, so the browser
 * downloaded a 600x400 photograph and `object-cover` threw a quarter of it away.
 * Naming both is what makes the parameter mean anything.
 *
 * It is also cheaper. Measured on the heaviest of the three, 700x352 at q=70 is
 * 97 KB against 116 KB for the old uncropped w=600 at q=80 — more resolution
 * where the pixels are shown, none where they were being discarded. That matters
 * here specifically: this image is the customer app's LCP element.
 *
 * Landscape sources only. A portrait photograph centre-crops to a slot through
 * its middle, which is how the delivery slide came to be a close-up of a salad
 * bowl.
 */
function heroPhoto(id) {
  return `https://images.unsplash.com/photo-${id}?w=700&h=352&fit=crop&auto=format&q=70`;
}

/**
 * The carousel only. The "DELIVERY TO" bar that used to sit above it now lives
 * in the header (DeliveryLocationBar), where it stays visible instead of
 * scrolling away with the rest of the home tab — see Header.jsx.
 */
export default function HomeHeroBanner({ onExplore }) {
  // The banner copy below is built inside the component rather than hoisted to
  // module scope, so it re-resolves when the language changes.
  const { t } = useLanguage();
  const [currentSlide, setCurrentSlide] = useState(0);
  const [touchStartX, setTouchStartX] = useState(0);
  const [touchEndX, setTouchEndX] = useState(0);

  /**
   * A slide is a headline, a deal and a code. Nothing else is rendered, so
   * nothing else is carried — the tag, subtitle and badge colour were dropped
   * here as well as from the markup rather than left as fields no one reads.
   *
   * **No slide promises a delivery time.** One used to promise fifteen minutes
   * in three places at once (its tag, its headline and its subtitle) plus a
   * fourth on every other slide, in the "15m to …" ETA. That is a hard number to
   * hit on a hyperlocal round, and a banner is a bad place to commit to one.
   * Free delivery over ₹200 is the promise here instead, because it is a rule
   * the checkout actually enforces rather than an estimate.
   */
  const banners = [
    {
      id: 1,
      title: t('hero.organicTitle'),
      offer: t('hero.flat20'),
      code: 'FRESH20',
      // A harvest crate, for copy that says these were handpicked this morning.
      image: heroPhoto('1624668430039-0175a0fbf006'),
    },
    {
      id: 2,
      title: t('hero.expressTitle'),
      offer: t('hero.freeDelivery200'),
      code: 'EXPRESS',
      /*
        A rider carrying an insulated box. This slide was a close-up of a salad
        bowl, illustrating nothing it claimed. The box is unbranded on purpose:
        the obvious stock photographs here are all couriers for a named delivery
        company, and a competitor's logo across our own hero is worse than a
        picture that says nothing.
      */
      image: heroPhoto('1648394794449-5dbe63f6a8b5'),
    },
    {
      id: 3,
      title: t('hero.exoticTitle'),
      offer: t('hero.upto35'),
      code: 'BAZZAR35',
      // Papaya, avocado, kiwi, grapefruit — the exotic the copy is selling.
      image: heroPhoto('1610832958506-aa56368176cf'),
    },
  ];

  // Auto-slide banner every 4 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % banners.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [banners.length]);

  const banner = banners[currentSlide];

  return (
    <section className="px-4 pt-3 pb-1 space-y-2">
      {/* HERO BANNER CARD */}
      <div
        className="relative h-52 rounded-3xl overflow-hidden shadow-sm border border-[#E7E1D5] bg-[#FFFDF9] group"
        onTouchStart={(e) => setTouchStartX(e.targetTouches[0].clientX)}
        onTouchMove={(e) => setTouchEndX(e.targetTouches[0].clientX)}
        onTouchEnd={() => {
          if (!touchStartX || !touchEndX) return;
          const distance = touchStartX - touchEndX;
          const isLeftSwipe = distance > 50;
          const isRightSwipe = distance < -50;

          if (isLeftSwipe) {
            setCurrentSlide((prev) => (prev + 1) % banners.length);
          }
          if (isRightSwipe) {
            setCurrentSlide((prev) => (prev === 0 ? banners.length - 1 : prev - 1));
          }

          setTouchStartX(0);
          setTouchEndX(0);
        }}
      >
        {/*
          Every slide is mounted and cross-faded, rather than one <img> remounted
          on a key. Swapping the source tears the old photograph away a frame
          before the new one decodes, so the card blinked through to its own
          background on each turn of the carousel — and re-decoded an image the
          browser already had. Only the active one is offered to assistive tech
          or to the preloader.
        */}
        {banners.map((b, idx) => (
          <img
            key={b.id}
            src={b.image}
            alt=""
            aria-hidden="true"
            fetchPriority={idx === 0 ? 'high' : 'low'}
            className={`absolute right-0 top-0 h-full w-[64%] object-cover transition-opacity duration-700 ease-out
                        ${idx === currentSlide ? 'opacity-100' : 'opacity-0'}`}
          />
        ))}

        {/*
          The card is light and the words sit on the card, not on the
          photograph — so this is a horizontal fade that hands the left side
          back to the background, not a scrim darkening a photo to survive white
          text on top of it.

          That swap is why the whole contrast exercise this file used to carry is
          gone. Dark type on #FFFDF9 is a fixed pair, about 15:1, and it cannot
          be undermined by tomorrow's photograph — whereas white-on-photo had to
          be re-swept every time the copy or the picture changed, and failed
          only on whichever slide happened to be pale.

          The stops are still measured, just against a different thing: the
          longest headline. "Delivered Fresh to Your Doorstep" wraps to 51.6% of
          the card, so solid ground runs to 54% — an earlier 38% left that one
          slide's last word sitting on 82%-opaque cream over a photograph. The
          three headlines end at 42.5%, 51.6% and 43.5%; re-measure if any of
          them grows, because only the longest one can expose this.

          It clears by 78% rather than sooner so the fade lands well inside the
          photo's own width (64%) and never shows a vertical seam where the
          image begins.
        */}
        <div
          className="absolute inset-0 bg-[linear-gradient(to_right,#FFFDF9_0%,#FFFDF9_54%,rgba(255,253,249,0.85)_64%,rgba(255,253,249,0)_78%)]"
          aria-hidden="true"
        />

        {/*
          Headline, one supporting line, one button — the shape both reference
          banners use. The offer moved INTO the supporting line rather than
          being dropped: those banners carry a subtitle and no coupon, but the
          codes are real, and "Flat 20% OFF · FRESH20" says the same thing in
          the slot their subtitle already occupies. Three elements, nothing lost.
        */}
        <div className="absolute inset-0 flex flex-col justify-center gap-2 p-5 w-[60%]">
          <div className="space-y-1.5 animate-fade-in" key={`copy-${banner.id}`}>
            <h2 className="font-vintage text-[23px] font-black leading-[1.08] text-[#1A1A1A] tracking-tight">
              {banner.title}
            </h2>
            <p className="text-[11px] font-bold text-[#6B6355] leading-snug">
              {banner.offer} · {banner.code}
            </p>
          </div>

          {/* self-start, or a block-level flex button stretches the column. */}
          <button
            onClick={onExplore}
            className="self-start bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold px-5 py-2.5 rounded-full text-sm inline-flex items-center gap-1 shadow-sm cursor-pointer active:scale-95 transition-colors z-20"
          >
            <span>{t('hero.shopNow')}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Manual Arrow Controls (Desktop/Hover) */}
        <button
          onClick={(e) => { e.stopPropagation(); setCurrentSlide((prev) => (prev === 0 ? banners.length - 1 : prev - 1)); }}
          className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/85 hover:bg-white text-[#1B4D3E] border border-[#E7E1D5] rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 cursor-pointer shadow-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setCurrentSlide((prev) => (prev + 1) % banners.length); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/85 hover:bg-white text-[#1B4D3E] border border-[#E7E1D5] rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 cursor-pointer shadow-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>

      </div>

      {/*
        Indicators sit UNDER the card rather than inside its bottom corner,
        where they used to overlap the offer row. Off the photograph they also
        stop needing a translucent-white treatment to survive whatever happens
        to be behind them.
      */}
      <div className="flex justify-center gap-1.5 pt-0.5">
        {banners.map((b, idx) => (
          <button
            key={b.id}
            onClick={() => setCurrentSlide(idx)}
            aria-label={t('hero.goToSlide', { n: idx + 1 })}
            aria-current={currentSlide === idx}
            className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
              currentSlide === idx ? 'w-5 bg-[#1B4D3E]' : 'w-1.5 bg-[#DCD5C6]'
            }`}
          />
        ))}
      </div>
    </section>
  );
}
