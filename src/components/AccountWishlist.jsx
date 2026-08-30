import React, { useState } from 'react';
import { Heart, Plus, Minus, HeartCrack } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { productName } from '../i18n/catalog';
import { getWishlist, removeFromWishlist } from '../services/wishlist';

/**
 * The "My Wishlist" screen in the Account tab.
 *
 * Reads and writes through services/wishlist.js the same way AccountAddress
 * does through services/address.js — this screen is a second door onto that
 * one value (the first is the Heart button on the product page), not a state
 * of its own, so unliking here and unliking there can never disagree.
 */
export default function AccountWishlist({ cartItems, onAddToCart, onUpdateQuantity, onSelectProduct }) {
  const { t, language } = useLanguage();
  const [items, setItems] = useState(() => getWishlist());

  const handleRemove = (key) => {
    removeFromWishlist(key);
    setItems((prev) => prev.filter((entry) => entry.key !== key));
  };

  if (items.length === 0) {
    return (
      <div className="bg-slate-50 border border-slate-100 rounded-3xl p-8 text-center text-slate-400 animate-fade-in">
        <Heart className="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p className="font-bold text-sm">{t('account.wishlistEmpty')}</p>
        <p className="text-xs font-medium mt-1 opacity-70">{t('account.wishlistEmptySub')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 text-left animate-fade-in w-full max-w-md mx-auto">
      {items.map((item) => {
        const inCart = cartItems.find((c) => c.id === item.id);

        return (
          <div
            key={item.key}
            onClick={() => onSelectProduct(item)}
            className="flex items-center gap-3 bg-white/90 backdrop-blur-sm p-2.5 rounded-2xl border border-white/50 shadow-sm cursor-pointer active:scale-[0.98] transition-all"
          >
            <img src={item.image} alt={item.name} className="w-14 h-14 object-cover rounded-xl bg-slate-50 shrink-0" />
            <div className="flex-1 min-w-0">
              <h4 className="font-bold text-xs text-slate-800 line-clamp-1">{productName(item, language)}</h4>
              <span className="text-sm font-black text-[#1B4D3E]">₹{item.price}</span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
              {item.stock === 0 ? (
                <span className="text-[10px] font-bold text-slate-400 px-2">{t('product.soldOut')}</span>
              ) : inCart ? (
                <div className="skeuo-btn-emerald flex items-center rounded-xl p-0.5 shadow-sm">
                  <button
                    onClick={() => onUpdateQuantity(item.id, -1)}
                    className="p-1 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
                    title={t('product.decreaseQty')}
                  >
                    <Minus className="w-3 h-3 stroke-[3]" />
                  </button>
                  <span className="text-xs font-black px-1.5 min-w-4 text-center text-white">{inCart.quantity}</span>
                  <button
                    onClick={(e) => onUpdateQuantity(item.id, 1, e, item)}
                    className="p-1 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
                    title={t('product.increaseQty')}
                  >
                    <Plus className="w-3 h-3 stroke-[3]" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => onAddToCart({ ...item, originalId: item.id, units: 1 }, e)}
                  className="skeuo-btn-emerald font-extrabold px-2.5 py-1.5 rounded-xl text-xs flex items-center gap-1 cursor-pointer active:scale-95"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t('product.add')}</span>
                </button>
              )}

              <button
                onClick={() => handleRemove(item.key)}
                title={t('account.removeFromWishlist')}
                className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer border border-transparent hover:border-red-100 bg-white shadow-xs"
              >
                <HeartCrack className="w-4 h-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
