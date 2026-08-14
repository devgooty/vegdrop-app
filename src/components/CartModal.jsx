import React, { useState, useEffect } from 'react';
import { X, Trash2, Plus, Minus, ShoppingBasket, CheckCircle2, MapPin, AlertTriangle } from 'lucide-react';
import { savedCustomerAddress } from '../services/address';

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

export default function CartModal({ isOpen, onClose, cartItems, onUpdateQuantity, onCheckout, walletBalance = 0, onSelectProduct, blockedReason = null }) {
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

  // The Razorpay checkout script is NOT loaded here. This modal no longer opens
  // checkout itself — card and UPI route through the wallet top-up in
  // WalletModal, which loads the script on demand via services/wallet.js.

  if (!isOpen) return null;

  const total = cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const deliveryFee = total > 0 && total < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;
  const grandTotal = total + deliveryFee;
  const savedAddress = savedCustomerAddress();

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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center items-start z-[25] animate-fade-in">
      {/* Stops short of the bottom nav (z-30) so Home/Prices/Orders/Account stay
          reachable while the basket is open. */}
      <div className="bg-[#FFFDF9] w-full max-w-md h-[calc(100dvh-4.25rem)] flex flex-col justify-between shadow-2xl overflow-hidden relative">
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingBasket className="w-5 h-5 text-emerald-600" />
            <h3 className="font-bold text-gray-900 text-base">Your Basket ({cartItems.length})</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close basket"
            className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {placed ? (
          <div className="flex-1 p-8 flex flex-col items-center justify-center text-center">
            <CheckCircle2 className="w-16 h-16 text-emerald-500 mb-3 animate-bounce" />
            <h4 className="font-extrabold text-xl text-gray-900 mb-1">Order Confirmed!</h4>
            <p className="text-sm text-gray-500 max-w-xs mb-2">Your fresh produce will be delivered to your doorstep in 15-20 minutes.</p>
            <span className="inline-block bg-emerald-100 text-emerald-800 font-extrabold text-xs px-3 py-1 rounded-full border border-emerald-200">
              Paid via {paymentMethod}
            </span>
          </div>
        ) : (
          <>
            {/* Cart Items List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cartItems.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <ShoppingBasket className="w-12 h-12 mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-medium">Your basket is empty.</p>
                </div>
              ) : (
                cartItems.map((item) => (
                  <div 
                    key={item.id} 
                    className="flex items-center gap-3 bg-gray-50 p-2.5 rounded-xl border border-gray-100 cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => onSelectProduct && onSelectProduct(item)}
                  >
                    <img src={item.image} alt={item.name} className="w-12 h-12 object-cover rounded-lg bg-white" />
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-xs text-gray-900 truncate">{item.name}</h4>
                      <span className="text-xs font-bold text-emerald-700">₹{item.price}</span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <div className="flex items-center gap-2 bg-white px-2 py-1 rounded-lg border border-gray-200">
                        <button
                          onClick={(e) => { e.stopPropagation(); onUpdateQuantity(item.id, -1); }}
                          className="text-gray-500 hover:text-gray-700 p-0.5 cursor-pointer"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-xs font-bold text-gray-800 w-4 text-center">{item.quantity}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); onUpdateQuantity(item.id, 1); }}
                          className="text-gray-500 hover:text-emerald-600 p-0.5 cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      
                      <button 
                        onClick={(e) => { e.stopPropagation(); onUpdateQuantity(item.id, -item.quantity); }}
                        className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer border border-transparent hover:border-red-100 bg-white shadow-xs"
                        title="Remove entirely"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer Summary & Payment Selection */}
            {cartItems.length > 0 && (
              <div className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>Subtotal</span>
                    <span className="font-semibold">₹{total}</span>
                  </div>
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>Delivery Fee</span>
                    <span className="font-semibold">{deliveryFee === 0 ? <span className="text-emerald-600 font-bold">FREE</span> : `₹${deliveryFee}`}</span>
                  </div>
                  <div className="flex justify-between text-sm font-bold text-gray-900 pt-1 border-t border-gray-200">
                    <span>Grand Total</span>
                    <span className="text-emerald-700 font-black">₹{grandTotal}</span>
                  </div>
                </div>

                {/* Delivery address. Amber, not green, when there isn't one —
                    this used to print a hardcoded Bengaluru address over an
                    empty setting and read as confirmed. */}
                <div
                  className={`flex items-start gap-2 border rounded-xl p-2.5 ${
                    savedAddress ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
                  }`}
                >
                  <MapPin className={`w-4 h-4 mt-0.5 shrink-0 ${savedAddress ? 'text-emerald-600' : 'text-amber-600'}`} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-[10px] font-bold uppercase tracking-wider ${savedAddress ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {savedAddress ? 'Delivering to' : 'No delivery address yet'}
                    </p>
                    <p className="text-[11px] text-gray-700 font-medium leading-tight truncate">
                      {savedAddress || 'Set one from the address bar at the top of the shop.'}
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
                  <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 rounded-xl p-2.5">
                    <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-rose-800 font-medium leading-snug">{blockedReason}</p>
                  </div>
                )}

                {/* Select Payment Method Options */}
                <div className="space-y-1.5">
                  <p className="text-[11px] font-black text-gray-700 uppercase tracking-wider">Select Payment Method</p>
                  <div className="grid grid-cols-2 gap-2">
                    {/* PhonePe */}
                    <button
                      onClick={() => setPaymentMethod('PhonePe')}
                      className={`p-2 rounded-xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left ${
                        paymentMethod === 'PhonePe'
                          ? 'border-[#5F259F] bg-purple-50 text-[#5F259F] font-black'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-purple-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-[#5F259F] text-white flex items-center justify-center font-black text-[9px] shrink-0">
                        पे
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-extrabold leading-tight">PhonePe</p>
                        <p className="text-[8px] text-gray-400 font-semibold">UPI</p>
                      </div>
                    </button>

                    {/* Google Pay */}
                    <button
                      onClick={() => setPaymentMethod('Google Pay')}
                      className={`p-2 rounded-xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left ${
                        paymentMethod === 'Google Pay'
                          ? 'border-blue-600 bg-blue-50 text-blue-700 font-black'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-blue-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-white border border-gray-200 flex items-center justify-center font-black text-[8px] shrink-0">
                        <span className="text-[#4285F4]">G</span><span className="text-[#EA4335]">P</span><span className="text-[#FBBC05]">a</span><span className="text-[#34A853]">y</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-extrabold leading-tight">Google Pay</p>
                        <p className="text-[8px] text-gray-400 font-semibold">GPay</p>
                      </div>
                    </button>

                    {/* Paytm */}
                    <button
                      onClick={() => setPaymentMethod('Paytm')}
                      className={`p-2 rounded-xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left ${
                        paymentMethod === 'Paytm'
                          ? 'border-sky-600 bg-sky-50 text-sky-700 font-black'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-sky-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-[#002E6E] text-[#00BAF2] flex items-center justify-center font-black text-[8px] shrink-0">
                        Paytm
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-extrabold leading-tight">Paytm</p>
                        <p className="text-[8px] text-gray-400 font-semibold">UPI</p>
                      </div>
                    </button>

                    {/* VegWallet */}
                    <button
                      onClick={() => setPaymentMethod('VegWallet')}
                      className={`p-2 rounded-xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left ${
                        paymentMethod === 'VegWallet'
                          ? 'border-orange-600 bg-orange-50 text-orange-800 font-black'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-orange-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-orange-100 text-orange-800 flex items-center justify-center font-black text-xs shrink-0">
                        💳
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-extrabold leading-tight">VegWallet</p>
                        {/* Rounded to paise: the balance is a float derived
                            from the server's integer paise, so a refund can
                            leave it reading "Bal: ₹212.30000000000001". */}
                        <p className="text-[8px] text-orange-600 font-semibold">Bal: ₹{walletBalance.toFixed(2)}</p>
                      </div>
                    </button>

                    {/* Cash on Delivery */}
                    <button
                      onClick={() => setPaymentMethod('COD')}
                      className={`p-2 rounded-xl border-2 flex items-center gap-2 transition-all active:scale-95 text-left ${
                        paymentMethod === 'COD'
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-800 font-black'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-emerald-200'
                      }`}
                    >
                      <div className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-800 flex items-center justify-center font-black text-xs shrink-0">
                        💵
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-extrabold leading-tight">Cash on Delivery</p>
                        <p className="text-[8px] text-emerald-600 font-semibold">Pay at Doorstep</p>
                      </div>
                    </button>
                  </div>
                </div>

                {/* What the card is actually charged, when it differs from the total */}
                {isOnlinePayment && (
                  <div className="bg-white border border-gray-200 rounded-xl p-2.5 text-[11px] space-y-1">
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
                          <p className="text-[10px] text-gray-500 leading-tight pt-0.5">
                            ₹10 is the minimum online payment; the extra ₹{(cardAmount - shortfall).toFixed(0)} stays in your VegWallet.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                <button
                  onClick={handlePlaceOrder}
                  disabled={cartItems.length === 0 || isPaying || Boolean(blockedReason)}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-black py-3 rounded-xl text-sm transition-colors shadow-md flex items-center justify-center gap-2 active:scale-95"
                >
                  <span>
                    {blockedReason
                      ? 'Cannot place this order yet'
                      : isPaying
                        ? 'Waiting for payment…'
                        : isOnlinePayment && !walletCovers
                          ? `Pay ₹${cardAmount} • ${paymentMethod}`
                          : `Place Order • ₹${grandTotal} (${paymentMethod})`}
                  </span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
