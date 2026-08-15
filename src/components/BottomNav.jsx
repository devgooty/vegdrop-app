import React from 'react';
import { Home, ShoppingBasket, UserCheck, Package, TrendingUp } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

export default function BottomNav({ activeTab, setActiveTab, cartCount, onOpenCart, cartOpen, cartBump, userRole }) {
  const { t } = useLanguage();
  // While the basket covers the screen, none of the route tabs are where the
  // shopper actually is — only Cart should read as active. Without this,
  // whichever tab was active underneath (Home, most often) stayed highlighted
  // while the basket sat on top of it.
  const routeActive = (tab) => !cartOpen && activeTab === tab;

  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-[#FAF7F2]/95 backdrop-blur-md border-t border-[#DCD5C6] flex justify-around py-2.5 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] z-30 px-2 pb-safe">
      {/* Home Tab */}
      <button
        onClick={() => setActiveTab('home')}
        className={`flex flex-col items-center py-1 px-3 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
          routeActive('home')
            ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)] -translate-y-1'
            : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5 hover:-translate-y-0.5'
        }`}
      >
        <Home className={`w-5 h-5 transition-transform duration-300 ${routeActive('home') ? 'scale-110' : ''}`} />
        <span className="text-[11px] font-semibold mt-1">{t('nav.home')}</span>
      </button>

      {/* Prices Tab */}
      <button
        onClick={() => setActiveTab('prices')}
        className={`flex flex-col items-center py-1 px-3 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
          routeActive('prices')
            ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)] -translate-y-1'
            : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5 hover:-translate-y-0.5'
        }`}
      >
        <TrendingUp className={`w-5 h-5 transition-transform duration-300 ${routeActive('prices') ? 'scale-110' : ''}`} />
        <span className="text-[11px] font-semibold mt-1">{t('nav.prices')}</span>
      </button>

      {/* Cart Button */}
      <button
        id="bottom-cart-button"
        onClick={onOpenCart}
        className={`flex flex-col items-center py-1 px-3 rounded-2xl relative transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
          cartOpen || cartBump
            ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)] -translate-y-1'
            : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5 hover:-translate-y-0.5'
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
        <span className="text-[11px] font-semibold mt-1">{t('nav.cart')}</span>
      </button>

      {/* Orders Tab - Only for customers or guests */}
      {(!userRole || userRole === 'customer') && (
        <button
          onClick={() => setActiveTab('orders')}
          className={`flex flex-col items-center py-1 px-3 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
            routeActive('orders')
              ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)] -translate-y-1'
              : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5 hover:-translate-y-0.5'
          }`}
        >
          <Package className={`w-5 h-5 transition-transform duration-300 ${routeActive('orders') ? 'scale-110' : ''}`} />
          <span className="text-[11px] font-semibold mt-1">{t('nav.orders')}</span>
        </button>
      )}

      {/* Account Tab */}
      <button
        onClick={() => setActiveTab('account')}
        className={`flex flex-col items-center py-1 px-3 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
          routeActive('account')
            ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)] -translate-y-1'
            : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5 hover:-translate-y-0.5'
        }`}
      >
        <UserCheck className={`w-5 h-5 transition-transform duration-300 ${routeActive('account') ? 'scale-110' : ''}`} />
        <span className="text-[11px] font-semibold mt-1">{t('nav.account')}</span>
      </button>
    </nav>
  );
}
