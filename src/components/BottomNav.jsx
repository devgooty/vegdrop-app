import React, { useState, useEffect, useRef } from 'react';
import { Home, ShoppingBasket, UserCheck, Package, TrendingUp } from 'lucide-react';
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
   * Compared against the last position rather than a running total, so a long
   * scroll down and then a short scroll up shows the bar again immediately —
   * a threshold measured from where scrolling started would make "up" mean
   * "up enough to undo the whole down", which is not what a reversal reads as.
   * The 8px floor near the top keeps the elastic overscroll bounce there from
   * flickering the bar hidden and shown on every rubber-band wobble.
   */
  const [hidden, setHidden] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    const handleScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY.current;
      if (currentY <= 8) {
        setHidden(false);
      } else if (delta > 4) {
        setHidden(true);
      } else if (delta < -4) {
        setHidden(false);
      }
      lastScrollY.current = currentY;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  /**
   * The basket freezes the page behind it, so no scroll event can arrive to
   * bring the bar back. Opening the basket after scrolling down would
   * otherwise leave it hidden for as long as the basket is open — with the
   * only way out being the one small X, since the tabs are the other way back.
   */
  useEffect(() => {
    if (cartOpen) setHidden(false);
  }, [cartOpen]);

  return (
    // Outer element only aligns the pill to the app shell's own width
    // (`max-w-md mx-auto`, the same rule the shell itself uses) and reserves
    // the safe-area inset — it carries no background or border of its own, so
    // it never draws a bar across the full width behind the floating pill.
    <nav
      className="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-30 px-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pointer-events-none"
    >
      <div
        className={`pointer-events-auto bg-[#FAF7F2]/95 backdrop-blur-md border border-[#DCD5C6] rounded-full flex justify-around items-center py-1.5 px-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition-transform duration-200 ease-out ${
          hidden ? 'translate-y-[calc(100%+2rem)]' : 'translate-y-0'
        }`}
      >
        {/* Home Tab */}
        <button
          onClick={() => setActiveTab('home')}
          className={`flex flex-col items-center py-1.5 px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
            routeActive('home')
              ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
              : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
          }`}
        >
          <Home className={`w-5 h-5 transition-transform duration-300 ${routeActive('home') ? 'scale-110' : ''}`} />
          <span className="text-[10px] font-semibold mt-0.5">{t('nav.home')}</span>
        </button>

        {/* Prices Tab */}
        <button
          onClick={() => setActiveTab('prices')}
          className={`flex flex-col items-center py-1.5 px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
            routeActive('prices')
              ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
              : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
          }`}
        >
          <TrendingUp className={`w-5 h-5 transition-transform duration-300 ${routeActive('prices') ? 'scale-110' : ''}`} />
          <span className="text-[10px] font-semibold mt-0.5">{t('nav.prices')}</span>
        </button>

        {/* Cart Button */}
        <button
          id="bottom-cart-button"
          onClick={onOpenCart}
          className={`flex flex-col items-center py-1.5 px-2.5 rounded-full relative transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
            cartOpen || cartBump
              ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
              : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
          } ${cartBump ? 'animate-pop-bump' : ''}`}
        >
          <div className="relative">
            <ShoppingBasket className={`w-5 h-5 transition-transform duration-300 ${cartOpen || cartBump ? 'scale-110' : ''}`} />
            {cartCount > 0 && (
              <span
                className={`skeuo-badge-amber absolute -top-1.5 -right-2.5 text-white text-[10px] font-extrabold px-1.5 py-0.2 rounded-full ring-2 ring-[#FAF7F2] ${
                  cartBump ? 'scale-125' : ''
                } transition-transform duration-300`}
              >
                {cartCount}
              </span>
            )}
          </div>
          <span className="text-[10px] font-semibold mt-0.5">{t('nav.cart')}</span>
        </button>

        {/* Orders Tab - Only for customers or guests */}
        {(!userRole || userRole === 'customer') && (
          <button
            onClick={() => setActiveTab('orders')}
            className={`flex flex-col items-center py-1.5 px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
              routeActive('orders')
                ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
                : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
            }`}
          >
            <Package className={`w-5 h-5 transition-transform duration-300 ${routeActive('orders') ? 'scale-110' : ''}`} />
            <span className="text-[10px] font-semibold mt-0.5">{t('nav.orders')}</span>
          </button>
        )}

        {/* Account Tab */}
        <button
          onClick={() => setActiveTab('account')}
          className={`flex flex-col items-center py-1.5 px-2.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
            routeActive('account')
              ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
              : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
          }`}
        >
          <UserCheck className={`w-5 h-5 transition-transform duration-300 ${routeActive('account') ? 'scale-110' : ''}`} />
          <span className="text-[10px] font-semibold mt-0.5">{t('nav.account')}</span>
        </button>
      </div>
    </nav>
  );
}
