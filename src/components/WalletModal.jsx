import React, { useState } from 'react';
import {
  X, Wallet, Plus, ArrowUpRight, ArrowDownRight,
  ChevronLeft, Clock, AlertCircle, ShieldCheck, Loader2
} from 'lucide-react';
import { topUpWallet } from '../services/wallet';
import { useLanguage } from '../i18n/LanguageContext';
import { dateLocale } from '../i18n/catalog';

// === BRANDED UPI LOGO COMPONENTS ===
const PhonePeLogo = () => (
  <div className="w-9 h-9 rounded-xl bg-[#5F259F] flex items-center justify-center text-white font-black text-xs shadow-sm shrink-0">
    पे
  </div>
);

const GPayLogo = () => (
  <div className="w-9 h-9 rounded-xl bg-white border border-gray-200 flex items-center justify-center shadow-sm shrink-0 overflow-hidden">
    <span className="font-black text-xs tracking-tighter">
      <span className="text-[#4285F4]">G</span>
      <span className="text-[#EA4335]">P</span>
      <span className="text-[#FBBC05]">a</span>
      <span className="text-[#34A853]">y</span>
    </span>
  </div>
);

const PaytmLogo = () => (
  <div className="w-9 h-9 rounded-xl bg-[#002E6E] flex items-center justify-center shadow-sm shrink-0">
    <span className="text-[#00BAF2] font-black text-[12.5px] tracking-tighter">Paytm</span>
  </div>
);

/**
 * The UPI apps checkout can be told to open directly.
 *
 * `method` is the key services/wallet.js maps to an Android package name, so a
 * label here and the app that actually opens cannot drift apart. The "1-Click"
 * badges that used to sit under these are gone: they promised a shortcut that
 * did not exist, since all three buttons opened the same generic sheet.
 */
const UPI_BUTTONS = [
  { method: 'PhonePe', Logo: PhonePeLogo, hoverBorder: 'hover:border-[#5F259F]', hoverText: 'group-hover:text-[#5F259F]' },
  { method: 'Google Pay', Logo: GPayLogo, hoverBorder: 'hover:border-blue-500', hoverText: 'group-hover:text-blue-600' },
  { method: 'Paytm', Logo: PaytmLogo, hoverBorder: 'hover:border-sky-500', hoverText: 'group-hover:text-sky-600' },
];

const QUICK_AMOUNTS = [100, 200, 500, 1000, 2000];

/**
 * ₹1,250 rather than ₹1250 — a statement is read at a glance.
 *
 * The grouping stays Indian (1,25,000) in all three languages, so the locale
 * only changes which digits are drawn, never where the commas fall.
 */
const rupeesIn = (value, locale) =>
  (value ?? 0).toLocaleString(locale, { maximumFractionDigits: 2 });

/**
 * Wallet balance and top-up.
 *
 * `balance` and `transactions` are read from the server ledger by the parent;
 * this component never computes or adjusts a balance itself.
 */
export default function WalletModal({ isOpen, onClose, balance, onRazorpayPayment, transactions = [], user = null }) {
  const { t, language } = useLanguage();
  // Holds the method being paid with, so the right button shows the spinner.
  const [payingWith, setPayingWith] = useState(null);
  const [payError, setPayError] = useState('');
  // Screen state: 'home' | 'add' | 'history'
  const [screen, setScreen] = useState('home');
  const [amountStr, setAmountStr] = useState('');

  const isProcessing = payingWith !== null;
  const amount = Number.parseInt(amountStr, 10);
  const amountValid = Number.isInteger(amount) && amount >= 10 && amount <= 50000;


  /**
   * `timestamp` was read off a field the API does not send, so every row said
   * "Invalid Date". It is guarded now as well as fixed — a statement line with
   * no date is worth showing without one, not worth breaking the list over.
   */
  const formatTs = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const locale = dateLocale(language);
    return (
      d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) +
      ', ' +
      d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
    );
  };

  /** Bound to the active language, so every amount on this screen matches. */
  const rupees = (value) => rupeesIn(value, dateLocale(language));

  // The checkout script is loaded on demand by services/wallet.js when a top-up
  // actually starts, rather than eagerly on every wallet open.

  if (!isOpen) return null;

  /**
   * @param {string|null} method the payment label chosen, e.g. 'PhonePe'.
   *   Passed through to Razorpay so a branded button opens that app rather than
   *   the generic sheet — it used to be accepted here and then ignored, which
   *   made all four buttons the same button.
   */
  const handleProceedToPay = async (method = null) => {
    // Inline, not alert(): a blocking dialog over a payment sheet is the wrong
    // place to interrupt someone, and the button is already disabled for these.
    if (!Number.isInteger(amount)) return setPayError(t('wallet.enterAmount'));
    if (amount < 10) return setPayError(t('wallet.minTopUp'));
    if (amount > 50000) return setPayError(t('wallet.maxTopUp'));
    if (isProcessing) return undefined;

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
    setPayingWith(method || 'all');
    setPayError('');
    try {
      const result = await topUpWallet(amount, user, { method });
      setAmountStr('');
      setScreen('home');
      onRazorpayPayment && onRazorpayPayment(result);
    } catch (error) {
      // A failure is reported as a failure. Never credit on an error path.
      setPayError(
        error?.message === 'Payment cancelled.'
          ? t('wallet.cancelled')
          : error?.message || t('wallet.unconfirmed')
      );
    } finally {
      setPayingWith(null);
    }
    return undefined;
  };

  // ---- SCREENS ----

  const renderHome = () => (
    <div className="space-y-5 animate-fade-in p-5">
      {/* Balance Card */}
      <div className="bg-gradient-to-br from-[#1B4D3E] via-[#2D6A4F] to-[#1B4D3E] text-white rounded-3xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-40 h-40 bg-white/5 rounded-full -translate-y-10 translate-x-10" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-white/5 rounded-full translate-y-8 -translate-x-6" />
        <p className="text-emerald-200 text-xs font-bold uppercase tracking-widest mb-1 relative">{t('wallet.availableBalance')}</p>
        <div className="flex items-baseline gap-1 relative mb-4">
          <span className="text-2xl font-black">₹</span>
          <span className="text-5xl font-black tracking-tight">{rupees(balance)}</span>
        </div>
        <div className="flex gap-3 relative">
          <button onClick={() => setScreen('add')} className="flex-1 bg-white/20 hover:bg-white/30 backdrop-blur text-white font-black py-2.5 rounded-2xl text-xs flex items-center justify-center gap-1.5 transition-all active:scale-95 border border-white/20">
            <Plus className="w-4 h-4" /> {t('wallet.addMoney')}
          </button>
          <button onClick={() => setScreen('history')} className="flex-1 bg-white/10 hover:bg-white/20 backdrop-blur text-white font-bold py-2.5 rounded-2xl text-xs flex items-center justify-center gap-1.5 transition-all active:scale-95 border border-white/10">
            <Clock className="w-4 h-4" /> {t('wallet.history')}
          </button>
        </div>
      </div>

      {/* Recent Transactions */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h4 className="font-black text-gray-900 text-sm">{t('wallet.recent')}</h4>
          <button onClick={() => setScreen('history')} className="text-emerald-600 text-xs font-bold">{t('list.seeAll')}</button>
        </div>
        {transactions.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">{t('wallet.noTransactions')}</p>
        ) : (
          <div className="space-y-2">
            {/* `tx`, not `t` — `t` is the translate function in this scope. */}
            {transactions.slice(0, 4).map(tx => (
              <div key={tx.id} className="flex items-center gap-3 bg-white rounded-2xl p-3 border border-gray-100 shadow-sm">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${tx.type === 'credit' ? 'bg-emerald-100' : 'bg-rose-100'}`}>
                  {tx.type === 'credit'
                    ? <ArrowUpRight className="w-4 h-4 text-emerald-700" />
                    : <ArrowDownRight className="w-4 h-4 text-rose-700" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-gray-900 text-sm truncate">{tx.label}</p>
                  <p className="text-[11.5px] text-gray-400">{formatTs(tx.timestamp)}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-black text-sm ${tx.type === 'credit' ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {tx.type === 'credit' ? '+' : '−'}₹{rupees(tx.amount)}
                  </p>
                  {/* The running balance, in place of a chip that could only
                      ever read "Success" — every ledger row is money that
                      already moved. */}
                  <p className="text-[10.5px] text-gray-400 font-semibold">
                    {t('wallet.balShort', { amount: rupees(tx.balanceAfter) })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderAddMoney = () => (
    <div className="flex flex-col h-full bg-[#FAFAF8] p-5">
      <button onClick={() => setScreen('home')} className="flex items-center gap-2 text-gray-500 text-sm font-bold mb-4">
        <ChevronLeft className="w-4 h-4" /> {t('wallet.backToWallet')}
      </button>
      
      <div className="flex-1">
        <h3 className="font-black text-gray-900 text-2xl mb-1">{t('wallet.rechargeTitle')}</h3>
        <p className="text-sm text-gray-500 mb-8">{t('wallet.rechargeSub')}</p>
        
        {/* Amount Input */}
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 mb-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-50 rounded-bl-full opacity-50 pointer-events-none" />
          <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 text-center">{t('wallet.amountLabel')}</label>
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
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">{t('wallet.quickSelect')}</p>
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

        {/* Instant UPI App Options (PhonePe, GPay, Paytm) */}
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">{t('wallet.payViaUpi')}</p>
        <div className="grid grid-cols-3 gap-2.5 mb-6">
          {UPI_BUTTONS.map(({ method, Logo, hoverBorder, hoverText }) => (
            <button
              key={method}
              onClick={() => handleProceedToPay(method)}
              // Disabled during a payment as well as on a bad amount: without
              // this a second tap opened a second checkout over the first.
              disabled={!amountValid || isProcessing}
              className={`bg-white border-2 border-gray-100 ${hoverBorder} rounded-2xl p-3 flex flex-col items-center gap-1.5 shadow-sm transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none group`}
            >
              {payingWith === method ? (
                <div className="w-9 h-9 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              ) : (
                <Logo />
              )}
              <span className={`font-extrabold text-xs text-gray-900 ${hoverText}`}>{method}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-[11.5px] text-gray-400 font-bold justify-center bg-gray-100/50 py-3 rounded-xl border border-gray-100">
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          {t('wallet.secured')}
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
          disabled={!amountValid || isProcessing}
          className="w-full py-4 bg-emerald-600 disabled:bg-gray-300 text-white rounded-2xl font-black text-lg shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2"
        >
          {payingWith === 'all' && <Loader2 className="w-5 h-5 animate-spin" />}
          {payingWith === 'all'
            ? t('wallet.waiting')
            : amountValid
              ? t('wallet.addAmount', { amount: rupees(amount) })
              : t('wallet.otherMethods')}
        </button>
      </div>
    </div>
  );

  const renderHistory = () => (
    <div className="flex flex-col h-full bg-[#FAFAF8] p-5">
      <button onClick={() => setScreen('home')} className="flex items-center gap-2 text-gray-500 text-sm font-bold mb-4">
        <ChevronLeft className="w-4 h-4" /> {t('wallet.backToWallet')}
      </button>
      <h3 className="font-black text-gray-900 text-xl mb-4">{t('wallet.historyTitle')}</h3>
      {transactions.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-8">{t('wallet.noTransactions')}</p>
      ) : (
        <div className="space-y-2 flex-1 overflow-y-auto pr-1 pb-10">
          {transactions.map(tx => (
            <div key={tx.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${tx.type === 'credit' ? 'bg-emerald-100' : 'bg-rose-100'}`}>
                    {tx.type === 'credit' ? <ArrowUpRight className="w-4 h-4 text-emerald-700" /> : <ArrowDownRight className="w-4 h-4 text-rose-700" />}
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-gray-900 text-sm">{tx.label}</p>
                    {/* The server's own note, which carries the order number.
                        This slot used to print a `method` field the API has
                        never sent, so it always read "Wallet". */}
                    {tx.note && <p className="text-[11.5px] text-gray-400 truncate">{tx.note}</p>}
                  </div>
                </div>
                <p className={`font-black text-sm shrink-0 ${tx.type === 'credit' ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {tx.type === 'credit' ? '+' : '−'}₹{rupees(tx.amount)}
                </p>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-50">
                <p className="text-[11.5px] text-gray-400">{formatTs(tx.timestamp)}</p>
                <p className="text-[11.5px] text-gray-500 font-semibold">
                  {t('wallet.balanceAfter', { amount: rupees(tx.balanceAfter) })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
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
  );
}
