import React, { useState, useEffect } from 'react';
import {
  X, Wallet, Plus, ArrowUpRight, ArrowDownRight, CheckCircle,
  Copy, Check, Building2, Smartphone, ChevronLeft, Clock, AlertCircle, RefreshCw,
  ShieldCheck, CreditCard, Loader2
} from 'lucide-react';
import { topUpWallet } from '../services/wallet';



// === WALLET MODAL ===
/**
 * What each ledger entry is, in words.
 *
 * The list used to render `t.label`, which the server has never sent — every
 * row showed a blank name. It also read `t.status` through a STATUS_CONFIG map
 * that fell back to "Success", so every entry wore a green Success badge
 * whatever it was.
 *
 * The badge is gone rather than corrected: `WalletTransaction` has no status
 * field, because it cannot have one. The ledger is append-only and an entry is
 * written only once the money has actually moved — a failed top-up produces no
 * row at all. A "Success" badge on every line was decoration standing in for a
 * distinction the data does not make.
 */
const REASON_LABEL = {
  razorpay_topup: 'Money added',
  order_payment: 'Order payment',
  order_refund: 'Refund',
  promotional_credit: 'Promotional credit',
  admin_adjustment: 'Adjustment',
  stall_settlement: 'Payout for goods supplied',
};

function describeEntry(entry) {
  return entry.note || REASON_LABEL[entry.reason] || (entry.type === 'credit' ? 'Credit' : 'Debit');
}

const QUICK_AMOUNTS = [100, 200, 500, 1000, 2000];

/**
 * Wallet balance and top-up.
 *
 * `balance` and `transactions` are read from the server ledger by the parent;
 * this component never computes or adjusts a balance itself.
 */
export default function WalletModal({ isOpen, onClose, balance, onRazorpayPayment, transactions = [], user = null }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [payError, setPayError] = useState('');
  // Screen state: 'home' | 'add' | 'history'
  const [screen, setScreen] = useState('home');
  const [amountStr, setAmountStr] = useState('');
  // `showRazorpay` and `selectedMethod` lived here and were never read: the
  // mock checkout they drove is gone, and the brand tiles that set the method
  // discarded it. Razorpay's own sheet owns both concerns now.


  /**
   * The server sends `createdAt`. This read `t.timestamp`, which no wallet
   * response has ever carried, so every row rendered 'Invalid Date'.
   */
  const formatTs = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ', ' + d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };

  // The checkout script is loaded on demand by services/wallet.js when a top-up
  // actually starts, rather than eagerly on every wallet open.

  if (!isOpen) return null;

  const handleProceedToPay = async () => {
    const amt = parseInt(amountStr, 10);
    // Reported inline, beside the field, rather than through a browser alert:
    // this modal already has somewhere to say what went wrong, and an alert()
    // thrown over a payment sheet gets dismissed without being read.
    if (!amt || Number.isNaN(amt)) return setPayError('Enter an amount to add.');
    if (amt < 10) return setPayError('The smallest top-up is ₹10.');
    if (amt > 50000) return setPayError('The largest top-up is ₹50,000.');
    
    /**
     * Hand the whole top-up to the wallet service.
     *
     * It records a server-side intent, opens Razorpay with the key id the
     * server supplies, and posts the result back for verification. The balance
     * that comes back is read from the server's ledger.
     *
     * What this replaces mattered: the old path opened Razorpay with a
     * hardcoded key, called two endpoints that no longer exist, swallowed both
     * failures, and then reported `status: 'success'` anyway — including from
     * its own catch block. Any error, including a declined card, credited the
     * wallet.
     */
    setIsProcessing(true);
    setPayError('');
    try {
      const result = await topUpWallet(amt, user);
      setAmountStr('');
      setScreen('home');
      onRazorpayPayment && onRazorpayPayment(result);
    } catch (error) {
      // A failure is reported as a failure. Never credit on an error path.
      setPayError(
        error?.message === 'Payment cancelled.'
          ? 'Payment was cancelled.'
          : error?.message || 'Top-up failed. If you were charged, it will be reconciled.'
      );
    } finally {
      setIsProcessing(false);
    }
  };

  // ---- SCREENS ----

  const renderHome = () => (
    <div className="space-y-5 animate-fade-in p-5">
      {/* Balance Card */}
      <div className="bg-gradient-to-br from-[#1B4D3E] via-[#2D6A4F] to-[#1B4D3E] text-white rounded-3xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-40 h-40 bg-white/5 rounded-full -translate-y-10 translate-x-10" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-white/5 rounded-full translate-y-8 -translate-x-6" />
        <p className="text-emerald-200 text-xs font-bold uppercase tracking-widest mb-1 relative">Available Balance</p>
        <div className="flex items-baseline gap-1 relative mb-4">
          <span className="text-2xl font-black">₹</span>
          <span className="text-5xl font-black tracking-tight">{(balance || 0).toFixed(0)}</span>
        </div>
        <div className="flex gap-3 relative">
          <button onClick={() => setScreen('add')} className="flex-1 bg-white/20 hover:bg-white/30 backdrop-blur text-white font-black py-2.5 rounded-2xl text-xs flex items-center justify-center gap-1.5 transition-all active:scale-95 border border-white/20">
            <Plus className="w-4 h-4" /> Add Money
          </button>
          <button onClick={() => setScreen('history')} className="flex-1 bg-white/10 hover:bg-white/20 backdrop-blur text-white font-bold py-2.5 rounded-2xl text-xs flex items-center justify-center gap-1.5 transition-all active:scale-95 border border-white/10">
            <Clock className="w-4 h-4" /> History
          </button>
        </div>
      </div>

      {/* Recent Transactions */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h4 className="font-black text-gray-900 text-sm">Recent Transactions</h4>
          <button onClick={() => setScreen('history')} className="text-emerald-600 text-xs font-bold">See All</button>
        </div>
        {transactions.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No transactions yet.</p>
        ) : (
          <div className="space-y-2">
            {transactions.slice(0, 4).map(t => {
              return (
                <div key={t.id} className="flex items-center gap-3 bg-white rounded-2xl p-3 border border-gray-100 shadow-sm">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${t.type === 'credit' ? 'bg-emerald-100' : 'bg-rose-100'}`}>
                    {t.type === 'credit'
                      ? <ArrowUpRight className="w-4 h-4 text-emerald-700" />
                      : <ArrowDownRight className="w-4 h-4 text-rose-700" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-sm truncate">{describeEntry(t)}</p>
                    <p className="text-[10px] text-gray-400 font-mono">{formatTs(t.createdAt)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`font-black text-sm ${t.type === 'credit' ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {t.type === 'credit' ? '+' : '-'}₹{t.amount}
                    </p>
                    <span className="text-[9px] text-gray-400 font-bold">
                      bal ₹{t.balanceAfter}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const renderAddMoney = () => (
    <div className="flex flex-col h-full bg-[#FAFAF8] p-5">
      <button onClick={() => setScreen('home')} className="flex items-center gap-2 text-gray-500 text-sm font-bold mb-4">
        <ChevronLeft className="w-4 h-4" /> Back to Wallet
      </button>
      
      <div className="flex-1">
        <h3 className="font-black text-gray-900 text-2xl mb-1">Recharge Wallet</h3>
        <p className="text-sm text-gray-500 mb-8">Enter amount to add via secure checkout</p>
        
        {/* Amount Input */}
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 mb-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-50 rounded-bl-full opacity-50 pointer-events-none" />
          <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 text-center">Amount (₹)</label>
          <div className="flex items-center justify-center gap-1 border-b-2 border-gray-200 focus-within:border-emerald-500 transition-colors pb-2">
            <span className="text-4xl font-black text-gray-400">₹</span>
            <input 
              type="number" 
              value={amountStr} 
              onChange={e => setAmountStr(e.target.value)}
              className="text-5xl font-black text-gray-900 bg-transparent outline-none w-48 text-center"
              placeholder="0"
              autoFocus
            />
          </div>
        </div>

        {/* Quick Select */}
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Quick Select Amount</p>
        <div className="flex flex-wrap gap-2 mb-6">
          {QUICK_AMOUNTS.map(amt => (
            <button 
              key={amt} 
              onClick={() => setAmountStr(amt.toString())}
              className={`px-4 py-2 rounded-xl font-black text-sm border-2 transition-all ${
                amountStr === amt.toString() 
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-700' 
                  : 'border-gray-200 bg-white text-gray-600 hover:border-emerald-300'
              }`}
            >
              +₹{amt}
            </button>
          ))}
        </div>

        {/*
          The PhonePe / Google Pay / Paytm buttons that stood here are gone.

          All three called `handleProceedToPay('PhonePe' | 'Google Pay' |
          'Paytm')`, and that argument was never read — every one of them opened
          the same generic Razorpay checkout as the button below. Three branded
          tiles, one of them badged "1-Click", offering a choice that was
          discarded the moment it was made.

          Razorpay's own checkout lists the UPI apps installed on the device and
          selects between them properly, which is the thing those tiles were
          pretending to do. Sending people straight there is both honest and
          fewer taps.
        */}
        <div className="flex items-center gap-2 text-[10px] text-gray-400 font-bold justify-center bg-gray-100/50 py-3 rounded-xl border border-gray-100 mb-2">
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          UPI, cards and net banking • Min ₹10 • Max ₹50,000
        </div>
      </div>

      <div className="pt-4 mt-auto border-t border-gray-100 space-y-3">
        {/* A failed or cancelled payment is shown, never silently treated as success. */}
        {payError && (
          <div className="flex items-start gap-2 p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{payError}</span>
          </div>
        )}
        <button
          onClick={() => handleProceedToPay()}
          disabled={isProcessing || !amountStr || parseInt(amountStr, 10) < 10}
          className="w-full py-4 bg-emerald-600 disabled:bg-gray-300 text-white rounded-2xl font-black text-lg shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2"
        >
          {isProcessing && <Loader2 className="w-5 h-5 animate-spin" />}
          {isProcessing ? 'Processing…' : 'Pay securely'}
        </button>
      </div>
    </div>
  );

  const renderHistory = () => (
    <div className="flex flex-col h-full bg-[#FAFAF8] p-5">
      <button onClick={() => setScreen('home')} className="flex items-center gap-2 text-gray-500 text-sm font-bold mb-4">
        <ChevronLeft className="w-4 h-4" /> Back to Wallet
      </button>
      <h3 className="font-black text-gray-900 text-xl mb-4">Transaction History</h3>
      {transactions.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-8">No transactions yet.</p>
      ) : (
        <div className="space-y-2 flex-1 overflow-y-auto pr-1 pb-10">
          {transactions.map(t => {
            return (
              <div key={t.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${t.type === 'credit' ? 'bg-emerald-100' : 'bg-rose-100'}`}>
                      {t.type === 'credit' ? <ArrowUpRight className="w-4 h-4 text-emerald-700" /> : <ArrowDownRight className="w-4 h-4 text-rose-700" />}
                    </div>
                    <div>
                      <p className="font-bold text-gray-900 text-sm">{describeEntry(t)}</p>
                      <p className="text-[10px] text-gray-400 font-mono">{t.method || 'Wallet'}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`font-black text-sm ${t.type === 'credit' ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {t.type === 'credit' ? '+' : '-'}₹{t.amount}
                    </p>
                    <span className="text-[9px] text-gray-400 font-bold">
                      bal ₹{t.balanceAfter}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-50">
                  {/* `t.refId` was rendered here and the server has never sent
                      it, so the guard meant it simply never appeared. Removed
                      rather than left as a field somebody later tries to
                      populate believing it was once wired. */}
                  <p className="text-[10px] text-gray-400 font-mono">{formatTs(t.createdAt)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center z-[200] animate-fade-in">
        <div className="bg-[#FAFAF8] w-full max-w-md h-[100dvh] flex flex-col shadow-2xl overflow-hidden relative animate-slide-up">
          {/* Handle */}
          <div className="flex-shrink-0 pt-4 pb-3 px-6 flex items-center justify-between border-b border-gray-100 bg-white z-10">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-emerald-100 rounded-xl flex items-center justify-center">
                <Wallet className="w-4 h-4 text-[#1B4D3E]" />
              </div>
              <span className="font-black text-gray-900 text-base">VegWallet</span>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-200 transition-colors">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {screen === 'home' && renderHome()}
            {screen === 'add' && renderAddMoney()}
            {screen === 'history' && renderHistory()}
          </div>
        </div>
      </div>

      {/* MOCK RAZORPAY REMOVED - NOW USING OFFICIAL SDK */}
    </>
  );
}
