import React, { useMemo } from 'react';
import { Coins, Gift, Sparkles, Clock, Info } from 'lucide-react';
import { summarizeRewards, RUPEES_PER_BATCH, TOKENS_PER_BATCH } from '../services/rewards';
import SpinWheel from './SpinWheel';
import { useLanguage } from '../i18n/LanguageContext';
import { dateLocale } from '../i18n/catalog';

/**
 * The Rewards screen in the Account tab.
 *
 * Orders are filtered to this shopper the same way AccountHistory does it, so
 * the two screens always describe the same set of purchases — a rewards total
 * computed over a different list than the spend total sitting one tab away is
 * the sort of disagreement nobody can debug from a screenshot.
 *
 * The balance is stated as earned, never as spendable, and the screen says so:
 * there is no redemption path on the server yet, and a number presented as
 * currency that cannot buy anything is worse than no number.
 */
export default function AccountRewards({ user, orders }) {
  const { t, language } = useLanguage();
  const userOrders = useMemo(() => {
    if (!user) return [];
    return orders.filter((o) => o.customerName === user.name || o.phone === user.phone);
  }, [user, orders]);

  const { totalTokens, totalSpent, entries, shortfall } = useMemo(
    () => summarizeRewards(userOrders),
    [userOrders]
  );

  return (
    <div className="space-y-4 text-left animate-fade-in w-full max-w-md mx-auto">
      {/*
        Token balance, back on warm gold/copper rather than the emerald this
        card briefly wore — a three-stop gradient instead of the original
        flat two-stop, for depth without leaving the family that reads as
        "coins" here.
      */}
      <div className="bg-gradient-to-br from-[#F59E0B] via-[#C2660C] to-[#7C2D12] p-5 rounded-[2rem] shadow-[0_8px_20px_rgba(124,45,18,0.35)] text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -translate-y-8 translate-x-8" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-black/10 rounded-full blur-2xl translate-y-8 -translate-x-4" />
        {/* A single diagonal sheen across the whole card, the same device the
            spin wheel's segments use, so the two pieces of the same screen
            read as one material rather than two different design passes. */}
        <div
          className="absolute inset-0 opacity-[0.12]"
          style={{ background: 'linear-gradient(135deg, #FFFFFF 0%, transparent 55%)' }}
          aria-hidden="true"
        />

        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-amber-100/85 text-[11.5px] font-extrabold uppercase tracking-widest mb-1">
              {t('rewards.tokensEarned')}
            </p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-black tracking-tight text-white drop-shadow-sm">{totalTokens}</span>
              <span className="text-sm font-bold text-amber-100/90 mb-1">
                {totalTokens === 1 ? t('rewards.tokenOne') : t('rewards.tokens')}
              </span>
            </div>
          </div>
          <div className="w-12 h-12 bg-white/15 rounded-2xl flex items-center justify-center backdrop-blur-md border border-white/20 shadow-[0_3px_8px_rgba(0,0,0,0.2)]">
            <Coins className="w-6 h-6 text-white" strokeWidth={2.25} />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/15 pt-4 relative z-10">
          <div>
            <p className="text-amber-100/70 text-[10.5px] font-bold uppercase tracking-wider mb-0.5">
              {t('rewards.countedSpend')}
            </p>
            <p className="font-black text-lg text-white">₹{totalSpent.toLocaleString('en-IN')}</p>
          </div>
          <div>
            <p className="text-amber-100/70 text-[10.5px] font-bold uppercase tracking-wider mb-0.5">
              {t('rewards.earningOrders')}
            </p>
            <p className="font-black text-lg text-white">{entries.length}</p>
          </div>
        </div>
      </div>

      {/* The rule, stated plainly */}
      <div className="bg-white border border-amber-100 rounded-3xl p-4 shadow-sm">
        <h3 className="font-black text-slate-800 text-sm flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-amber-500" />
          {t('rewards.howYouEarn')}
        </h3>
        <p className="text-xs font-semibold text-slate-500 leading-relaxed">
          {t('rewards.rule', { rupees: RUPEES_PER_BATCH, tokens: TOKENS_PER_BATCH })}
        </p>

        {shortfall > 0 && (
          <p className="mt-3 flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-2xl px-3 py-2.5 text-[12.5px] font-bold text-amber-800 leading-relaxed">
            <Gift className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t('rewards.shortfall', { rupees: shortfall, tokens: TOKENS_PER_BATCH })}</span>
          </p>
        )}
      </div>

      {/* Sits directly under the earning rule: the wheel is what the tokens the
          rule describes are actually for. */}
      <SpinWheel userId={user?.id} totalTokens={totalTokens} />

      {/* Where the tokens came from */}
      <div className="space-y-3">
        <h3 className="font-black text-slate-800 text-sm px-2 drop-shadow-sm flex items-center gap-2">
          <Coins className="w-4 h-4 text-amber-600" />
          {t('rewards.tokenHistory')}
        </h3>

        {entries.length === 0 ? (
          <div className="bg-slate-50 border border-slate-100 rounded-3xl p-8 text-center text-slate-400">
            <Coins className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="font-bold text-sm">{t('rewards.noTokens')}</p>
            <p className="text-xs font-medium mt-1 opacity-70">
              {t('rewards.firstTokens', { rupees: RUPEES_PER_BATCH, tokens: TOKENS_PER_BATCH })}
            </p>
          </div>
        ) : (
          entries.map(({ order, tokens }) => (
            <div
              key={order.id}
              className="bg-white border border-slate-100 rounded-3xl p-4 shadow-sm relative overflow-hidden flex items-center justify-between gap-3"
            >
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-400" />

              <div className="min-w-0">
                <span className="block text-xs font-black text-slate-800 truncate">{order.id}</span>
                <div className="flex items-center gap-1 text-[11.5px] font-bold text-slate-400 mt-0.5">
                  <Clock className="w-3 h-3" />
                  {order.timestamp
                    ? new Date(order.timestamp).toLocaleDateString(dateLocale(language), {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })
                    : '—'}
                </div>
                <span className="text-[11.5px] font-bold text-slate-500 mt-0.5 block">
                  {t('rewards.orderTotal', { amount: order.totalAmount })}
                </span>
              </div>

              <span className="shrink-0 bg-amber-50 text-amber-700 border border-amber-200 font-black text-sm px-3 py-1.5 rounded-2xl flex items-center gap-1">
                <Coins className="w-3.5 h-3.5" />+{tokens}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Said out loud rather than discovered at a checkout that has no box for it. */}
      <p className="flex items-start gap-2 text-[12.5px] font-semibold text-slate-400 leading-relaxed px-2 pb-2">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>{t('rewards.spendNote')}</span>
      </p>
    </div>
  );
}
