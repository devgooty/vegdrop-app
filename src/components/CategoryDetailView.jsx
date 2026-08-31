import React, { useState } from 'react';
import { ArrowLeft, Search, Filter, Sparkles } from 'lucide-react';
import ProductGridCard from './ProductGridCard';
import { useLanguage } from '../i18n/LanguageContext';
import { categoryTitle, categoryBadge, productName } from '../i18n/catalog';
import { dedupeByCatalogItem } from '../services/products';

export default function CategoryDetailView({ category, products, cartItems, onAddToCart, onUpdateQuantity, onBack, onSelectProduct }) {
  const { t, language } = useLanguage();
  const title = categoryTitle(category, language);
  const [search, setSearch] = useState('');
  const [filterOrganic, setFilterOrganic] = useState(false);
  const [sortBy, setSortBy] = useState('popular');

  // Deduped before anything else, so the count shown in the header and
  // "Showing N" both agree with the number of cards actually rendered below.
  let categoryProducts = dedupeByCatalogItem(products.filter((p) => p.categoryId === category.id));

  if (search) {
    // Matched against the English name as well as the displayed one, so a
    // shopper typing either finds the same shelf.
    const query = search.toLowerCase();
    categoryProducts = categoryProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        productName(p, language).toLowerCase().includes(query)
    );
  }

  if (filterOrganic) {
    categoryProducts = categoryProducts.filter((p) => p.isOrganic);
  }

  if (sortBy === 'price-low') {
    categoryProducts.sort((a, b) => a.price - b.price);
  } else if (sortBy === 'price-high') {
    categoryProducts.sort((a, b) => b.price - a.price);
  } else if (sortBy === 'rating') {
    categoryProducts.sort((a, b) => b.rating - a.rating);
  }

  return (
    <div className="min-h-screen bg-[#F6F3EC] flex flex-col pb-20 animate-fade-in">
      {/* Header Bar */}
      <header className="bg-[#FAF7F2] p-3 pt-safe-3 shadow-xs sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-[#DCD5C6]">
        <button
          onClick={onBack}
          className="skeuo-btn-light p-1 px-2.5 rounded-full transition-all flex items-center gap-1 text-xs font-bold cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5 text-[#1B4D3E]" />
          <span>{t('common.back')}</span>
        </button>

        <h1 className="font-vintage font-extrabold text-sm text-[#1B4D3E] truncate tracking-tight">{title}</h1>

        <span className="bg-[#EAE4D7] text-[#1B4D3E] text-[11.5px] font-bold px-2 py-0.5 rounded-full border border-[#D5CDBC] shadow-2xs">
          {categoryProducts.length === 1
            ? t('categoryView.itemOne')
            : t('categoryView.items', { count: categoryProducts.length })}
        </span>
      </header>

      {/* Category Hero Banner */}
      <div className="relative h-32 mx-4 mt-3 rounded-2xl overflow-hidden shadow-md border border-[#DCD5C6] flex-shrink-0">
        <img
          src={category.imageUrl}
          alt={title}
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent flex flex-col justify-end p-3 text-white">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="bg-[#EAE4D7] text-[#1B4D3E] text-[9.5px] font-extrabold px-1.5 py-0.2 rounded-md border border-[#D5CDBC] uppercase tracking-wider">
              {categoryBadge(category.badge, language) || t('categoryView.freshHarvest')}
            </span>
            <span className="text-emerald-300 text-[11.5px] font-medium flex items-center gap-0.5">
              <Sparkles className="w-3 h-3" /> {t('categoryView.farmFresh')}
            </span>
          </div>
          <h2 className="font-vintage text-xl font-black text-white leading-tight">{title}</h2>
          <p className="text-[12.5px] text-gray-200 line-clamp-1">{t('categoryView.blurb')}</p>
        </div>
      </div>

      {/* Search & Filter - FIXED NO OVERFLOW */}
      <div className="p-4 py-3 space-y-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('categoryView.searchIn', { category: title })}
              className="w-full skeuo-inset-input rounded-full py-1.5 pl-8 pr-3 text-xs font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
            />
            <Search className="w-3.5 h-3.5 text-[#8A7E6B] absolute left-2.5 top-2" />
          </div>

          <button
            onClick={() => setFilterOrganic(!filterOrganic)}
            className={`px-2.5 py-1.5 rounded-full text-[12.5px] font-bold border transition-all cursor-pointer flex-shrink-0 ${
              filterOrganic
                ? 'skeuo-btn-emerald'
                : 'skeuo-btn-light'
            }`}
          >
            {t('search.organic')}
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-[#7A7060]">
          <span className="font-semibold text-[#2D2A26] text-[12.5px]">
            {categoryProducts.length === 1
              ? t('search.showingOne')
              : t('search.showing', { count: categoryProducts.length })}
          </span>
          <div className="flex items-center gap-1">
            <Filter className="w-3 h-3 text-[#8A7E6B]" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-transparent font-bold text-[#1B4D3E] text-[12.5px] focus:outline-none cursor-pointer"
            >
              <option value="popular">{t('categoryView.mostPopular')}</option>
              <option value="price-low">{t('search.priceLowHigh')}</option>
              <option value="price-high">{t('search.priceHighLow')}</option>
              <option value="rating">{t('search.topRated')}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Products Grid - FIXED CARD HEIGHT & PROPORTIONS */}
      <div className="px-4 grid grid-cols-2 gap-3 items-start pb-6">
        {categoryProducts.length === 0 ? (
          <div className="col-span-2 skeuo-card rounded-2xl p-8 text-center">
            <p className="text-[#8A7E6B] text-xs font-medium">{t('categoryView.noneMatching')}</p>
          </div>
        ) : (
          categoryProducts.map((item) => (
            <ProductGridCard
              key={item.id}
              item={item}
              category={category}
              cartItems={cartItems}
              onAddToCart={onAddToCart}
              onUpdateQuantity={onUpdateQuantity}
              onSelectProduct={onSelectProduct}
            />
          ))
        )}
      </div>
    </div>
  );
}
