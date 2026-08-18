import React, { useState } from 'react';
import { Star, Plus, Minus, ChevronRight, Eye } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { productName, productWeight, categoryTitle } from '../i18n/catalog';
import { packOptions, packLineId } from '../services/packs';

export default function ProductList({
  categories,
  products,
  cartItems,
  onAddToCart,
  onUpdateQuantity,
  onOpenCategoryDetail,
  onSelectProduct
}) {
  const { t, language } = useLanguage();
  return (
    <section className="space-y-6 px-4 pb-6 select-none">
      {categories.map((category, catIndex) => {
        const categoryProducts = products.filter((p) => p.categoryId === category.id);
        if (categoryProducts.length === 0) return null;

        return (
          <div
            key={category.id}
            className="space-y-3 animate-stagger-in"
            style={{ animationDelay: `${catIndex * 100}ms` }}
          >
            {/* Category Header Bar */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="font-vintage text-base font-bold text-[#1B4D3E] tracking-tight">
                  {categoryTitle(category, language)}
                </h3>
                <span className="text-[10px] font-bold text-[#1B4D3E] bg-[#EAE4D7] px-2.5 py-0.5 rounded-full border border-[#D5CDBC] shadow-2xs">
                  {t('list.harvested', { count: categoryProducts.length })}
                </span>
              </div>

              <button
                onClick={() => onOpenCategoryDetail(category)}
                className="text-xs font-bold text-[#C8372D] hover:text-[#9E2A22] flex items-center gap-0.5 hover:underline cursor-pointer"
              >
                <span>{t('list.seeAll')}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* HORIZONTAL PRODUCT ROW */}
            <div className="flex gap-3.5 overflow-x-auto no-scrollbar snap-x snap-mandatory py-1.5 -mx-4 px-4 scroll-smooth">
              {categoryProducts.map((item, prodIndex) => {
                return (
                  <ProductCard
                    key={item.id}
                    item={item}
                    category={category}
                    cartItems={cartItems}
                    onSelectProduct={onSelectProduct}
                    onAddToCart={onAddToCart}
                    onUpdateQuantity={onUpdateQuantity}
                    delayIndex={prodIndex}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// Subcomponent for card to support custom image blur-up loading, entrance animations, and weight variants
function ProductCard({
  item,
  category,
  cartItems,
  onSelectProduct,
  onAddToCart,
  onUpdateQuantity,
  delayIndex
}) {
  // Its own hook rather than props threaded down from ProductList: this is a
  // sibling component in the same file, not a child of that closure.
  const { t, language } = useLanguage();
  const [imgLoaded, setImgLoaded] = useState(false);

  /** Whole multiples of the pack, or no picker at all — see services/packs.js. */
  const variants = packOptions(item);
  const isWeightBased = variants.length > 0;

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
      // Packs, not kilos — checkout multiplies the order quantity by this so
      // the shown price and the charged price are the same arithmetic.
      units: selectedVariant?.units ?? 1,
      price: displayPrice,
      oldPrice: displayOldPrice,
      weight: variantWeightStr,
      // Stays English on purpose. This is the line's stored record, which order
      // history and support read; the Telugu/Hindi names ride along as their own
      // fields and productName() resolves the display name at render time.
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
    <div
      className="w-44 flex-shrink-0 snap-start skeuo-card-interactive rounded-2xl p-2.5 flex flex-col justify-between group cursor-pointer animate-fade-in"
      style={{ animationDelay: `${delayIndex * 80}ms` }}
    >
      {/* Clickable Image & Info */}
      <div onClick={handleSelect}>
        <div className="relative mb-2">
          {/* Lazy Load Blur-up Container */}
          <div className="w-full h-28 rounded-xl overflow-hidden bg-[#F3EFE6] border border-[#E5DFD1] shadow-inner relative">
            
            {/* Low-quality placeholder */}
            {!imgLoaded && (
              <div className="absolute inset-0 bg-[#EFECE4] animate-shimmer bg-gradient-to-r from-[#EFECE4] via-[#F5F2EA] to-[#EFECE4] bg-[length:200%_100%]" />
            )}

            <img
              src={item.image}
              alt={productName(item, language)}
              onLoad={() => setImgLoaded(true)}
              className={`w-full h-full object-cover group-hover:scale-105 transition-all duration-500 img-lazy ${
                imgLoaded ? 'loaded' : ''
              } ${item.stock === 0 ? 'grayscale opacity-75' : ''}`}
              onError={(e) => {
                e.target.src = 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=300';
                setImgLoaded(true);
              }}
            />

            {/* Quick View Hover Indicator Overlay */}
            <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-200">
              <span className="bg-white/90 backdrop-blur-xs text-[#1B4D3E] font-bold text-[10px] px-2 py-1 rounded-full flex items-center gap-1 shadow-md border border-[#E5DFD1]">
                <Eye className="w-3.5 h-3.5" />
                {t('list.quickView')}
              </span>
            </div>

            {item.stock === 0 && (
              <div className="absolute inset-0 bg-black/55 flex items-center justify-center p-1">
                <span className="bg-rose-600 text-white font-extrabold text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full shadow-xs">
                  {t('product.soldOut')}
                </span>
              </div>
            )}
          </div>

          {item.isOrganic && (
            <span className="bg-[#EAE4D7] text-[#1B4D3E] border border-[#D5CDBC] absolute top-1.5 left-1.5 text-[8px] font-extrabold px-1.5 py-0.5 rounded-md uppercase tracking-wider shadow-2xs">
              {t('product.organic')}
            </span>
          )}
          
          <div className="absolute bottom-1.5 right-1.5 bg-[#FFFDF9]/95 backdrop-blur-xs px-1.5 py-0.5 rounded-md text-[10px] font-bold text-[#2D2A26] flex items-center gap-0.5 border border-[#E0D9C8] shadow-xs">
            <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
            <span>{item.rating}</span>
          </div>
        </div>

        <div>
          <h4 className="font-vintage font-bold text-xs text-[#2D2A26] line-clamp-1 group-hover:text-[#1B4D3E] transition-colors">
            {productName(item, language)}
          </h4>

          {/*
            Which market this price belongs to. Only present when browsing a
            market — the platform catalog has no store behind it, and an empty
            line there would just be a gap.
          */}
          {item.marketName && (
            <p className="text-[10px] font-semibold text-[#1B4D3E] line-clamp-1 -mt-0.5 mb-0.5">
              {item.marketName}
            </p>
          )}

          <div className="flex items-center justify-between mb-1">
            <p className="text-[11px] text-[#7A7060] font-semibold">{variantWeightStr}</p>
            {item.stock > 0 && item.stock <= 5 && (
              <span className="text-[9px] font-bold text-amber-700 bg-amber-50 px-1 rounded animate-pulse">
                {t('list.onlyLeft', { count: item.stock })}
              </span>
            )}
          </div>
          
          {/* Weight Variants Selector */}
          {isWeightBased && (
            <div className="flex items-center gap-0.5 mt-0.5 mb-1 bg-[#F3EFE6] p-0.5 rounded-lg border border-[#E5DFD1]">
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

      {/* Price & Cart Actions */}
      <div className="flex items-center justify-between pt-1.5 border-t border-[#EFEBE0]">
        <div>
          <span className="font-vintage font-black text-sm text-[#1B4D3E]">₹{displayPrice}</span>
          {displayOldPrice && (
            <span className="text-[9px] text-[#9A8F7C] line-through ml-1">₹{displayOldPrice}</span>
          )}
        </div>

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
              <Minus className="w-3.5 h-3.5 stroke-[3]" />
            </button>
            <span className="text-xs font-black px-1.5 min-w-4 text-center text-white">
              {inCart.quantity}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (inCart.quantity < item.stock) {
                  onUpdateQuantity(variantId, 1);
                }
              }}
              className={`p-1 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90 ${
                inCart.quantity >= item.stock ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              title={t('product.increaseQty')}
            >
              <Plus className="w-3.5 h-3.5 stroke-[3]" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleAdd}
            className="skeuo-btn-emerald font-extrabold px-2.5 py-1 rounded-xl text-xs flex items-center gap-1 cursor-pointer active:scale-95 transition-all shadow-2xs hover:shadow-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('product.add')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
