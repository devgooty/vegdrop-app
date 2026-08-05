import React, { useState, useEffect, useMemo, useRef, useId } from 'react';
import { Search, Wallet, X } from 'lucide-react';
import SearchSuggestions from './SearchSuggestions';
import { buildSuggestions } from '../services/search';

export default function Header({
  searchVal,
  setSearchVal,
  walletBalance,
  cartCount,
  onOpenWallet,
  onOpenAccount,
  user,
  onOpenAuthModal,
  products = [],
  categories = [],
  onSubmitSearch,
  onOpenCategory,
  onSelectProduct,
}) {
  const [isScrolled, setIsScrolled] = useState(false);

  // Role-based header accent
  const roleGradient = {
    developer: 'from-slate-900/5 to-transparent',
    delivery: 'from-purple-900/5 to-transparent',
    shopkeeper: 'from-emerald-900/5 to-transparent',
    market_owner: 'from-amber-900/5 to-transparent',
  }[user?.role] || '';

  // Scroll-aware sticky header shadow
  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 8);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  /* ── Search suggestions ─────────────────────────────────────────────────
     `isOpen` is not derived from whether there is text in the box: picking a
     suggestion leaves its label in the input, and a derived flag would reopen
     the panel over the results the pick just navigated to. */
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef(null);
  const inputRef = useRef(null);

  const reactId = useId();
  const listboxId = `search-listbox-${reactId}`;
  const optionIdPrefix = `search-option-${reactId}-`;

  const query = searchVal.trim();

  const options = useMemo(() => {
    if (!query) return [];

    const suggestions = buildSuggestions({ products, categories, query }).map((suggestion) => ({
      ...suggestion,
      match: query,
    }));

    // The raw query always stays reachable as the last row, so a spelling the
    // catalog does not suggest can still be searched — and the panel is never
    // empty while there is something typed, which would otherwise read as
    // "nothing here" before the results screen has had a chance to say so.
    return [...suggestions, { id: 'query', kind: 'query', label: query }];
  }, [products, categories, query]);

  // A shrinking list must not leave the highlight pointing past its end.
  useEffect(() => {
    setActiveIndex((current) => (current >= options.length ? options.length - 1 : current));
  }, [options.length]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event) => {
      if (!searchRef.current?.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  const closePanel = () => {
    setIsOpen(false);
    setActiveIndex(-1);
  };

  const pick = (option) => {
    closePanel();
    inputRef.current?.blur();

    if (option.kind === 'category') {
      setSearchVal('');
      onOpenCategory?.(option.category);
      return;
    }

    // A suggestion that names exactly one item goes straight to that item's
    // page, because that is the thing the shopper pointed at and it is the only
    // screen they can actually buy from. Routing it through the results grid
    // put a single card between the tap and the product for no reason.
    if (option.kind === 'term' && option.products?.length === 1) {
      setSearchVal('');
      onSelectProduct?.(option.products[0]);
      return;
    }

    // A term matching several items, and the raw query, both open the results
    // screen — there is a genuine choice to make. A term puts its own label in
    // the box rather than what was typed, so the screen and the search box
    // agree on what is being shown.
    setSearchVal(option.label);
    onSubmitSearch?.(option.label);
  };

  const handleChange = (event) => {
    setSearchVal(event.target.value);
    setActiveIndex(-1);
    setIsOpen(event.target.value.trim().length > 0);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      if (isOpen) closePanel();
      else setSearchVal('');
      return;
    }

    if (event.key === 'Tab') {
      closePanel();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return;
      event.preventDefault();

      if (!isOpen) {
        setIsOpen(true);
        setActiveIndex(0);
        return;
      }

      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => {
        const next = current + step;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (!query) return;

      // No row highlighted means Enter searches exactly what was typed.
      pick(options[activeIndex] ?? { kind: 'query', label: query });
    }
  };

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
              alt="VegDrop Artisanal Basket"
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
      <div ref={searchRef} className="flex-1 min-w-0">
        <label htmlFor="header-search" className="sr-only">Search the shop</label>
        <div className="relative">
          <input
            ref={inputRef}
            id="header-search"
            type="text"
            role="combobox"
            aria-expanded={isOpen && options.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              isOpen && activeIndex >= 0 ? `${optionIdPrefix}${activeIndex}` : undefined
            }
            autoComplete="off"
            value={searchVal}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (query) setIsOpen(true); }}
            placeholder="Search harvest..."
            className="w-full skeuo-inset-input rounded-full py-1.5 pl-7 pr-7 text-xs font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 transition-all"
          />
          <Search className="w-3.5 h-3.5 text-[#8A7E6B] absolute left-2 top-2.5 pointer-events-none" />

          {searchVal && (
            <button
              type="button"
              onClick={() => {
                setSearchVal('');
                closePanel();
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5 transition-colors cursor-pointer"
            >
              <X className="w-3 h-3 stroke-[3]" />
            </button>
          )}
        </div>
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

      {/* Anchored to the header rather than to the input: the box sits between
          the logo and the wallet and is far too narrow to read a suggestion in. */}
      {isOpen && (
        <SearchSuggestions
          options={options}
          activeIndex={activeIndex}
          listboxId={listboxId}
          optionIdPrefix={optionIdPrefix}
          onPick={pick}
          onHoverOption={setActiveIndex}
        />
      )}
    </header>
  );
}
