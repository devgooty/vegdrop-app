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
   * Out of the way while reading, back the instant a thumb reverses direction.
   *
   * The bar used to leave entirely, sliding below the fold. That reclaimed the
   * most room but took the basket with it, and the basket is the one control a
   * shopper reaches for WHILE reading the catalogue — every other tab is
   * somewhere they go once they have stopped. So scrolling down now tucks the
   * four route tabs away and keeps Cart, and the pill shrinks to fit it.
   *
   * Compared against the last position rather than a running total, so a long
   * scroll down and then a short scroll up shows the bar again immediately —
   * a threshold measured from where scrolling started would make "up" mean
   * "up enough to undo the whole down", which is not what a reversal reads as.
   * The 8px floor near the top keeps the elastic overscroll bounce there from
   * flickering the bar collapsed and open on every rubber-band wobble.
   */
  const [collapsed, setCollapsed] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    const handleScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY.current;
      if (currentY <= 8) {
        setCollapsed(false);
      } else if (delta > 4) {
        setCollapsed(true);
      } else if (delta < -4) {
        setCollapsed(false);
      }
      lastScrollY.current = currentY;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  /**
   * What hides a route tab, applied to a wrapper rather than the button.
   *
   * The button carries its own `px-*`, and a collapsed variant would have to
   * override it — two Tailwind utilities for one property, resolved by their
   * order in the generated stylesheet rather than in this string, which is not
   * something to bet a layout on. A wrapper owns the width and the button
   * keeps its padding untouched.
   *
   * `max-width` rather than `hidden`, for the reason the header's address row
   * gives: a width that animates has to be a length, and the real one here is
   * whatever the label happens to measure. The cap is far wider than the
   * widest tab, so it never constrains the open state.
   */
  const tuck = `inline-flex overflow-hidden transition-all duration-300 ease-out ${
    collapsed ? 'max-w-0 opacity-0 scale-75 pointer-events-none' : 'max-w-28 opacity-100 scale-100'
  }`;

  /**
   * The basket freezes the page behind it, so no scroll event can arrive to
   * bring the tabs back. Opening the basket after scrolling down would
   * otherwise leave them tucked for as long as the basket is open — with the
   * only way out being the one small X, since the tabs are the other way back.
   */
  useEffect(() => {
    if (cartOpen) setCollapsed(false);
  }, [cartOpen]);

  return (
    // Outer element only aligns the pill to the app shell's own width
    // (`max-w-md mx-auto`, the same rule the shell itself uses) and reserves
    // the safe-area inset — it carries no background or border of its own, so
    // it never draws a bar across the full width behind the floating pill.
    <nav
      className="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-30 px-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pointer-events-none flex justify-end"
    >
      {/*
        `w-full` open, natural width collapsed — the pill is what shrinks once
        its tabs have nothing left to take up, and `justify-end` above drops the
        remainder on the thumb side rather than leaving it stranded mid-screen.
      */}
      <div
        className={`pointer-events-auto bg-[#FAF7F2]/95 backdrop-blur-md border border-[#DCD5C6] rounded-full flex justify-around items-center py-1.5 px-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition-all duration-300 ease-out ${
          collapsed ? 'w-auto' : 'w-full'
        }`}
      >
        <span className={tuck}>
          <button
            onClick={() => setActiveTab('home')}
            className={`flex flex-col items-center py-1.5 px-1.5 sm:px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
              routeActive('home')
                ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
                : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
            }`}
          >
            <Home className={`w-5 h-5 transition-transform duration-300 ${routeActive('home') ? 'scale-110' : ''}`} />
            <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.home')}</span>
          </button>
        </span>

        {/* Prices Tab */}
        <span className={tuck}>
          <button
            onClick={() => setActiveTab('prices')}
            className={`flex flex-col items-center py-1.5 px-1.5 sm:px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
              routeActive('prices')
                ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
                : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
            }`}
          >
            <TrendingUp className={`w-5 h-5 transition-transform duration-300 ${routeActive('prices') ? 'scale-110' : ''}`} />
            <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.prices')}</span>
          </button>
        </span>

        {/* Cart Button */}
        <button
          id="bottom-cart-button"
          onClick={onOpenCart}
          className={`flex flex-col items-center py-1.5 px-1.5 sm:px-2.5 rounded-full relative transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
            cartOpen || cartBump
              ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
              : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
          } ${cartBump ? 'animate-pop-bump' : ''}`}
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
          <span className={tuck}>
            <button
              onClick={() => setActiveTab('assistant')}
              className={`flex flex-col items-center py-1.5 px-1.5 sm:px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
                routeActive('assistant')
                  ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
                  : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
              }`}
            >
              <ChefHat className={`w-5 h-5 transition-transform duration-300 ${routeActive('assistant') ? 'scale-110' : ''}`} />
              <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.cook')}</span>
            </button>
          </span>
        )}

        {/*
          Account Tab — and the way to Orders, which is a quick action on the
          account screen rather than a tab of its own. Five tabs is what this
          pill fits without the labels crowding on a narrow phone; a sixth was
          spent on a screen shoppers open occasionally, not one they move
          between. Add a tab here only by taking one away.
        */}
        <span className={tuck}>
          <button
            onClick={() => setActiveTab('account')}
            className={`flex flex-col items-center py-1.5 px-1.5 sm:px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
              routeActive('account')
                ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
                : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
            }`}
          >
            <UserCheck className={`w-5 h-5 transition-transform duration-300 ${routeActive('account') ? 'scale-110' : ''}`} />
            <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{t('nav.account')}</span>
          </button>
        </span>
      </div>
    </nav>
  );
}
