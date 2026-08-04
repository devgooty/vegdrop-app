import React, { useState } from 'react';
import { X, Trash2, Plus, Minus, ShoppingBasket, CheckCircle2, MapPin } from 'lucide-react';

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

export default function CartModal({ isOpen, onClose, cartItems, onUpdateQuantity, onCheckout, walletBalance = 0, onSelectProduct }) {
  const [placed, setPlaced] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('COD'); // 'PhonePe' | 'Google Pay' | 'Paytm' | 'COD' | 'VegWallet'

  // The Razorpay checkout script is NOT loaded here. This modal no longer opens
  // checkout itself — card and UPI route through the wallet top-up in
  // WalletModal, which loads the script on demand via services/wallet.js.

  if (!isOpen) return null;

  const total = cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const deliveryFee = total > 0 && total < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;
  const grandTotal = total + deliveryFee;
  const savedAddress = localStorage.getItem('vegdrop_customer_location') || 'Koramangala, Bengaluru, Karnataka - 560034';

  const handlePlaceOrder = async () => {
    if (cartItems.length === 0) return;

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
     * UPI and card payments are funded through the wallet.
     *
     * This previously opened Razorpay inline with a hardcoded key id, called two
     * endpoints that no longer exist (/api/razorpay/*), swallowed both failures,
     * and then reported success regardless of whether anything had been
     * verified. Collecting money in the browser and informing the server
     * afterwards is not something the server can trust.
     *
     * Top-up now happens in WalletModal against a server-recorded payment
     * intent, and checkout debits that verified balance.
     */
    const result = await onCheckout(grandTotal, 'VegWallet');
    if (result === false) return;

    setPlaced(true);
    setTimeout(() => {
      setPlaced(false);
      onClose();
    }, 2500);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center z-[1000] animate-fade-in">
      <div className="bg-[#FFFDF9] w-full max-w-md h-[100dvh] flex flex-col justify-between shadow-2xl overflow-hidden relative">
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingBasket className="w-5 h-5 text-emerald-600" />
            <h3 className="font-bold text-gray-900 text-base">Your Basket ({cartItems.length})</h3>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100">
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

                {/* Delivery address */}
                <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-xl p-2.5">
                  <MapPin className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">Delivering to</p>
                    <p className="text-[11px] text-gray-700 font-medium leading-tight truncate">{savedAddress}</p>
                  </div>
                </div>

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
                        <p className="text-[8px] text-orange-600 font-semibold">Bal: ₹{walletBalance}</p>
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

                <button
                  onClick={handlePlaceOrder}
                  disabled={cartItems.length === 0}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black py-3 rounded-xl text-sm transition-colors shadow-md flex items-center justify-center gap-2 active:scale-95"
                >
                  <span>Place Order • ₹{grandTotal} ({paymentMethod})</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
