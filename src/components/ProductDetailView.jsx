import React, { useState } from 'react';
import { ArrowLeft, Star, ShieldCheck, Truck, Sparkles, Plus, Minus, Check, Heart, Share2, Camera } from 'lucide-react';
import RelatedProducts from './RelatedProducts';
import { shareProduct } from '../services/share';
import { useLanguage } from '../i18n/LanguageContext';
import { productName, productWeight, categoryTitle } from '../i18n/catalog';
import { packOptions, packLineId } from '../services/packs';
import { isWishlisted, toggleWishlist } from '../services/wishlist';

export default function ProductDetailView({
  product,
  category,
  cartItems,
  onAddToCart,
  onUpdateQuantity,
  onBack,
  products = [],
  categories = [],
  onSelectProduct,
  onOpenCategory,
  onShared,
}) {
  const { t, language } = useLanguage();
  const [isLiked, setIsLiked] = useState(() => isWishlisted(product));

  const handleShare = async () => {
    const result = await shareProduct(product);
    // 'shared' needs nothing said — the OS sheet already confirmed it — and
    // 'cancelled' means the shopper backed out on purpose.
    if (result === 'copied') onShared?.('copied');
    else if (result === 'failed') onShared?.('failed');
  };

  // Sizes are whole multiples of the pack, or there are none — services/packs.js.
  const variants = packOptions(product);
  const isWeightBased = variants.length > 0;

  /**
   * Whatever size the card that opened this was showing, so tapping through
   * does not silently change what the shopper had chosen. Falls back to the
   * pack itself.
   */
  const initialVariant =
    variants.find((v) => v.label === product.selectedVariantLabel) || variants[0] || null;

  const [selectedVariant, setSelectedVariant] = useState(initialVariant);

  const displayPrice = selectedVariant ? selectedVariant.price : product.price;
  const displayOldPrice = selectedVariant ? selectedVariant.oldPrice : product.oldPrice;

  const variantId = selectedVariant ? packLineId(product.id, selectedVariant.units) : product.id;
  const variantWeightStr = selectedVariant ? selectedVariant.label : product.weight;

  const inCart = cartItems.find((c) => c.id === variantId);

  const discountPercent = displayOldPrice
    ? Math.round(((displayOldPrice - displayPrice) / displayOldPrice) * 100)
    : 0;

  const handleAdd = (e) => {
    e.stopPropagation();
    onAddToCart({
      ...product,
      id: variantId,
      originalId: product.id,
      // Packs, not kilos — checkout multiplies the order quantity by this.
      units: selectedVariant?.units ?? 1,
      price: displayPrice,
      oldPrice: displayOldPrice,
      weight: variantWeightStr,
      name: isWeightBased ? `${product.name} (${variantWeightStr})` : product.name
    }, e);
  };

  return (
    <div className="min-h-screen bg-[#F6F3EC] flex flex-col pb-6 animate-fade-in">
      {/* 1. Header Bar with Back Button */}
      <header className="bg-[#FAF7F2] p-3.5 pt-safe-3.5 shadow-xs sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-[#DCD5C6]">
        <button
          onClick={onBack}
          className="skeuo-btn-light p-1.5 px-3 rounded-full transition-all flex items-center gap-1 text-xs font-bold cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4 text-[#1B4D3E]" />
          <span>
            {t('product.backTo', {
              category: category ? categoryTitle(category, language) : t('product.category'),
            })}
          </span>
        </button>

        <span className="font-vintage font-bold text-xs text-[#1B4D3E]">
          {category ? categoryTitle(category, language) : t('product.harvestDetails')}
        </span>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsLiked(toggleWishlist(product))}
            aria-label={isLiked ? t('product.unlike') : t('product.like')}
            className="p-2 rounded-full bg-white border border-[#DCD5C6] shadow-2xs cursor-pointer"
          >
            <Heart className={`w-4 h-4 ${isLiked ? 'text-red-500 fill-red-500' : 'text-[#8A7E6B]'}`} />
          </button>
          <button
            onClick={handleShare}
            aria-label={t('product.share', { name: productName(product, language) })}
            className="p-2 rounded-full bg-white border border-[#DCD5C6] shadow-2xs cursor-pointer"
          >
            <Share2 className="w-4 h-4 text-[#8A7E6B]" />
          </button>
        </div>
      </header>

      {/* 2. Big Product Image Hero */}
      <div className="relative mx-4 mt-3 rounded-3xl overflow-hidden bg-[#FAF7F2] border border-[#DCD5C6] shadow-md p-3">
        <div className="relative h-64 w-full rounded-2xl overflow-hidden bg-[#F0EBE1]">
          <img
            src={product.image}
            alt={productName(product, language)}
            className="w-full h-full object-cover"
            onError={(e) => {
              e.target.src = 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=500';
            }}
          />

          {product.isOrganic && (
            <span className="skeuo-badge-emerald absolute top-3 left-3 text-white text-[10px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm">
              🌿 {t('product.certifiedOrganic')}
            </span>
          )}

          {discountPercent > 0 && (
            <span className="skeuo-badge-amber absolute top-3 right-3 text-white text-[10px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm">
              {t('product.save', { percent: discountPercent })}
            </span>
          )}
        </div>
      </div>

      {/*
        What is actually on the table, photographed by a stall in this market.

        Shown alongside the catalog image rather than replacing it, and captioned
        with when it was taken — the point is that the customer can tell the
        difference between a stock photograph and the real produce, which means
        both have to be visible. Hidden entirely if the image fails to load, so a
        missing photo leaves no empty frame behind.
      */}
      {product.freshPhotoUrl && (
        <FreshPhoto url={product.freshPhotoUrl} takenAt={product.freshPhotoAt} />
      )}

      {/* 3. Product Info Card */}
      <div className="p-4 space-y-4 flex-1">
        <div className="skeuo-card rounded-2xl p-4 space-y-3">
          <div className="flex justify-between items-start gap-2">
            <div>
              <h1 className="font-vintage text-2xl font-black text-[#1B4D3E] leading-tight">
                {productName(product, language)}
              </h1>
              <p className="text-xs font-semibold text-[#7A7060] mt-0.5">
                {t('product.baseQuantity')} {productWeight(product.weight, language)}
              </p>
            </div>

            <div className="text-right">
              <div className="font-vintage font-extrabold text-2xl text-[#1B4D3E]">₹{displayPrice}</div>
              {displayOldPrice && (
                <div className="text-xs text-[#9A8F7C] line-through font-medium">
                  {t('product.mrp')} ₹{displayOldPrice}
                </div>
              )}
            </div>
          </div>

          {/* Add to Cart control for this item, right where its price is */}
          <div className="flex justify-end">
            {inCart ? (
              <div className="skeuo-btn-emerald flex items-center rounded-xl p-1 shadow-sm">
                <button
                  onClick={(e) => onUpdateQuantity(variantId, -1)}
                  className="p-1.5 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
                  title={t('product.decrease')}
                >
                  <Minus className="w-4 h-4 stroke-[3]" />
                </button>
                <span className="text-sm font-black px-3 min-w-8 text-center text-white">
                  {inCart.quantity}
                </span>
                <button
                  onClick={(e) => onUpdateQuantity(variantId, 1, e, product)}
                  className="p-1.5 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
                  title={t('product.increase')}
                >
                  <Plus className="w-4 h-4 stroke-[3]" />
                </button>
              </div>
            ) : (
              <button
                onClick={handleAdd}
                className="skeuo-btn-emerald font-extrabold px-4 py-2 rounded-xl text-sm flex items-center gap-1.5 cursor-pointer active:scale-95 shadow-sm"
              >
                <Plus className="w-4 h-4" />
                <span>{t('product.add')}</span>
              </button>
            )}
          </div>

          {/* Detailed Weight Variants Selector */}
          {isWeightBased && (
            <div className="pt-2 border-t border-[#EFEBE0]">
              <p className="text-[10px] font-bold text-[#8A7E6B] mb-2 uppercase tracking-wider">
                {t('product.selectWeight')}
              </p>
              <div className="flex items-center gap-2 bg-[#F3EFE6] p-1.5 rounded-xl border border-[#E5DFD1]">
                {variants.map(v => (
                  <button
                    key={v.label}
                    onClick={() => setSelectedVariant(v)}
                    className={`flex-1 text-xs font-extrabold py-2 rounded-lg transition-all ${
                      selectedVariant?.label === v.label 
                        ? 'bg-white text-[#1B4D3E] shadow-md border border-[#D5CDBC] scale-105 transform z-10' 
                        : 'text-[#8A7E6B] hover:text-[#1B4D3E] border border-transparent'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Rating Badge */}
          <div className="flex items-center gap-2 pt-2 border-t border-[#EFEBE0]">
            <div className="bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-lg flex items-center gap-1 text-xs font-bold text-amber-800">
              <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
              <span>{product.rating}</span>
            </div>
            <span className="text-xs text-[#7A7060] font-medium">
              {t('product.reviews', { count: product.reviews || 120 })}
            </span>
          </div>
        </div>

        {/* 4. Farm Quality Assurances */}
        <div className="grid grid-cols-2 gap-3">
          <div className="skeuo-card rounded-xl p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-100/80 text-emerald-800">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-[#1B4D3E]">{t('product.pesticideFree')}</h4>
              <p className="text-[10px] text-[#7A7060]">{t('product.pesticideFreeSub')}</p>
            </div>
          </div>

          <div className="skeuo-card rounded-xl p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-100/80 text-amber-800">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-[#1B4D3E]">{t('product.fastDelivery')}</h4>
              <p className="text-[10px] text-[#7A7060]">{t('product.fastDeliverySub')}</p>
            </div>
          </div>
        </div>

        {/* 5. Product Description */}
        <div className="skeuo-card rounded-2xl p-4 space-y-2">
          <h3 className="font-vintage text-sm font-bold text-[#1B4D3E]">{t('product.storyTitle')}</h3>
          <p className="text-xs text-[#4A443B] leading-relaxed">{t('product.storyBody')}</p>
        </div>

        {/* 6. The shop carries on below the fold */}
        <RelatedProducts
          product={product}
          category={category}
          products={products}
          categories={categories}
          cartItems={cartItems}
          onAddToCart={onAddToCart}
          onUpdateQuantity={onUpdateQuantity}
          onSelectProduct={onSelectProduct}
          onOpenCategory={onOpenCategory}
        />
      </div>
    </div>
  );
}

/**
 * The photograph a stall took of the produce it is actually holding.
 *
 * Self-hiding on error: the image is served from a route that 404s once the
 * photo is older than a day, and a race between the catalog saying "there is
 * one" and the photo expiring would otherwise leave a broken frame on the page.
 */
function FreshPhoto({ url, takenAt }) {
  const { t } = useLanguage();
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return (
    <div className="mx-4 mt-3 rounded-3xl overflow-hidden bg-[#FAF7F2] border border-[#DCD5C6] shadow-md p-3">
      <div className="flex items-center gap-1.5 mb-2 px-0.5">
        <Camera className="w-3.5 h-3.5 text-[#1B4D3E]" />
        <p className="text-[11px] font-black text-[#1B4D3E] uppercase tracking-wider">
          {t('freshPhoto.title')}
        </p>
      </div>
      <div className="relative h-56 w-full rounded-2xl overflow-hidden bg-[#F0EBE1]">
        <img
          src={url}
          alt={t('freshPhoto.alt')}
          loading="lazy"
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      </div>
      <p className="text-[10px] text-[#7A736A] mt-2 px-0.5">
        {t('freshPhoto.caption', { age: describeAge(takenAt, t) })}
      </p>
    </div>
  );
}

/** "3 hours ago", for a photo caption. Takes `t` so it stays a plain function. */
function describeAge(when, t) {
  if (!when) return t('freshPhoto.ageToday');
  const minutes = Math.round((Date.now() - new Date(when).getTime()) / 60000);
  if (minutes < 60) return t('freshPhoto.ageMinutes', { count: Math.max(1, minutes) });
  const hours = Math.round(minutes / 60);
  if (hours === 1) return t('freshPhoto.ageHourOne');
  if (hours < 24) return t('freshPhoto.ageHours', { count: hours });
  return t('freshPhoto.ageYesterday');
}
