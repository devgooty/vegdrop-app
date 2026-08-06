import React, { useState, useEffect, useCallback } from 'react';
import { Store, ChevronRight, Check } from 'lucide-react';
import { fetchNearbyShops } from '../services/shops';
import { savedCustomerCoords } from '../services/markets';

/**
 * Local shops near you — the shopkeepers who sell from their own premises.
 *
 * The counterpart to MarketPicker, and deliberately a separate section rather
 * than rows merged into it. A market is a place with stalls competing behind the
 * scenes; a shop is one person. Merging them would mean one list where picking
 * two adjacent rows means two quite different things, and would drag
 * MarketPicker's auto-select and copy into the change.
 *
 * Markets stay the default: MarketPicker still auto-selects the nearest one it
 * can, and choosing a shop here is an explicit switch.
 *
 * Renders nothing at all when there is nothing to show — no location yet, no
 * shops nearby, or the request failed. A quiet absence is right for a secondary
 * section; the market card above is already carrying the "set your address"
 * message, and during a rolling deploy an older API can 500 this endpoint
 * outright, which is not the customer's problem to read about.
 */
export default function NearbyShops({ coords, selectedShop, onSelectShop }) {
  const [shops, setShops] = useState([]);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const where = coords || savedCustomerCoords();
    if (!where) {
      setShops([]);
      return;
    }
    try {
      setShops(await fetchNearbyShops({ ...where, radius: 20000 }));
    } catch {
      // Fail soft — see the component comment.
      setShops([]);
    }
  }, [coords]);

  useEffect(() => {
    load();
  }, [load]);

  if (shops.length === 0) return null;

  const usableShops = shops.filter((s) => s.deliverable);

  return (
    <div className="mx-4 mt-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full bg-white rounded-2xl border border-gray-200 shadow-sm px-4 py-3.5 flex items-center gap-3 text-left active:bg-gray-50"
      >
        <span className="w-10 h-10 rounded-xl bg-amber-500 flex items-center justify-center shrink-0">
          <Store className="w-5 h-5 text-white" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[10px] font-bold text-amber-700 uppercase tracking-wider">
            Local shops near you
          </span>
          <span className="block text-[14px] font-extrabold text-gray-900 truncate">
            {selectedShop ? selectedShop.name : `${usableShops.length || shops.length} nearby`}
          </span>
          <span className="block text-[11.5px] text-gray-500 truncate">
            {selectedShop
              ? `${selectedShop.distanceKm} km away · shopping from here`
              : 'Buy straight from a shop in your area'}
          </span>
        </span>
        <ChevronRight
          className={`w-5 h-5 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {expanded && (
        <ul className="mt-2 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden divide-y divide-gray-100">
          {shops.map((shop) => {
            const chosen = selectedShop?.id === shop.id;

            return (
              <li key={shop.id}>
                <button
                  onClick={() => {
                    if (!shop.deliverable) return;
                    onSelectShop(shop);
                    setExpanded(false);
                  }}
                  disabled={!shop.deliverable}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left active:bg-gray-50 disabled:opacity-50"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13.5px] font-bold text-gray-900 truncate">
                      {shop.name}
                    </span>
                    <span className="block text-[11.5px] text-gray-500 truncate">
                      {shop.distanceKm} km
                      {shop.deliverable
                        ? shop.address
                          ? ` · ${shop.address}`
                          : ''
                        : ' · too far to deliver'}
                    </span>
                  </span>
                  {chosen && <Check className="w-4.5 h-4.5 text-amber-600 shrink-0" strokeWidth={3} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
