import React, { useState, useEffect } from 'react';
import { ArrowRight, Trash2, Plus, Minus, ShoppingBasket, CheckCircle2, MapPin, AlertTriangle, Truck } from 'lucide-react';
import { savedCustomerAddress } from '../services/address';
import { cartItemCount } from '../services/cart';
import { useLanguage } from '../i18n/LanguageContext';
import { productName } from '../i18n/catalog';

/**
 * Delivery pricing, mirrored from server/routes/orders.js.
 *
 * The server recomputes the fee on every order and its answer is the one that is
 * charged; these constants exist only so the basket shows the same number. They
 * were previously ₹0 above ₹200 while the server charged ₹25 until ₹300, so any
 * basket between the two thresholds displayed FREE and then billed ₹25.
 */
const DELIVERY_FEE = 25;
const FREE_DELIVERY_THRESHOLD = 300;

/**
 * The basket's ground, named once because THREE separate surfaces have to be
 * this exact colour and nothing makes that obvious when they are three literals.
 *
 * The scrolling sheet, the shelf the floating nav pill rests on, and the fade
 * behind the Place Order button are one continuous plane as far as the eye is
 * concerned. They were three hardcoded hexes, and warming the sheet from
 * #FFFDF9 to this left the shelf behind on #FAF7F2 — three units per channel,
 * which is invisible in a diff and a clear seam straight across the screen just
 * above the nav pill. A constant is what makes that class of drift impossible
 * rather than merely unlikely.
 */
const SHEET_BG = '#F7F4ED';

export default function CartModal({ isOpen, onClose, cartItems, onUpdateQuantity, onCheckout, walletBalance = 0, onSelectProduct, blockedReason = null }) {
  const { t, language } = useLanguage();
  const [placed, setPlaced] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('COD'); // 'PhonePe' | 'Google Pay' | 'Paytm' | 'COD' | 'VegWallet'
  // Razorpay opens in a modal over this one; without this the button stays live
  // underneath it and a second tap starts a second payment.
  const [isPaying, setIsPaying] = useState(false);

  /**
   * Escape closes the basket.
   *
   * This overlay is `fixed inset-0`, so while it is open it covers the whole
   * shop and swallows every tap aimed at the catalog behind it. Without a key
   * out, a customer who opened it by accident on a keyboard had no way back
   * except finding the one small X.
   */
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !isPaying) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isPaying, onClose]);

  /**
   * The shop behind the basket must not scroll while the basket is open.
   *
   * Without this the catalog went on scrolling underneath: the basket sheet
   * stayed put while product rows slid past in the strip the floating nav sits
   * in, which read as two screens moving independently. It also loses the
   * shopper's place — they reopen the shop somewhere they never scrolled to.
   *
   * `position: fixed` rather than the plain `overflow: hidden` that Dialog in
   * MarketOwnerPanel uses, because this is the mobile path and iOS Safari
   * ignores `overflow` on the body. Pinning to a negative `top` is what keeps
   * the scroll position, which is then restored on the way out — setting only
   * `position` would snap the shop back to the top when the basket closes.
   */
  useEffect(() => {
    if (!isOpen) return undefined;
    const { body } = document;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;

      // Reading a layout property forces the browser to re-measure the page
      // before we scroll it. While the body was fixed the document had
      // collapsed to viewport height, so a scrollTo issued in the same tick is
      // clamped against that stale height and lands at the top — which put the
      // shopper back at the start of the catalog every time they closed the
      // basket, exactly the thing this effect exists to prevent.
      void body.offsetHeight;
      window.scrollTo(0, scrollY);
    };
  }, [isOpen]);

  // The Razorpay checkout script is NOT loaded here. This modal no longer opens
  // checkout itself — card and UPI route through the wallet top-up in
  // WalletModal, which loads the script on demand via services/wallet.js.

  if (!isOpen) return null;

  const total = cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const deliveryFee = total > 0 && total < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;
  const grandTotal = total + deliveryFee;
  const savedAddress = savedCustomerAddress();

  /**
   * How close the basket is to free delivery.
   *
   * Derived from the same two constants the fee itself is, so the meter can
   * never promise a threshold the fee is not actually using — which is the
   * failure this file already carries a warning about, where the displayed
   * threshold and the charged one had drifted apart.
   */
  const toFreeDelivery = Math.max(0, FREE_DELIVERY_THRESHOLD - total);
  const freeDeliveryPct = Math.min(100, (total / FREE_DELIVERY_THRESHOLD) * 100);

  /**
   * What an online method will actually charge.
   *
   * Any wallet balance is spent first, so the card is only asked for the
   * remainder — mirrored from handleCheckout, which does the real arithmetic.
   * Shown here so the amount is not a surprise when Razorpay opens.
   */
  const isOnlinePayment = paymentMethod !== 'COD' && paymentMethod !== 'VegWallet';
  const shortfall = Math.max(0, grandTotal - walletBalance);
  const cardAmount = shortfall > 0 ? Math.max(10, Math.ceil(shortfall)) : 0;
  const walletCovers = isOnlinePayment && shortfall === 0;

  const handlePlaceOrder = async () => {
    if (cartItems.length === 0 || isPaying || blockedReason) return;

    // onCheckout is async and server-authoritative: it returns false when the
    // server rejects the order (insufficient funds, insufficient stock).
    if (paymentMethod === 'COD' || paymentMethod === 'VegWallet') {
      const result = await onCheckout(grandTotal, paymentMethod);
      if (result === false) return;

      setPlaced(true);
      setTimeout(() => {
        setPlaced(false);
        onClose();
      }, 2500);
      return;
    }

    /**
     * UPI and card open Razorpay, and the method is passed through as chosen.
     *
     * It used to be rewritten to 'VegWallet' here, which meant picking UPI with
     * an empty wallet failed with "insufficient funds" and no way to pay from
     * the basket. handleCheckout now collects the shortfall through Razorpay
     * first — the payment is still verified server-side against a recorded
     * intent, which is the part that must never move into the browser.
     */
    setIsPaying(true);
    try {
      const result = await onCheckout(grandTotal, paymentMethod);
      if (result === false) return;

      setPlaced(true);
      setTimeout(() => {
        setPlaced(false);
        onClose();
      }, 2500);
    } finally {
      setIsPaying(false);
    }
  };

  return (
    <div className="fixed inset-0 max-w-md mx-auto z-[25] animate-fade-in flex flex-col">
      {/*
        Covers the whole shell, and every part of it is painted.

        This used to stop short of the floating nav so Home/Prices/Orders/
        Account stayed reachable, leaving the strip the pill sits in as bare
        viewport. That strip was not empty, it was a window: the catalog behind
        showed through it undimmed — product cards, prices and Add buttons
        scrolling past beneath the basket, and nothing at all wherever the pill
        was hidden. The nav does not need a hole to stay usable; it renders at
        z-30 above this z-25 overlay, so it takes taps regardless. What it
        needed was something opaque to sit on, which is the shelf below.

        `max-w-md mx-auto` matches the app shell's own width (App.jsx's root),
        which `position: fixed` does not inherit from an ancestor — without it
        this overlay covered the full browser viewport on anything wider than
        the shell, staining the margins outside the app itself.
      */}
      {/* A shade warmer than the cards it holds. The sheet used to be the same
          near-white as everything on it, so the item rows had to draw their own
          grey fill to be visible at all — which is what made the list read as a
          stack of disabled fields rather than as things you own. */}
      <div
        className="flex-1 min-h-0 flex flex-col shadow-2xl overflow-hidden relative"
        style={{ backgroundColor: SHEET_BG }}
      >
        {/*
          Header. A title and nothing else — no close control, and no rule under
          it.

          The basket is a BOTTOM-NAV DESTINATION, not a dialog: Home, Prices,
          Orders and Account stay live above this overlay (they render at z-30
          over its z-25), so the way out is the same way you came in. A back
          arrow or a ✗ here was a second, redundant exit competing with the tab
          bar for the same job. Escape still closes it for keyboards, and the
          empty state offers a way back to the shop for the one case where the
          tab bar is not the obvious answer.

          The divider is gone with it. The list below is made of separated
          cards on a warmer ground, so the header is already read as a header —
          a rule across the top only added a seam.
        */}
        <div className="px-4 pt-5 pb-3 shrink-0">
          <h3 className="font-black text-[#123B2F] text-[1.35rem] tracking-tight">
            {/* Counts items, not lines — the bottom-nav badge always has, and the
                two disagreeing ("9" on the tab, "(6)" here) reads as a bug. */}
            {t('cart.title', { count: cartItemCount(cartItems) })}
          </h3>

          {/*
            How close this basket is to free delivery.

            Worth its place at the top rather than buried in the bill: it is the
            one number here a shopper can still act on, and it is only useful
            BEFORE they have finished deciding what to buy. Below the totals it
            would be an explanation; here it is an offer.
          */}
          {cartItems.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Truck
                  className={`w-3.5 h-3.5 shrink-0 ${toFreeDelivery > 0 ? 'text-[#B4874A]' : 'text-emerald-600'}`}
                  strokeWidth={2.5}
                />
                <p className={`text-[12px] font-bold ${toFreeDelivery > 0 ? 'text-[#8A6534]' : 'text-emerald-700'}`}>
                  {toFreeDelivery > 0
                    ? t('cart.freeDeliveryProgress', { amount: toFreeDelivery })
                    : t('cart.freeDeliveryEarned')}
                </p>
              </div>
              <div className="h-1.5 rounded-full bg-[#E8E1D4] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ease-out ${
                    toFreeDelivery > 0
                      ? 'bg-gradient-to-r from-[#E0B15F] to-[#C08A3E]'
                      : 'bg-gradient-to-r from-emerald-400 to-emerald-600'
                  }`}
                  style={{ width: `${freeDeliveryPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {placed ? (
          <div className="flex-1 p-8 flex flex-col items-center justify-center text-center">
            <CheckCircle2 className="w-16 h-16 text-emerald-500 mb-3 animate-bounce" />
            <h4 className="font-extrabold text-xl text-gray-900 mb-1">{t('cart.confirmed')}</h4>
            <p className="text-sm text-gray-500 max-w-xs mb-2">{t('cart.confirmedSub')}</p>
            <span className="inline-block bg-emerald-100 text-emerald-800 font-extrabold text-xs px-3 py-1 rounded-full border border-emerald-200">
              {t('cart.paidVia', { method: paymentMethod })}
            </span>
          </div>
        ) : (
          <>
            {/*
              Everything below the header scrolls as one region — items,
              totals, address and payment picker together. Splitting the item
              list and the summary/payment footer into two independently
              sized flex children used to mean a full basket's footer (address
              card, blocked-reason banner, five payment tiles) ate nearly all
              the height, squeezing the item list into a sliver a couple rows
              tall. A swipe landing on the footer did nothing — it has no
              scroll of its own — so most of the sheet read as unresponsive.
              Only the Place Order button stays pinned outside this region, so
              it is never scrolled out of reach.
            */}
            <div className="flex-1 overflow-y-auto min-h-0">
            <div className="px-4 pb-4 space-y-2.5">
              {cartItems.length === 0 ? (
                /*
                  Nothing to act on here, deliberately. There was a "Browse the
                  shop" button; the tab bar directly below already says Home,
                  and a second control pointing at the same place is the same
                  redundancy the back arrow was removed for.
                */
                <div className="text-center py-14 px-6">
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-white border border-[#EFE9DD] flex items-center justify-center shadow-[0_4px_18px_rgba(24,54,42,0.06)]">
                    <ShoppingBasket className="w-9 h-9 text-[#C9BFA9]" strokeWidth={1.75} />
                  </div>
                  <p className="text-[15px] font-black text-[#123B2F]">{t('cart.empty')}</p>
                  <p className="text-[12.5px] font-semibold text-slate-400 mt-1 leading-snug max-w-[15rem] mx-auto">
                    {t('cart.emptySub')}
                  </p>
                </div>
              ) : (
                cartItems.map((item) => (
                  /*
                    One white card per line on the warm ground, rather than a
                    grey strip on near-white.

                    The LINE TOTAL is the addition that matters. The row used to
                    print the unit price alone, so a basket holding four of
                    something showed "₹35" beside a "4" and left the shopper to
                    multiply — while the only other number on the screen was a
                    subtotal that already had. Price-each is kept underneath,
                    quietly, because it is what changes when you tap the stepper.
                  */
                  <div
                    key={item.id}
                    className="flex gap-3 bg-white p-3 rounded-2xl border border-[#EFE9DD] shadow-[0_2px_10px_rgba(24,54,42,0.05)] cursor-pointer hover:border-[#DCD3C0] transition-colors"
                    onClick={() => onSelectProduct && onSelectProduct(item)}
                  >
                    <img
                      src={item.image}
                      alt={item.name}
                      className="w-16 h-16 object-cover rounded-xl bg-[#F6F3EC] shrink-0"
                    />

                    <div className="flex-1 min-w-0 flex flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-black text-[13px] text-[#123B2F] leading-snug line-clamp-2">
                          {productName(item, language)}
                        </h4>
                        <button
                          onClick={(e) => { e.stopPropagation(); onUpdateQuantity(item.id, -item.quantity); }}
                          className="shrink-0 -mt-0.5 -mr-0.5 p-1.5 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                          title={t('cart.removeItem')}
                          aria-label={t('cart.removeItem')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <p className="text-[11px] font-bold text-slate-400 mt-0.5">
                        {t('cart.each', { price: item.price })}
                      </p>

                      <div className="flex items-center justify-between gap-2 mt-auto pt-2">
                        <div className="flex items-center gap-1 bg-[#F4F1EA] rounded-full p-0.5 border border-[#E7E1D4]">
                          <button
                            onClick={(e) => { e.stopPropagation(); onUpdateQuantity(item.id, -1); }}
                            className="w-6 h-6 rounded-full bg-white text-slate-500 hover:text-[#1B4D3E] flex items-center justify-center shadow-xs transition-colors cursor-pointer active:scale-90"
                            aria-label="-"
                          >
                            <Minus className="w-3.5 h-3.5" strokeWidth={2.75} />
                          </button>
                          <span className="text-[12.5px] font-black text-[#123B2F] w-5 text-center tabular-nums">
                            {item.quantity}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); onUpdateQuantity(item.id, 1); }}
                            className="w-6 h-6 rounded-full bg-[#1B4D3E] text-white flex items-center justify-center shadow-xs hover:bg-[#123B2F] transition-colors cursor-pointer active:scale-90"
                            aria-label="+"
                          >
                            <Plus className="w-3.5 h-3.5" strokeWidth={2.75} />
                          </button>
                        </div>

                        <span className="font-black text-[15px] text-[#1B4D3E] tabular-nums">
                          ₹{item.price * item.quantity}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Summary & Payment Selection — scrolls with the item list above */}
            {cartItems.length > 0 && (
              <div className="px-4 pb-4 space-y-2.5">
                {/*
                  The bill, as its own card rather than a grey strip welded to
                  the bottom of the list. It answers a different question from
                  the rows above it, and the separation is what lets the grand
                  total be the largest number on the screen without shouting.
                */}
                <div className="bg-white rounded-2xl border border-[#EFE9DD] shadow-[0_2px_10px_rgba(24,54,42,0.05)] p-4">
                  <p className="text-[10.5px] font-black uppercase tracking-wider text-slate-400 mb-2.5">
                    {t('cart.billDetails')}
                  </p>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[13px] text-slate-500 font-semibold">
                      <span>{t('cart.subtotal')}</span>
                      <span className="text-slate-700 font-bold tabular-nums">₹{total}</span>
                    </div>
                    <div className="flex justify-between text-[13px] text-slate-500 font-semibold">
                      <span>{t('cart.deliveryFee')}</span>
                      {deliveryFee === 0 ? (
                        /* The struck-through fee is the point: "FREE" alone
                           states a fact, "₹25 FREE" shows what was saved. */
                        <span className="flex items-center gap-1.5">
                          <span className="text-slate-300 line-through font-bold tabular-nums">₹{DELIVERY_FEE}</span>
                          <span className="text-emerald-600 font-black">{t('cart.free')}</span>
                        </span>
                      ) : (
                        <span className="text-slate-700 font-bold tabular-nums">₹{deliveryFee}</span>
                      )}
                    </div>
                  </div>

                  {/* Dashed, like a torn receipt — and a different mark from the
                      solid hairlines that separate cards, so it reads as part of
                      the bill rather than as another divider. */}
                  <div className="my-3 border-t border-dashed border-[#E2DACA]" />

                  <div className="flex justify-between items-baseline">
                    <span className="text-[13.5px] font-black text-[#123B2F]">{t('cart.grandTotal')}</span>
                    <span className="text-[1.35rem] font-black text-[#1B4D3E] tracking-tight tabular-nums">₹{grandTotal}</span>
                  </div>
                </div>

                {/* Delivery address. Amber, not green, when there isn't one —
                    this used to print a hardcoded Bengaluru address over an
                    empty setting and read as confirmed. */}
                <div
                  className={`flex items-start gap-2.5 border rounded-2xl p-3 ${
                    savedAddress ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
                  }`}
                >
                  <MapPin className={`w-4 h-4 mt-0.5 shrink-0 ${savedAddress ? 'text-emerald-600' : 'text-amber-600'}`} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-[11.5px] font-bold uppercase tracking-wider ${savedAddress ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {savedAddress ? t('cart.deliveringTo') : t('cart.noAddress')}
                    </p>
                    <p className="text-[12.5px] text-gray-700 font-medium leading-tight truncate">
                      {savedAddress || t('cart.noAddressHint')}
                    </p>
                  </div>
                </div>

                {/*
                  Why this order cannot be placed.

                  An order with no market behind it used to go through: the
                  server accepted it as a legacy marketless order, and no stall
                  could ever see it, so it sat at Pending for good. Saying so
                  here beats a tap that appears to work and quietly strands the
                  basket.
                */}
                {blockedReason && (
                  <div className="flex items-start gap-2.5 bg-rose-50 border border-rose-200 rounded-2xl p-3">
                    <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
                    <p className="text-[12.5px] text-rose-800 font-medium leading-snug">{blockedReason}</p>
                  </div>
                )}

                {/* Select Payment Method Options */}
                <div className="bg-white rounded-2xl border border-[#EFE9DD] shadow-[0_2px_10px_rgba(24,54,42,0.05)] p-4 space-y-2.5">
                  <p className="text-[10.5px] font-black uppercase tracking-wider text-slate-400">{t('cart.selectPayment')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {/* PhonePe */}
                    <button
                      onClick={() => setPaymentMethod('PhonePe')}
                      className={`p-2.5 rounded-2xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left cursor-pointer ${
                        paymentMethod === 'PhonePe'
                          ? 'border-[#5F259F] bg-purple-50 text-[#5F259F] font-black'
                          : 'border-[#EFE9DD] bg-white text-gray-700 hover:border-purple-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-[#5F259F] text-white flex items-center justify-center font-black text-[10.5px] shrink-0">
                        पे
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-extrabold leading-tight">PhonePe</p>
                        <p className="text-[9.5px] text-gray-400 font-semibold">UPI</p>
                      </div>
                    </button>

                    {/* Google Pay */}
                    <button
                      onClick={() => setPaymentMethod('Google Pay')}
                      className={`p-2.5 rounded-2xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left cursor-pointer ${
                        paymentMethod === 'Google Pay'
                          ? 'border-blue-600 bg-blue-50 text-blue-700 font-black'
                          : 'border-[#EFE9DD] bg-white text-gray-700 hover:border-blue-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-white border border-gray-200 flex items-center justify-center font-black text-[9.5px] shrink-0">
                        <span className="text-[#4285F4]">G</span><span className="text-[#EA4335]">P</span><span className="text-[#FBBC05]">a</span><span className="text-[#34A853]">y</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-extrabold leading-tight">Google Pay</p>
                        <p className="text-[9.5px] text-gray-400 font-semibold">GPay</p>
                      </div>
                    </button>

                    {/* Paytm */}
                    <button
                      onClick={() => setPaymentMethod('Paytm')}
                      className={`p-2.5 rounded-2xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left cursor-pointer ${
                        paymentMethod === 'Paytm'
                          ? 'border-sky-600 bg-sky-50 text-sky-700 font-black'
                          : 'border-[#EFE9DD] bg-white text-gray-700 hover:border-sky-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-[#002E6E] text-[#00BAF2] flex items-center justify-center font-black text-[9.5px] shrink-0">
                        Paytm
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-extrabold leading-tight">Paytm</p>
                        <p className="text-[9.5px] text-gray-400 font-semibold">UPI</p>
                      </div>
                    </button>

                    {/* VegWallet */}
                    <button
                      onClick={() => setPaymentMethod('VegWallet')}
                      className={`p-2.5 rounded-2xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left cursor-pointer ${
                        paymentMethod === 'VegWallet'
                          ? 'border-orange-600 bg-orange-50 text-orange-800 font-black'
                          : 'border-[#EFE9DD] bg-white text-gray-700 hover:border-orange-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-orange-100 text-orange-800 flex items-center justify-center font-black text-xs shrink-0">
                        💳
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-extrabold leading-tight">VegWallet</p>
                        {/* Rounded to paise: the balance is a float derived
                            from the server's integer paise, so a refund can
                            leave it reading "Bal: ₹212.30000000000001". */}
                        <p className="text-[9.5px] text-orange-600 font-semibold">{t('cart.walletBalance', { amount: walletBalance.toFixed(2) })}</p>
                      </div>
                    </button>

                    {/* Cash on Delivery, spanning both columns — five tiles in
                        a two-column grid otherwise leave the last one stranded
                        beside a hole, which reads as a tile that failed to
                        load. It is also the default method, so the width is
                        not undeserved. */}
                    <button
                      onClick={() => setPaymentMethod('COD')}
                      className={`col-span-2 p-2.5 rounded-2xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left cursor-pointer ${
                        paymentMethod === 'COD'
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-800 font-black'
                          : 'border-[#EFE9DD] bg-white text-gray-700 hover:border-emerald-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-800 flex items-center justify-center font-black text-xs shrink-0">
                        💵
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-extrabold leading-tight">{t('cart.cod')}</p>
                        <p className="text-[9.5px] text-emerald-600 font-semibold">{t('cart.codSub')}</p>
                      </div>
                    </button>
                  </div>
                </div>

                {/* What the card is actually charged, when it differs from the total */}
                {isOnlinePayment && (
                  <div className="bg-white border border-[#EFE9DD] rounded-2xl p-3 text-[12.5px] space-y-1 shadow-[0_2px_10px_rgba(24,54,42,0.05)]">
                    {walletCovers ? (
                      <p className="text-gray-600 font-semibold">
                        Your VegWallet balance covers this. Nothing to pay by {paymentMethod}.
                      </p>
                    ) : (
                      <>
                        {walletBalance > 0 && (
                          <div className="flex justify-between text-gray-600">
                            <span>From VegWallet</span>
                            <span className="font-bold">−₹{Math.min(walletBalance, grandTotal).toFixed(0)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-gray-900">
                          <span className="font-semibold">Pay by {paymentMethod}</span>
                          <span className="font-black">₹{cardAmount}</span>
                        </div>
                        {cardAmount > shortfall && (
                          <p className="text-[11.5px] text-gray-500 leading-tight pt-0.5">
                            ₹10 is the minimum online payment; the extra ₹{(cardAmount - shortfall).toFixed(0)} stays in your VegWallet.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            </div>

            {/* Place Order — pinned outside the scroll region so it's always reachable */}
            {cartItems.length > 0 && (
              /* Floats over the list rather than sitting in a grey tray with a
                 rule above it: the tray was a second horizontal band stacked on
                 the nav shelf below, and two of them read as the sheet having
                 run out of room. The gradient is the same one the ground uses,
                 fading up, so the last card slides under the button instead of
                 stopping dead at a line. */
              <div
                className="px-4 pt-3 pb-4 shrink-0"
                style={{ backgroundImage: `linear-gradient(to top, ${SHEET_BG} 0%, ${SHEET_BG} 55%, transparent 100%)` }}
              >
                <button
                  onClick={handlePlaceOrder}
                  disabled={cartItems.length === 0 || isPaying || Boolean(blockedReason)}
                  className="w-full bg-gradient-to-b from-[#226551] to-[#1B4D3E] hover:from-[#1B4D3E] hover:to-[#123B2F] disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none disabled:cursor-not-allowed text-white font-black py-3.5 rounded-2xl text-[13.5px] transition-all shadow-[0_8px_22px_rgba(27,77,62,0.3)] flex items-center justify-center gap-2 active:scale-[0.98] cursor-pointer"
                >
                  <span>
                    {blockedReason
                      ? t('cart.cannotPlace')
                      : isPaying
                        ? t('cart.waitingPayment')
                        : isOnlinePayment && !walletCovers
                          ? t('cart.payWith', { amount: cardAmount, method: paymentMethod })
                          : t('cart.placeOrder', { total: grandTotal, method: paymentMethod })}
                  </span>
                  {!blockedReason && !isPaying && <ArrowRight className="w-4 h-4 shrink-0" strokeWidth={2.75} />}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/*
        The shelf the floating nav pill rests on while the basket is open.

        Something opaque has to sit here: it is the gap around and behind a
        rounded, inset pill that otherwise made the catalog visible through it.

        It takes the BASKET's ground rather than the shop's. While the basket is
        open this strip is the bottom of the basket, so matching the sheet is
        what makes the two read as one surface — the pill floating on the
        basket, which is where it is. Matching the shop instead drew a seam
        across the screen at the join.
      */}
      <div
        aria-hidden="true"
        className="shrink-0 h-[calc(4.25rem+env(safe-area-inset-bottom,0px))]"
        style={{ backgroundColor: SHEET_BG }}
      />
    </div>
  );
}
