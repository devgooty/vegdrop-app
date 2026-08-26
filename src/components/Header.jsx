import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useId } from 'react';
import { Search, Wallet, X } from 'lucide-react';
import SearchSuggestions from './SearchSuggestions';
import VegDropMark from './VegDropMark';
import { buildSuggestions } from '../services/search';
import { claimBrandFlight, ARRIVAL_MS } from '../lib/brandFlight';
import { useLanguage } from '../i18n/LanguageContext';

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
  onSearchFocus,
  searchOpen = false,
  onCloseSearch,
}) {
  const { t, language } = useLanguage();
  const [isScrolled, setIsScrolled] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  /* ── Catching the mark from the launch screen ────────────────────────────
     The splash ends on the droplet standing in the middle of the screen, and
     this badge holds the same droplet — so it arrives from there rather than
     being redrawn here. Nothing tells this component where the user came from:
     a position is waiting or it is not, and if it is not the badge simply
     appears, which is what happens on every later render of this header.

     Two elements because they are two different measurements. `badgeRef` is
     what moves, and `glyphRef` is what the size is taken from — what the splash
     published is a bare droplet, and the badge is the squircle around one. */
  const badgeRef = useRef(null);
  const glyphRef = useRef(null);
  /** Undressed and in flight — the badge is oversized and out over the page. */
  const [isArriving, setIsArriving] = useState(false);
  /** Putting its squircle on, which happens on the flight's clock, not the page's. */
  const [isDressing, setIsDressing] = useState(false);

  useLayoutEffect(() => {
    const flight = claimBrandFlight('mark', badgeRef.current, {
      measure: glyphRef.current,
      // Longer than the default: this mark travels about half again as far as
      // the login screen's wordmark does, and shrinks to a third of its size
      // rather than growing by half.
      duration: 680,
      // Not a CSS delay, because the flight can hold at its origin for a moment
      // before it moves (see `playWhenSmooth`) and the length of that wait is
      // not known here. On a timer the badge would finish forming while the
      // droplet was still sitting where the splash left it.
      onStart: () => setIsDressing(true),
    });
    if (!flight) return undefined;

    setIsArriving(true);

    /*
      No cleanup, deliberately, and it is StrictMode that decides this.

      A claim is single use. In development every effect is mounted, cleaned up
      and mounted again — and the second run has nothing left to claim, so it
      cannot re-arm anything the first run's cleanup cancelled. Clearing this
      timeout there left both classes on for good, which holds the shell at
      opacity 0: a header whose badge is a bare droplet with no squircle, for
      the rest of the session.

      What is left behind is two setState calls on a component that has almost
      certainly not gone anywhere — the header outlives a second and a half of
      launch animation — and which are a no-op in React 18 if it has.
    */
    setTimeout(() => {
      setIsArriving(false);
      setIsDressing(false);
    }, ARRIVAL_MS);

    return undefined;
  }, []);

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
  // The panel is anchored to the header, not to the input, so it sits outside
  // searchRef's subtree. It needs its own ref or the outside-click detector
  // below treats a tap on a suggestion as a tap outside, closes the panel on
  // pointerdown, and the click never reaches the row that was tapped.
  const panelRef = useRef(null);

  const reactId = useId();
  const listboxId = `search-listbox-${reactId}`;
  const optionIdPrefix = `search-option-${reactId}-`;

  const query = searchVal.trim();

  /**
   * The placeholder names real produce, and rotates.
   *
   * A fixed "Search harvest…" tells a shopper the box exists and nothing else.
   * These are drawn from `products` — the chosen market's own sheet — so every
   * example is something that market actually sells, at a name it actually
   * uses, and it needs no translating: the catalogue already carries `nameHi`
   * and `nameTe`.
   *
   * Falls back to the old fixed string when the catalogue has not arrived yet,
   * so the box is never briefly blank on a cold start.
   */
  const placeholderItems = useMemo(() => {
    const names = products
      .filter((p) => p?.isActive !== false && Number(p?.stock ?? 0) > 0)
      .map((p) => (language === 'hi' && p.nameHi) || (language === 'te' && p.nameTe) || p.name)
      .filter(Boolean);
    // Deduplicated because one produce line can appear from several stalls.
    return [...new Set(names)].slice(0, 8);
  }, [products, language]);

  useEffect(() => {
    if (placeholderItems.length < 2) return;
    const timer = setInterval(
      () => setPlaceholderIndex((i) => (i + 1) % placeholderItems.length),
      2600
    );
    return () => clearInterval(timer);
  }, [placeholderItems.length]);

  const cyclingPlaceholder = placeholderItems.length
    ? t('header.searchFor', { item: placeholderItems[placeholderIndex % placeholderItems.length] })
    : t('header.searchPlaceholder');

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
      if (searchRef.current?.contains(event.target)) return;
      if (panelRef.current?.contains(event.target)) return;
      setIsOpen(false);
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

  /*
    One row: the lockup, the search box, the wallet.

    The box is the only thing here that can give ground — the name and the
    wallet are both `shrink-0`, so on a narrow phone the search box absorbs the
    whole squeeze and ends up around a third of the width. That is why its type
    and padding are as tight as they are, and why the suggestion panel is
    anchored to the header rather than to the input.
  */
  return (
    <header
      className={`bg-[#FAF7F2] p-3 px-4 pt-safe-3 flex items-center justify-between gap-2 sticky top-0 z-20 border-b transition-all duration-300 ${
        isScrolled
          ? 'header-scrolled border-[#D5CDBC]'
          : 'border-[#DCD5C6] shadow-xs'
      } ${roleGradient ? `bg-gradient-to-b ${roleGradient}` : ''}`}
    >
      {/* 3D SKEUOMORPHIC VINTAGE LOGO WITH BASKET */}
      <div className="flex items-center gap-2 cursor-pointer group shrink-0">
        <div
          ref={badgeRef}
          role="img"
          aria-label="VegDrop"
          className={
            'vd-home-mark group-hover:scale-105 transition-transform' +
            (isArriving ? ' is-arriving' : '') +
            (isDressing ? ' is-dressing' : '')
          }
        >
          {/* The squircle and its cream face are drawn BEHIND the droplet
              rather than as boxes around it, so the badge can fade itself in
              while the mark it frames stays fully drawn — which is what lets
              the droplet arrive bare from the launch screen and dress itself on
              the way down. See `.vd-home-mark` in src/index.css. */}
          <span className="vd-home-mark-shell" aria-hidden="true" />
          <span className="vd-home-mark-glyph" ref={glyphRef}>
            {/* Vector, and the same component the splash draws, which is what
                makes the handoff a move rather than a redraw. It replaced a
                512px `logo.png` painted at 26px — soft at this size, and a
                41 KB request on the first screen after launch. */}
            <VegDropMark className="w-full h-full" />
          </span>

          {/* Live indicator */}
          {user && user.role !== 'customer' && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-400 rounded-full border-2 border-[#FAF7F2] animate-pulse-glow" />
          )}
        </div>

        {/* The same logotype the launch and login screens draw — same face,
            weight and tracking, same two colours — because three slightly
            different wordmarks read as three different products.

            `aria-hidden`, because the badge beside it is already labelled
            "VegDrop"; without this a screen reader announces the name twice.

            Never translated: it is a name, not a string. */}
        <span className="vd-home-wordmark" aria-hidden="true">
          <span className="vd-home-wordmark-veg">Veg</span>
          <span className="vd-home-wordmark-drop">Drop</span>
        </span>
      </div>

      {/* Inset Cutout Search Input, between the name and the wallet */}
      <div ref={searchRef} className="flex-1 min-w-0">
        <label htmlFor="header-search" className="sr-only">{t('header.searchLabel')}</label>
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
            onFocus={() => {
              if (query) setIsOpen(true);
              // Empty box: there is nothing to suggest, so hand the moment to
              // the discovery screen instead of leaving a keyboard over the
              // home page.
              else onSearchFocus?.();
            }}
            placeholder={cyclingPlaceholder}
            className="w-full skeuo-inset-input rounded-full py-1.5 pl-7 pr-7 text-xs font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 transition-all"
          />
          <Search className="w-3.5 h-3.5 text-[#8A7E6B] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />

          {/*
            Also shown when the box is empty but the discovery screen is open,
            because otherwise tapping the search field is a one-way door: there
            is no query to clear, so the only affordance that could dismiss it
            was hidden exactly when it was needed.
          */}
          {(searchVal || searchOpen) && (
            <button
              type="button"
              onClick={() => {
                setSearchVal('');
                closePanel();
                onCloseSearch?.();
                inputRef.current?.blur();
              }}
              aria-label={t('header.clearSearch')}
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
          title={t('header.openWallet')}
        >
          <Wallet className="w-3.5 h-3.5 text-emerald-200" />
          <span className="animate-count-up">₹{walletBalance.toFixed(0)}</span>
        </button>
      </div>

      {/* Anchored to the header rather than to the input: the box sits between
          the name and the wallet and is far too narrow to read a suggestion in. */}
      {isOpen && (
        <SearchSuggestions
          panelRef={panelRef}
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
