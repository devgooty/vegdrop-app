import React, { useState } from 'react';
import { ArrowLeft, Search, Filter, Sparkles } from 'lucide-react';
import ProductGridCard from './ProductGridCard';

export default function CategoryDetailView({ category, products, cartItems, onAddToCart, onUpdateQuantity, onBack, onSelectProduct }) {
  const [search, setSearch] = useState('');
  const [filterOrganic, setFilterOrganic] = useState(false);
  const [sortBy, setSortBy] = useState('popular');

  let categoryProducts = products.filter((p) => p.categoryId === category.id);

  if (search) {
    categoryProducts = categoryProducts.filter((p) =>
      p.name.toLowerCase().includes(search.toLowerCase())
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
      <header className="bg-[#FAF7F2] p-3 shadow-xs sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-[#DCD5C6]">
        <button
          onClick={onBack}
          className="skeuo-btn-light p-1 px-2.5 rounded-full transition-all flex items-center gap-1 text-xs font-bold cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5 text-[#1B4D3E]" />
          <span>Back</span>
        </button>

        <h1 className="font-vintage font-extrabold text-sm text-[#1B4D3E] truncate tracking-tight">{category.title}</h1>

        <span className="bg-[#EAE4D7] text-[#1B4D3E] text-[10px] font-bold px-2 py-0.5 rounded-full border border-[#D5CDBC] shadow-2xs">
          {categoryProducts.length} Items
        </span>
      </header>

      {/* Category Hero Banner */}
      <div className="relative h-32 mx-4 mt-3 rounded-2xl overflow-hidden shadow-md border border-[#DCD5C6] flex-shrink-0">
        <img
          src={category.imageUrl}
          alt={category.title}
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent flex flex-col justify-end p-3 text-white">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="bg-[#EAE4D7] text-[#1B4D3E] text-[8px] font-extrabold px-1.5 py-0.2 rounded-md border border-[#D5CDBC] uppercase tracking-wider">
              {category.badge || 'Fresh Harvest'}
            </span>
            <span className="text-emerald-300 text-[10px] font-medium flex items-center gap-0.5">
              <Sparkles className="w-3 h-3" /> 100% Farm Fresh
            </span>
          </div>
          <h2 className="font-vintage text-xl font-black text-white leading-tight">{category.title}</h2>
          <p className="text-[11px] text-gray-200 line-clamp-1">Handpicked daily fresh produce directly from local organic farms</p>
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
              placeholder={`Search in ${category.title}...`}
              className="w-full skeuo-inset-input rounded-full py-1.5 pl-8 pr-3 text-xs font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
            />
            <Search className="w-3.5 h-3.5 text-[#8A7E6B] absolute left-2.5 top-2" />
          </div>

          <button
            onClick={() => setFilterOrganic(!filterOrganic)}
            className={`px-2.5 py-1.5 rounded-full text-[11px] font-bold border transition-all cursor-pointer flex-shrink-0 ${
              filterOrganic
                ? 'skeuo-btn-emerald'
                : 'skeuo-btn-light'
            }`}
          >
            Organic
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-[#7A7060]">
          <span className="font-semibold text-[#2D2A26] text-[11px]">Showing {categoryProducts.length} products</span>
          <div className="flex items-center gap-1">
            <Filter className="w-3 h-3 text-[#8A7E6B]" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-transparent font-bold text-[#1B4D3E] text-[11px] focus:outline-none cursor-pointer"
            >
              <option value="popular">Most Popular</option>
              <option value="price-low">Price: Low to High</option>
              <option value="price-high">Price: High to Low</option>
              <option value="rating">Top Rated</option>
            </select>
          </div>
        </div>
      </div>

      {/* Products Grid - FIXED CARD HEIGHT & PROPORTIONS */}
      <div className="px-4 grid grid-cols-2 gap-3 items-start pb-6">
        {categoryProducts.length === 0 ? (
          <div className="col-span-2 skeuo-card rounded-2xl p-8 text-center">
            <p className="text-[#8A7E6B] text-xs font-medium">No items found in this section matching your filter.</p>
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
