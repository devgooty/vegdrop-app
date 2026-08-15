import React, { useState, useEffect, useCallback } from 'react';
import { Store, MapPin, ChevronRight, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { fetchNearbyMarkets, currentPosition, savedCustomerCoords } from '../services/markets';

/**
 * Which market am I shopping from?
 *
 * A customer picks a market, never a stall. The stalls inside it compete for
 * the order once it is placed, which is invisible from here and should stay
 * that way — from the customer's side this is simply "the shop I am buying
 * from today".
 *
 * Markets are ordered by distance, and one further away than it will deliver is
 * shown greyed rather than hidden. "Too far to deliver" answers the question;
 * a market silently missing from the list just raises it.
 */
export default function MarketPicker({ selectedMarket, onSelectMarket }) {
  const { t } = useLanguage();
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The address picker has been saving coordinates all along; fall back to
      // asking the browser only if it has none.
      const coords = savedCustomerCoords() || (await currentPosition());
      if (!coords) {
        setError('needs-location');
        setMarkets([]);
        return;
      }

      const found = await fetchNearbyMarkets({ ...coords, radius: 20000 });
      setMarkets(found);

      // Pick the nearest deliverable market automatically. Making someone
      // choose before they can see a single vegetable is a pointless step when
      // there is an obvious right answer.
      if (!selectedMarket) {
        const best = found.find((m) => m.deliverable && m.isOpen && m.openStalls > 0) || found[0];
        if (best) onSelectMarket(best);
      }
    } catch (err) {
      setError(err.message || 'Could not find markets near you.');
    } finally {
      setLoading(false);
    }
    // `selectedMarket` is deliberately not a dependency: re-running on every
    // selection would refetch the list each time the customer switched market.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectMarket]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && markets.length === 0) {
    return (
      <div className="mx-4 mt-4 rounded-2xl bg-white border border-gray-200 px-4 py-4 flex items-center gap-3">
        <RefreshCw className="w-4 h-4 text-emerald-600 animate-spin shrink-0" />
        <span className="text-[13px] text-gray-600">Finding markets near you…</span>
      </div>
    );
  }

  if (error === 'needs-location') {
    return (
      <div className="mx-4 mt-4 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-4 flex items-start gap-3">
        <MapPin className="w-4.5 h-4.5 text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-bold text-amber-900">{t('market.needAddressTitle')}</p>
          <p className="text-[12px] text-amber-800 mt-0.5 leading-relaxed">
            {t('market.needAddressHint')}
          </p>
        </div>
        <button
          onClick={load}
          className="text-[12px] font-bold text-amber-900 underline underline-offset-2 shrink-0"
        >
          {t('market.retry')}
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-4 mt-4 rounded-2xl bg-white border border-gray-200 px-4 py-4 flex items-start gap-3">
        <AlertTriangle className="w-4.5 h-4.5 text-gray-400 shrink-0 mt-0.5" />
        <p className="text-[13px] text-gray-600 flex-1">{error}</p>
        <button onClick={load} className="text-[12px] font-bold text-emerald-700 underline shrink-0">
          {t('market.retry')}
        </button>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="mx-4 mt-4 rounded-2xl bg-white border border-dashed border-gray-300 px-5 py-6 text-center">
        <Store className="w-6 h-6 text-gray-400 mx-auto mb-2" />
        <p className="text-[13.5px] font-bold text-gray-900">No markets deliver here yet</p>
        <p className="text-[12px] text-gray-500 mt-1">We are opening in new areas all the time.</p>
      </div>
    );
  }

  return (
    <div className="mx-4 mt-4">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full bg-white rounded-2xl border border-gray-200 shadow-sm px-4 py-3.5 flex items-center gap-3 text-left active:bg-gray-50"
      >
        <span className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
          <Store className="w-5 h-5 text-white" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[10px] font-bold text-emerald-700 uppercase tracking-wider">
            Shopping from
          </span>
          <span className="block text-[14px] font-extrabold text-gray-900 truncate">
            {selectedMarket ? selectedMarket.name : 'Choose a market'}
          </span>
          {selectedMarket && (
            <span className="block text-[11.5px] text-gray-500">
              {selectedMarket.distanceKm} km away · {selectedMarket.openStalls} stall
              {selectedMarket.openStalls === 1 ? '' : 's'} open
            </span>
          )}
        </span>
        <ChevronRight
          className={`w-5 h-5 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {expanded && (
        <ul className="mt-2 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden divide-y divide-gray-100">
          {markets.map((market) => {
            const chosen = selectedMarket?.id === market.id;
            const usable = market.deliverable && market.isOpen;

            return (
              <li key={market.id}>
                <button
                  onClick={() => {
                    if (!usable) return;
                    onSelectMarket(market);
                    setExpanded(false);
                  }}
                  disabled={!usable}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left active:bg-gray-50 disabled:opacity-50"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13.5px] font-bold text-gray-900 truncate">
                      {market.name}
                    </span>
                    <span className="block text-[11.5px] text-gray-500 truncate">
                      {market.distanceKm} km ·{' '}
                      {!market.isOpen
                        ? 'closed right now'
                        : !market.deliverable
                          ? 'too far to deliver'
                          : `${market.openStalls} stall${market.openStalls === 1 ? '' : 's'} open`}
                    </span>
                  </span>
                  {chosen && <Check className="w-4.5 h-4.5 text-emerald-600 shrink-0" strokeWidth={3} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
