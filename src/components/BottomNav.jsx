import React, { useState, useEffect, useRef } from 'react';
import { Home, ShoppingBasket, UserCheck, TrendingUp, ChefHat } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

export default function BottomNav({ activeTab, setActiveTab, cartCount, onOpenCart, cartOpen, cartBump, userRole }) {
  const { t } = useLanguage();
  // While the basket covers the screen, none of the route tabs are where the
  // shopper actually is — only Cart should read as active. Without this,
  // whichever tab was active underneath (Home, most often) stayed highlighted
  // while the basket sat on top of it.
  const routeActive = (tab) => !cartOpen && activeTab === tab;

  /**
   * The bar leaves entirely while reading, and hands the basket to a button.
   *
   * Scrolling down drops the whole bar below the fold and raises a single
   * round basket in the bottom-right corner; scrolling back brings the bar in
   * and takes the button away. The two are never on screen together, so the
   * basket never reads as duplicated.
   *
   * The bar used to shrink into a stub that kept Cart inside it. That reclaimed
   * less room than it looked like it did — a pill still sat across the bottom —
   * and it meant one control changing size, shape and position at once, which
   * is a harder thing to follow than a bar that leaves and a button that
   * arrives.
   *
   * Movement is ACCUMULATED per direction rather than compared frame to frame.
   * A per-frame threshold of a few pixels sounds equivalent and is not: real
   * scrolling arrives as momentum and jitter, so single frames cross ±4px in
   * the wrong direction constantly, and the bar spent a gesture flapping open
   * and shut. The accumulator resets when the direction genuinely flips, so
   * what flips the bar is 48px of sustained travel — a decision the thumb
   * actually made — and noise inside a stroke never reaches it.
   *
   * The 80px floor keeps the first screenful whole: nothing hides before there
   * is anything to have scrolled past, and it swallows the elastic overscroll
   * bounce at the top.
   *
   * Home only, which is why this is gated rather than always on. Home is the
   * long scroll the shopper reads through, so it is the only screen where the
   * bar is costing room worth reclaiming — and `HEADER_TABS` in App.jsx already
   * draws the same line for the header above. Everywhere else the bar stays
   * put: Prices, Cook and Account are places you go rather than read past, and
   * a nav that took itself away on a screen with nothing much to scroll would
   * read as the app losing its navigation.
   */
  const [collapsed, setCollapsed] = useState(false);
  const lastScrollY = useRef(0);
  const travel = useRef(0);

  /* The one screen this applies to. Cart is a button, not a route, so it is
     not a tab this can be compared against. */
  const collapsible = activeTab === 'home';

  useEffect(() => {
    /*
      Off every other tab, and reset on the way out — a bar left hidden as the
      shopper leaves Home would arrive on Account as a bare basket with no way
      back, since the route tabs are the way back.
    */
    if (!collapsible) {
      travel.current = 0;
      setCollapsed(false);
      return undefined;
    }

    /*
      Re-seed the accumulator on arrival, do not carry it across.

      Each tab is at its own scroll offset, so the first event after switching
      back to Home reports the difference between two unrelated screens — a few
      hundred pixels of "travel" the thumb never made, which lands as the bar
      vanishing (or returning) before the shopper has moved at all.
    */
    lastScrollY.current = window.scrollY;
    travel.current = 0;

    const handleScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY.current;
      lastScrollY.current = currentY;
      if (!delta) return;

      if (currentY <= 80) {
        travel.current = 0;
        setCollapsed(false);
        return;
      }

      // Direction changed — start counting this stroke from zero.
      if (delta > 0 !== travel.current > 0) travel.current = 0;
      travel.current += delta;

      if (travel.current > 48) setCollapsed(true);
      else if (travel.current < -48) setCollapsed(false);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [collapsible]);

  /**
   * The basket freezes the page behind it, so no scroll event can arrive to
   * bring the bar back. Opening the basket after scrolling down would
   * otherwise leave it hidden for as long as the basket is open — with the
   * only way out being the one small X, since the tabs are the other way back.
   */
  useEffect(() => {
    if (cartOpen) setCollapsed(false);
  }, [cartOpen]);

  /* One definition of a tab's shape and of its two tones, rather than the same
     two strings repeated five times and drifting apart on the sixth edit. */
  const tabButton = (tone) =>
    `flex flex-col items-center py-1.5 px-1.5 sm:px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${tone}`;

  const tabTone = (on) =>
    on
      ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
      : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5';

  return (
    // Outer element only aligns to the app shell's own width (`max-w-md
    // mx-auto`, the same rule the shell itself uses) and is the positioning
    // context the corner button is placed against. It carries no background or
    // border of its own, so it never draws a bar across the full width behind
    // the floating pill.
    <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-30 pointer-events-none">
      <div className="px-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
        {/*
          Translated out rather than unmounted, with opacity alongside it.

          Sliding a solid pill down past the safe-area inset still leaves a
          sliver of it against the bottom edge on a phone with a home bar, so
          the fade is what actually finishes the exit; the travel is what makes
          it read as leaving rather than blinking out. `pointer-events-none`
          because an element at opacity 0 still takes taps, and this one parks
          itself directly under the corner button that replaces it.
        */}
        <div
          className={`pointer-events-auto bg-[#FAF7F2]/95 backdrop-blur-md border border-[#DCD5C6] rounded-full flex items-center justify-around w-full py-1.5 px-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition-all duration-300 ease-out ${
            collapsed
              ? 'translate-y-[calc(100%+1.5rem)] opacity-0 pointer-events-none'
              : 'translate-y-0 opacity-100'
          }`}
        >
          <button
            onClick={() => setActiveTab('home')}
            className={tabButton(tabTone(routeActive('home')))}
          >
            <Home className={`w-5 h-5 transition-transform duration-300 ${routeActive('home') ? 'scale-110' : ''}`} />
            <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.home')}</span>
          </button>

          {/* Prices Tab */}
          <button
            onClick={() => setActiveTab('prices')}
            className={tabButton(tabTone(routeActive('prices')))}
          >
            <TrendingUp className={`w-5 h-5 transition-transform duration-300 ${routeActive('prices') ? 'scale-110' : ''}`} />
            <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.prices')}</span>
          </button>

          {/*
            Cart Tab. Carries `bottom-cart-button` only while the bar is up.
            FlyToCartOverlay measures that id to know where to throw a product,
            and a hidden bar's rect is a point below the fold — the animation
            would fly off the bottom of the screen. The corner button takes the
            id over for exactly as long as it is the visible basket, so the id
            names one element at a time either way.
          */}
          <button
            id={collapsed ? undefined : 'bottom-cart-button'}
            onClick={onOpenCart}
            className={`${tabButton(tabTone(cartOpen || cartBump))} relative ${cartBump ? 'animate-pop-bump' : ''}`}
          >
            <div className="relative">
              <ShoppingBasket className={`w-5 h-5 transition-transform duration-300 ${cartOpen || cartBump ? 'scale-110' : ''}`} />
              {cartCount > 0 && (
                <span
                  className={`skeuo-badge-amber absolute -top-1.5 -right-2.5 text-white text-[11.5px] font-extrabold px-1.5 py-0.2 rounded-full ring-2 ring-[#FAF7F2] ${
                    cartBump ? 'scale-125' : ''
                  } transition-transform duration-300`}
                >
                  {cartCount}
                </span>
              )}
            </div>
            <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.cart')}</span>
          </button>

          {/* Cook Tab - Only for customers or guests */}
          {(!userRole || userRole === 'customer') && (
            <button
              onClick={() => setActiveTab('assistant')}
              className={tabButton(tabTone(routeActive('assistant')))}
            >
              <ChefHat className={`w-5 h-5 transition-transform duration-300 ${routeActive('assistant') ? 'scale-110' : ''}`} />
              <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.cook')}</span>
            </button>
          )}

          {/*
            Account Tab — and the way to Orders, which is a quick action on the
            account screen rather than a tab of its own. Five tabs is what this
            pill fits without the labels crowding on a narrow phone; a sixth was
            spent on a screen shoppers open occasionally, not one they move
            between. Add a tab here only by taking one away.
          */}
          <button
            onClick={() => setActiveTab('account')}
            className={tabButton(tabTone(routeActive('account')))}
          >
            <UserCheck className={`w-5 h-5 transition-transform duration-300 ${routeActive('account') ? 'scale-110' : ''}`} />
            <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.account')}</span>
          </button>
        </div>
      </div>

      {/*
        The basket on its own, once the bar has gone.

        Bottom-right and round, so it reads as a button the app has raised
        rather than the last surviving piece of the bar — filled rather than
        tinted for the same reason, since it is now the only control on screen
        and has no row to belong to. Positioned against the nav rather than the
        viewport so it keeps to the same `max-w-md` column the bar does, instead
        of drifting to the corner of a wide window.

        It scales in rather than sliding: it arrives while the bar is leaving,
        and two things travelling the same way at the same moment read as one
        thing splitting in half.

        Kept mounted and hidden rather than conditionally rendered, so there is
        something for the transition to run on in both directions — a button
        that only exists while collapsed would pop in at full size.
      */}
      <button
        id={collapsed ? 'bottom-cart-button' : undefined}
        onClick={onOpenCart}
        aria-hidden={!collapsed}
        tabIndex={collapsed ? 0 : -1}
        aria-label={t('nav.cart')}
        className={`absolute right-4 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] w-14 h-14 rounded-full bg-[#1B4D3E] text-white flex items-center justify-center shadow-[0_8px_24px_rgba(0,0,0,0.22)] transition-all duration-300 ease-out active:scale-90 cursor-pointer ${
          collapsed
            ? 'pointer-events-auto scale-100 opacity-100'
            : 'pointer-events-none scale-0 opacity-0'
        } ${cartBump ? 'animate-pop-bump' : ''}`}
      >
        <ShoppingBasket className="w-6 h-6" />
        {cartCount > 0 && (
          <span className="skeuo-badge-amber absolute -top-0.5 -right-0.5 text-white text-[11.5px] font-extrabold px-1.5 py-0.2 rounded-full ring-2 ring-[#FAF7F2]">
            {cartCount}
          </span>
        )}
      </button>
    </nav>
  );
}
