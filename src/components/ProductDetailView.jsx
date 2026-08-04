import React, { useState } from 'react';
import { ArrowLeft, Star, ShieldCheck, Truck, Sparkles, Plus, Minus, Check, Heart, Share2 } from 'lucide-react';
import RelatedProducts from './RelatedProducts';

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
}) {
  const [isLiked, setIsLiked] = useState(false);

  // Weight Variants Logic
  const isWeightBased = product.weight && (product.weight.toLowerCase().includes('g') || product.weight.toLowerCase().includes('kg')) && !product.weight.toLowerCase().includes('pack');
  
  const weightVariants = [
    { label: '250g', factor: 0.25 },
    { label: '500g', factor: 0.5 },
    { label: '750g', factor: 0.75 },
    { label: '1kg', factor: 1 }
  ];

  let nativeFactor = 1;
  const weightStr = product.weight ? product.weight.toLowerCase() : '';
  if (weightStr.includes('250g')) nativeFactor = 0.25;
  else if (weightStr.includes('500g')) nativeFactor = 0.5;
  else if (weightStr.includes('750g')) nativeFactor = 0.75;
  else if (weightStr.includes('100g')) nativeFactor = 0.1;

  const basePricePerKg = product.price / nativeFactor;
  const oldBasePricePerKg = product.oldPrice ? product.oldPrice / nativeFactor : null;

  const initialVariant = isWeightBased 
    ? weightVariants.find(v => v.label === product.selectedVariantLabel) || 
      weightVariants.find(v => v.label.toLowerCase() === weightStr.replace('gm', 'g')) || 
      weightVariants[3]
    : null;

  const [selectedVariant, setSelectedVariant] = useState(initialVariant);

  const displayPrice = isWeightBased && selectedVariant 
    ? Math.round(basePricePerKg * selectedVariant.factor) 
    : product.price;
    
  const displayOldPrice = isWeightBased && selectedVariant && oldBasePricePerKg
    ? Math.round(oldBasePricePerKg * selectedVariant.factor)
    : product.oldPrice;

  const variantId = isWeightBased && selectedVariant ? `${product.id}-${selectedVariant.label}` : product.id;
  const variantWeightStr = isWeightBased && selectedVariant ? selectedVariant.label : product.weight;

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
      price: displayPrice,
      oldPrice: displayOldPrice,
      weight: variantWeightStr,
      name: isWeightBased ? `${product.name} (${variantWeightStr})` : product.name
    }, e);
  };

  return (
    <div className="min-h-screen bg-[#F6F3EC] flex flex-col pb-24 animate-fade-in">
      {/* 1. Header Bar with Back Button */}
      <header className="bg-[#FAF7F2] p-3.5 shadow-xs sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-[#DCD5C6]">
        <button
          onClick={onBack}
          className="skeuo-btn-light p-1.5 px-3 rounded-full transition-all flex items-center gap-1 text-xs font-bold cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4 text-[#1B4D3E]" />
          <span>Back to {category ? category.title : 'Category'}</span>
        </button>

        <span className="font-vintage font-bold text-xs text-[#1B4D3E]">
          {category ? category.title : 'Harvest Details'}
        </span>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsLiked(!isLiked)}
            className="p-2 rounded-full bg-white border border-[#DCD5C6] shadow-2xs cursor-pointer"
          >
            <Heart className={`w-4 h-4 ${isLiked ? 'text-red-500 fill-red-500' : 'text-[#8A7E6B]'}`} />
          </button>
          <button className="p-2 rounded-full bg-white border border-[#DCD5C6] shadow-2xs cursor-pointer">
            <Share2 className="w-4 h-4 text-[#8A7E6B]" />
          </button>
        </div>
      </header>

      {/* 2. Big Product Image Hero */}
      <div className="relative mx-4 mt-3 rounded-3xl overflow-hidden bg-[#FAF7F2] border border-[#DCD5C6] shadow-md p-3">
        <div className="relative h-64 w-full rounded-2xl overflow-hidden bg-[#F0EBE1]">
          <img
            src={product.image}
            alt={product.name}
            className="w-full h-full object-cover"
            onError={(e) => {
              e.target.src = 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=500';
            }}
          />

          {product.isOrganic && (
            <span className="skeuo-badge-emerald absolute top-3 left-3 text-white text-[10px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm">
              🌿 100% Certified Organic
            </span>
          )}

          {discountPercent > 0 && (
            <span className="skeuo-badge-amber absolute top-3 right-3 text-white text-[10px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm">
              Save {discountPercent}%
            </span>
          )}
        </div>
      </div>

      {/* 3. Product Info Card */}
      <div className="p-4 space-y-4 flex-1">
        <div className="skeuo-card rounded-2xl p-4 space-y-3">
          <div className="flex justify-between items-start gap-2">
            <div>
              <h1 className="font-vintage text-2xl font-black text-[#1B4D3E] leading-tight">{product.name}</h1>
              <p className="text-xs font-semibold text-[#7A7060] mt-0.5">Base Quantity: {product.weight}</p>
            </div>

            <div className="text-right">
              <div className="font-vintage font-extrabold text-2xl text-[#1B4D3E]">₹{displayPrice}</div>
              {displayOldPrice && (
                <div className="text-xs text-[#9A8F7C] line-through font-medium">M.R.P: ₹{displayOldPrice}</div>
              )}
            </div>
          </div>
          
          {/* Detailed Weight Variants Selector */}
          {isWeightBased && (
            <div className="pt-2 border-t border-[#EFEBE0]">
              <p className="text-[10px] font-bold text-[#8A7E6B] mb-2 uppercase tracking-wider">Select Weight</p>
              <div className="flex items-center gap-2 bg-[#F3EFE6] p-1.5 rounded-xl border border-[#E5DFD1]">
                {weightVariants.map(v => (
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
            <span className="text-xs text-[#7A7060] font-medium">({product.reviews || 120} verified customer reviews)</span>
          </div>
        </div>

        {/* 4. Farm Quality Assurances */}
        <div className="grid grid-cols-2 gap-3">
          <div className="skeuo-card rounded-xl p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-100/80 text-emerald-800">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-[#1B4D3E]">100% Pesticide Free</h4>
              <p className="text-[10px] text-[#7A7060]">Lab tested clean harvest</p>
            </div>
          </div>

          <div className="skeuo-card rounded-xl p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-100/80 text-amber-800">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-[#1B4D3E]">15-Min Delivery</h4>
              <p className="text-[10px] text-[#7A7060]">Cold chain fresh express</p>
            </div>
          </div>
        </div>

        {/* 5. Product Description */}
        <div className="skeuo-card rounded-2xl p-4 space-y-2">
          <h3 className="font-vintage text-sm font-bold text-[#1B4D3E]">Harvest Story & Details</h3>
          <p className="text-xs text-[#4A443B] leading-relaxed">
            Freshly harvested from organic partner farms in Ooty and Nilgiri hills. Grown using sustainable composting without chemical pesticides. Rich in essential vitamins, minerals, and natural antioxidants.
          </p>
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

      {/* 7. Sticky Bottom Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-[#FAF7F2] border-t border-[#DCD5C6] p-3.5 px-4 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] z-30 flex items-center justify-between gap-4">
        <div>
          <span className="text-[10px] text-[#7A7060] font-bold uppercase tracking-wider block">Total Amount</span>
          <span className="font-vintage font-black text-xl text-[#1B4D3E]">₹{(displayPrice * (inCart ? inCart.quantity : 1)).toFixed(0)}</span>
        </div>

        {inCart ? (
          <div className="skeuo-btn-emerald flex items-center rounded-xl p-1 shadow-md px-2">
            <button
              onClick={(e) => onUpdateQuantity(variantId, -1)}
              className="p-1.5 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
              title="Decrease"
            >
              <Minus className="w-4 h-4 stroke-[3]" />
            </button>
            <span className="text-sm font-black px-3 min-w-8 text-center text-white">
              {inCart.quantity} in Cart
            </span>
            <button
              onClick={(e) => onUpdateQuantity(variantId, 1, e, product)}
              className="p-1.5 hover:bg-[#143B2B] rounded-lg transition-colors cursor-pointer active:scale-90"
              title="Increase"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleAdd}
            className="skeuo-btn-emerald flex-1 font-extrabold py-3 rounded-xl text-sm flex items-center justify-center gap-2 cursor-pointer active:scale-95 shadow-md"
          >
            <Plus className="w-4 h-4" />
            <span>Add to Cart</span>
          </button>
        )}
      </div>
    </div>
  );
}
