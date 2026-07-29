import React, { useState, useEffect } from 'react';
import { Search, Wallet, User, LogIn, Shield, Bell } from 'lucide-react';

export default function Header({
  searchVal,
  setSearchVal,
  walletBalance,
  cartCount,
  onOpenWallet,
  onOpenAccount,
  user,
  onOpenAuthModal,
}) {
  const firstName = user?.name ? user.name.split(' ')[0] : null;
  const [isScrolled, setIsScrolled] = useState(false);

  // Scroll-aware sticky header shadow
  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 8);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const roleLabel = {
    customer: 'Customer',
    shopkeeper: 'Shopkeeper',
    delivery: 'Delivery',
    developer: 'Dev Console',
    market_owner: 'Market Owner',
  }[user?.role || 'customer'];

  // Role-based header accent
  const roleGradient = {
    developer: 'from-slate-900/5 to-transparent',
    delivery: 'from-purple-900/5 to-transparent',
    shopkeeper: 'from-emerald-900/5 to-transparent',
    market_owner: 'from-amber-900/5 to-transparent',
  }[user?.role] || '';

  return (
    <header
      className={`bg-[#FAF7F2] p-3 px-4 flex items-center justify-between gap-2 sticky top-0 z-20 border-b transition-all duration-300 ${
        isScrolled
          ? 'header-scrolled border-[#D5CDBC]'
          : 'border-[#DCD5C6] shadow-xs'
      } ${roleGradient ? `bg-gradient-to-b ${roleGradient}` : ''}`}
    >
      {/* 3D SKEUOMORPHIC VINTAGE LOGO WITH BASKET */}
      <div className="flex items-center gap-2 cursor-pointer group shrink-0">
        <div className="relative w-9 h-9 rounded-2xl bg-gradient-to-b from-[#3B7A57] to-[#1C4D38] p-0.5 shadow-md group-hover:scale-105 transition-transform border border-[#143B2B]">
          <div className="w-full h-full bg-[#FFFDF9] rounded-[14px] p-0.5 overflow-hidden flex items-center justify-center shadow-inner">
            <img
              src="/logo.png"
              alt="VegBazzar Artisanal Basket"
              className="w-full h-full object-cover rounded-xl"
              onError={(e) => {
                e.target.style.display = 'none';
              }}
            />
          </div>
          {/* Live indicator */}
          {user && user.role !== 'customer' && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-400 rounded-full border-2 border-[#FAF7F2] animate-pulse-glow" />
          )}
        </div>

      </div>

      {/* Inset Cutout Search Input */}
      <div className="flex-1 min-w-0 relative">
        <input
          type="text"
          value={searchVal}
          onChange={(e) => setSearchVal(e.target.value)}
          placeholder="Search harvest..."
          className="w-full skeuo-inset-input rounded-full py-1.5 pl-7 pr-2 text-xs font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 transition-all"
        />
        <Search className="w-3.5 h-3.5 text-[#8A7E6B] absolute left-2 top-2.5" />
      </div>

      {/* 3D Tactile Wallet & User Profile Buttons */}
      <div className="flex items-center space-x-1.5 shrink-0">
        <button
          onClick={onOpenWallet}
          className="skeuo-btn-emerald flex items-center gap-1 font-bold px-2 py-1.5 rounded-full text-xs transition-all active:scale-95 cursor-pointer"
          title="Open VegWallet"
        >
          <Wallet className="w-3.5 h-3.5 text-emerald-200" />
          <span className="animate-count-up">₹{walletBalance.toFixed(0)}</span>
        </button>


      </div>
    </header>
  );
}
