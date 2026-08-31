import React, { useState, useEffect, useMemo, useRef, useId } from 'react';
import { Search, Wallet, X, ArrowLeft, Mic, ClipboardList } from 'lucide-react';
import SearchSuggestions from './SearchSuggestions';
import VoiceSearchOverlay from './VoiceSearchOverlay';
import DeliveryLocationBar from './DeliveryLocationBar';
import { buildSuggestions } from '../services/search';
import { createSpeechRecognition, mapSpeechError, resolveVoiceQuery } from '../services/voiceSearch';
import { useLanguage } from '../i18n/LanguageContext';

export default function Header({
  searchVal,
  setSearchVal,
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
  onAddressChange,
  onOpenNotepad,
}) {
  const { t, language } = useLanguage();
  const [isScrolled, setIsScrolled] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

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

  // Zepto-style: entering search mode focuses the box and raises the keyboard.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [searchOpen]);

  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('idle');
  const [voiceLive, setVoiceLive] = useState('');
  const recognitionRef = useRef(null);
  const applyVoiceRef = useRef(null);

  const stopVoiceSession = () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try {
      recognition?.abort();
    } catch {
      // abort() throws if the session never started
    }
  };

  const startVoiceSession = () => {
    const recognition = createSpeechRecognition(language);
    if (!recognition) {
      setVoiceStatus('unsupported');
      return;
    }

    recognition.onstart = () => setVoiceStatus('listening');
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setVoiceStatus((current) => (current === 'listening' ? 'nospeech' : current));
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      const mapped = mapSpeechError(event.error, { online: navigator.onLine });
      if (!mapped) return;
      setVoiceStatus(mapped);
    };
    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (!last) return;
      const alternatives = [];
      for (let i = 0; i < last.length; i += 1) {
        if (last[i]?.transcript) alternatives.push(last[i].transcript);
      }
      const live = alternatives[0]?.trim();
      if (live) setVoiceLive(live);
      if (last.isFinal) {
        setVoiceStatus('heard');
        applyVoiceRef.current?.(alternatives);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setVoiceStatus('failed');
    }
  };

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

  /**
   * Turn a finished utterance into the same action a typed suggestion would
   * have taken: one product opens that product, a section opens the section,
   * anything else searches. Filling the box and stopping used to be the whole
   * of voice search, so "lettuce" sat in the field and nothing happened.
   */
  applyVoiceRef.current = (transcripts) => {
    const { query, suggestion } = resolveVoiceQuery({
      transcripts,
      products,
      categories,
    });
    if (!query) {
      setVoiceStatus('nospeech');
      return;
    }
    stopVoiceSession();
    setVoiceOpen(false);
    setVoiceStatus('idle');
    setVoiceLive('');
    setSearchVal(query);
    setActiveIndex(-1);
    if (suggestion) {
      pick(suggestion);
      return;
    }
    closePanel();
    inputRef.current?.blur();
    onSubmitSearch?.(query);
  };

  const openVoiceSearch = () => {
    inputRef.current?.blur();
    stopVoiceSession();
    setVoiceLive('');
    setVoiceStatus('listening');
    setVoiceOpen(true);
    startVoiceSession();
  };

  const closeVoiceSearch = () => {
    stopVoiceSession();
    setVoiceOpen(false);
    setVoiceStatus('idle');
    setVoiceLive('');
  };

  const handleChange = (event) => {
    setSearchVal(event.target.value);
    setActiveIndex(-1);
    setIsOpen(event.target.value.trim().length > 0);
  };

  const handleBackFromSearch = () => {
    closeVoiceSearch();
    closePanel();
    setSearchVal('');
    onCloseSearch?.();
    inputRef.current?.blur();
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      if (isOpen) closePanel();
      else if (searchOpen) handleBackFromSearch();
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

  const searchField = (
    <div ref={searchRef} className={searchOpen ? 'flex-1 min-w-0' : 'flex-1 min-w-0'}>
      <label htmlFor="header-search" className="sr-only">{t('header.searchLabel')}</label>
      <div className="relative">
        <input
          ref={inputRef}
          id="header-search"
          type="search"
          enterKeyHint="search"
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
            else onSearchFocus?.();
          }}
            placeholder={cyclingPlaceholder}
          className={
            searchOpen
              ? 'vd-search-input-expanded w-full rounded-xl py-2.5 pl-4 pr-[4.5rem] text-sm font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/25 transition-all'
              : 'w-full vd-glass-input rounded-full py-3.5 pl-11 pr-10 text-[16.5px] font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 transition-all'
          }
        />
        {!searchOpen && (
          <Search className="w-5 h-5 text-[#8A7E6B] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
        )}

        <div className={`absolute top-1/2 -translate-y-1/2 flex items-center gap-0.5 ${searchOpen ? 'right-2' : 'right-2.5'}`}>
          {searchVal && (
            <button
              type="button"
              onClick={() => {
                setSearchVal('');
                closePanel();
                if (!searchOpen) {
                  onCloseSearch?.();
                  inputRef.current?.blur();
                }
              }}
              aria-label={t('header.clearSearch')}
              className="p-1 rounded-full text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5 transition-colors cursor-pointer"
            >
              <X className="stroke-[3] w-3.5 h-3.5" />
            </button>
          )}
          {searchOpen && (
            <>
              <span className="h-4 w-px bg-[#D8D2C4]" aria-hidden="true" />
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={openVoiceSearch}
                aria-label={t('header.voiceSearch')}
                className="p-1.5 rounded-full text-[#1B4D3E] hover:bg-[#1B4D3E]/8 transition-colors cursor-pointer"
              >
                <Mic className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  /*
    Two layouts: compact (location bar + wallet, sticky, with the search bar
    directly below it) and expanded search mode (back + full-width bar + mic,
    sticky, replacing both), matching the quick-commerce pattern where tapping
    search dedicates the whole header row to finding things.

    The location bar sits in the sticky row and the search bar does not,
    deliberately: where a shopper is being delivered to is relevant on every
    screen of the home tab, while the search box only needs to be reachable,
    not permanently in view — Zepto/Blinkit put the same two bars in the same
    order for the same reason.
  */
  return (
    <>
    {searchOpen ? (
      <header
        className={`vd-glass-header p-3 px-4 pt-safe-3 shrink-0 border-b flex items-center gap-2 sticky top-0 z-50 transition-all duration-300 ${
          isScrolled ? 'header-scrolled border-[#D5CDBC]' : 'border-[#DCD5C6] shadow-xs'
        }`}
      >
        <button
          type="button"
          onClick={handleBackFromSearch}
          aria-label={t('header.backFromSearch')}
          className="shrink-0 p-1.5 -ml-1 rounded-full text-[#2D2A26] hover:bg-black/5 active:scale-95 transition-all cursor-pointer"
        >
          <ArrowLeft className="w-5 h-5 stroke-[2.5]" />
        </button>
        {searchField}

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
    ) : (
      /*
        One sticky element, not two stacked bars. It used to be a sticky
        address row with a plain search row scrolling away underneath it —
        but "hide the address once the shopper scrolls, keep search pinned"
        needs the search row to end up occupying position zero, and only one
        element can be sticky at position zero at a time. So the address row
        collapses INSIDE the thing that stays sticky, rather than being a
        sibling this component could unmount: the search row was never sticky
        on its own, it just inherits the position once its neighbour's height
        goes to zero above it.
      */
      <header
        className={`vd-glass-header pt-safe-3 shrink-0 sticky top-0 z-20 transition-all duration-300 ${
          isScrolled ? 'header-scrolled' : ''
        } ${roleGradient ? `bg-gradient-to-b ${roleGradient}` : ''}`}
      >
        {/*
          Where a shopper is being delivered to matters most on the first
          screenful and far less three rows into the catalogue — so scrolling
          reclaims this row's height for products instead of holding the
          address in view for good, which the old always-visible bar assumed.

          Collapsed with `max-height` rather than `hidden`/`h-0`: the row's
          rendered height is not a fixed number (address text can wrap to a
          second line), and max-height is what lets that collapse animate as
          a slide instead of snapping instantly regardless of how tall the
          content actually was.
        */}
        <div
          className={`overflow-hidden transition-[max-height,opacity] duration-300 ease-out ${
            isScrolled ? 'max-h-0 opacity-0' : 'max-h-16 opacity-100'
          }`}
        >
          <div className="p-3 px-4 flex items-center justify-between gap-2">
            <div className="flex-1 min-w-0">
              <DeliveryLocationBar onAddressChange={onAddressChange} />
            </div>

            <div className="flex items-center space-x-1.5 shrink-0">
              <button
                onClick={onOpenWallet}
                className="skeuo-btn-emerald flex items-center justify-center p-2 rounded-full transition-all active:scale-95 cursor-pointer"
                title={t('header.openWallet')}
                aria-label={t('header.openWallet')}
              >
                <Wallet className="w-4 h-4 text-emerald-200" />
              </button>
            </div>
          </div>
        </div>

        {/* The search bar — always rendered, so it is what is left pinned
            once the row above it collapses.

            Notepad and mic sit beside it as their own buttons rather than
            inside it, matching the quick-commerce register this row is
            already built on — the input stays a single job (typing), and
            each icon is its own tap target instead of two functions
            competing for the same corner of one input. */}
        <div className="relative px-4 pb-3 pt-2">
          <div className="flex items-center gap-2">
            {searchField}

            <button
              type="button"
              onClick={onOpenNotepad}
              aria-label={t('header.myList')}
              title={t('header.myList')}
              className="shrink-0 flex items-center justify-center w-[54px] h-[54px] rounded-2xl vd-glass-input text-[#1B4D3E] hover:opacity-80 active:scale-95 transition-all cursor-pointer"
            >
              <ClipboardList className="w-5 h-5" />
            </button>

            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={openVoiceSearch}
              aria-label={t('header.voiceSearch')}
              title={t('header.voiceSearch')}
              className="shrink-0 flex items-center justify-center w-[54px] h-[54px] rounded-2xl vd-glass-input text-[#1B4D3E] hover:opacity-80 active:scale-95 transition-all cursor-pointer"
            >
              <Mic className="w-5 h-5" />
            </button>
          </div>

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
        </div>
      </header>
    )}
    <VoiceSearchOverlay
      open={voiceOpen}
      status={voiceStatus}
      liveText={voiceLive}
      onClose={closeVoiceSearch}
      onMicTap={openVoiceSearch}
    />
    </>
  );
}
