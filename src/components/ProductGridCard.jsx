import React, { useState } from 'react';
import { Star, Plus, Minus, Camera } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { productName, productWeight } from '../i18n/catalog';
import { packOptions, packLineId } from '../services/packs';

/**
 * The two-per-row product card.
 *
 * Lifted out of CategoryDetailView unchanged so the search results screen shows
 * the same card rather than a third copy of the weight-variant arithmetic —
 * there were already two, and they had drifted apart on the stock cap.
 *
 * `category` is passed in rather than looked up because results span sections:
 * it travels with the product into the detail view, which needs it for its own
 * breadcrumb.
 */
export default function ProductGridCard({
  item,
  category,
  cartItems,
  onAddToCart,
  onUpdateQuantity,
  onSelectProduct
}) {
  const { t, language } = useLanguage();
  /**
   * Sizes are whole multiples of the pack this shop sells, or there are none.
   * See services/packs.js for why a quarter of a 1kg pack is not on the menu
   * and a bunch of coriander no longer has a per-kilo price.
   */
  const variants = packOptions(item);
  const isWeightBased = variants.length > 0;

  // The pack itself, which is what a shopper reaching for "one of those" means.
  const [selectedVariant, setSelectedVariant] = useState(variants[0] || null);

  const displayPrice = selectedVariant ? selectedVariant.price : item.price;
  const displayOldPrice = selectedVariant ? selectedVariant.oldPrice : item.oldPrice;

  const variantId = selectedVariant ? packLineId(item.id, selectedVariant.units) : item.id;
  const variantWeightStr = selectedVariant ? selectedVariant.label : item.weight;

  const inCart = cartItems.find((c) => c.id === variantId);

  const handleAdd = (e) => {
    e.stopPropagation();
    onAddToCart({
      ...item,
      id: variantId,
      originalId: item.id,
      // How many packs this line stands for. Checkout multiplies by it, which
      // is the whole of what makes the shown price and the charged price the
      // same number — see services/packs.js.
      units: selectedVariant?.units ?? 1,
      price: displayPrice,
      oldPrice: displayOldPrice,
      weight: variantWeightStr,
      name: isWeightBased ? `${item.name} (${variantWeightStr})` : item.name
    }, e);
  };

  const handleSelect = () => {
    onSelectProduct({
      ...item,
      selectedVariantLabel: selectedVariant?.label
    }, category);
  };

  return (
    <div className="skeuo-card-interactive rounded-2xl p-2.5 flex flex-col justify-between group cursor-pointer h-[235px]">
      <div onClick={handleSelect} className="flex-1 min-h-0 flex flex-col justify-start">
        <div>
          <div className="relative mb-1.5">
            <div className="w-full h-24 rounded-xl overflow-hidden bg-[#F3EFE6] border border-[#E5DFD1] shadow-inner">
              <img
                src={item.image}
                alt={item.name}
                className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ${
                  item.stock === 0 ? 'grayscale opacity-75' : ''
                }`}
                onError={(e) => {
                  e.target.src = 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=300';
                }}
              />
            </div>

            {item.isOrganic && (
              <span className="bg-[#EAE4D7] text-[#1B4D3E] border border-[#D5CDBC] absolute top-1 left-1 text-[8px] font-extrabold px-1.5 py-0.2 rounded-md uppercase tracking-wider shadow-2xs">
                {t('product.organic')}
              </span>
            )}

            {/*
              A stall in this market photographed the real thing today.

              A badge rather than the photo itself, deliberately: the grid can
              hold two hundred cards, and swapping every one for a real upload
              would be several megabytes on a mobile connection. The photo is
              shown full size in the detail view, one tap away, which is where
              someone is actually deciding whether to buy it.
            */}
            {item.freshPhotoAt && (
              <span className="bg-[#1B4D3E] text-white absolute top-1 right-1 text-[8px] font-extrabold px-1.5 py-0.5 rounded-md uppercase tracking-wider shadow-xs flex items-center gap-0.5">
                <Camera className="w-2.5 h-2.5" />
                {t('product.today')}
              </span>
            )}
            <div className="absolute bottom-1 right-1 bg-[#FFFDF9]/95 backdrop-blur-xs px-1.5 py-0.2 rounded-md text-[9px] font-bold text-[#2D2A26] flex items-center gap-0.5 border border-[#E0D9C8] shadow-xs">
              <Star className="w-2.5 h-2.5 text-amber-500 fill-amber-500" />
              <span>{item.rating}</span>
            </div>
          </div>

          <h3 className="font-semibold text-xs text-[#2D2A26] line-clamp-1 group-hover:text-[#1B4D3E] transition-colors">{productName(item, language)}</h3>
          {/*
            The market this price belongs to. Only present when browsing a
            market — the platform catalog has no store behind it, and an empty
            line there would just be a gap.
          */}
          {item.marketName && (
            <p className="text-[10px] font-semibold text-[#1B4D3E] line-clamp-1">{item.marketName}</p>
          )}
          <p className="text-[10px] text-[#7A7060] font-medium">{productWeight(variantWeightStr, language)}</p>

          {/* Weight Variants Selector */}
          {isWeightBased && (
            <div className="flex items-center gap-0.5 mt-1 bg-[#F3EFE6] p-0.5 rounded-lg border border-[#E5DFD1]">
              {variants.map(v => (
                <button
                  key={v.label}
                  onClick={(e) => { e.stopPropagation(); setSelectedVariant(v); }}
                  className={`flex-1 text-[9px] font-extrabold py-0.5 rounded-md transition-all tracking-tighter ${
                    selectedVariant?.label === v.label
                      ? 'bg-white text-[#1B4D3E] shadow-sm border border-[#D5CDBC]'
                      : 'text-[#8A7E6B] hover:text-[#1B4D3E] border border-transparent'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Price & Steppers */}
      <div className="flex items-center justify-between pt-1.5 border-t border-[#EFEBE0] mt-1.5">
        <div>
          <span className="font-vintage font-bold text-sm text-[#1B4D3E]">₹{displayPrice}</span>
          {displayOldPrice && (
            <span className="text-[9px] text-[#9A8F7C] line-through ml-1">₹{displayOldPrice}</span>
          )}
        </div>

        {/* 3D TACTILE STEPPER BUTTONS */}
        {item.stock === 0 ? (
          <button
            disabled
            className="bg-gray-200 text-gray-400 font-bold px-2 py-1 rounded-xl text-[10px] cursor-not-allowed"
          >
            {t('product.soldOut')}
          </button>
        ) : inCart ? (
          <div className="skeuo-btn-emerald flex items-center rounded-xl p-0.5 shadow-sm" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(variantId, -1);
              }}
              className="p-1 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
              title={t('product.decreaseQty')}
            >
              <Minus className="w-3 h-3 stroke-[3]" />
            </button>
            <span className="text-xs font-black px-1.5 min-w-4 text-center text-white">
              {inCart.quantity}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(variantId, 1, e, item);
              }}
              className="p-1 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
              title={t('product.increaseQty')}
            >
              <Plus className="w-3 h-3 stroke-[3]" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleAdd}
            className="skeuo-btn-emerald font-extrabold px-2.5 py-1 rounded-xl text-xs flex items-center gap-1 cursor-pointer active:scale-95"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('product.add')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
