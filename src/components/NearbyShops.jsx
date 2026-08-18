import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Store, ChevronRight, Check } from 'lucide-react';
import { fetchNearbyShops, fetchShopsForBasket } from '../services/shops';
import { savedCustomerCoords } from '../services/markets';
import { useLanguage } from '../i18n/LanguageContext';

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
 * ONCE THERE IS A BASKET, DISTANCE STOPS BEING THE QUESTION.
 *
 * Checkout requires every line of an order to belong to the one shop it is
 * placed with, so a shop missing a single item cannot take the order at all.
 * Ranking on distance alone therefore offered shops that could not be ordered
 * from, and the customer only found out at checkout. With a basket the list is
 * ranked on how much of it each shop can supply, shops that cannot supply all of
 * it are shown but not selectable, and a selection that stops being able to fill
 * the basket moves itself to one that can.
 *
 * Renders nothing at all when there are no shops nearby — no location yet, none
 * in range, or the request failed. A quiet absence is right for a secondary
 * section; the market card above already carries the "set your address" message,
 * and during a rolling deploy an older API can 500 this endpoint outright, which
 * is not the customer's problem to read about. Shops that exist but cannot serve
 * this basket are a different case and do get said out loud — otherwise the
 * section silently empties the moment a basket grows past what anyone stocks.
 */
export default function NearbyShops({ coords, selectedShop, onSelectShop, basket = [] }) {
  const { t } = useLanguage();
  const [shops, setShops] = useState([]);
  const [expanded, setExpanded] = useState(false);

  /**
   * A stable dependency for an array prop. Without it every parent render is a
   * new array identity and the effect below refetches on each keystroke
   * elsewhere on the page.
   */
  const basketKey = useMemo(
    () => basket.map((line) => `${line.productId}:${line.quantity}`).sort().join(','),
    [basket]
  );

  const load = useCallback(async () => {
    const where = coords || savedCustomerCoords();
    if (!where) {
      setShops([]);
      return;
    }
    try {
      const lines = basketKey
        ? basketKey.split(',').map((entry) => {
            const [productId, quantity] = entry.split(':');
            return { productId, quantity: Number(quantity) };
          })
        : [];

      setShops(
        lines.length > 0
          ? await fetchShopsForBasket({ ...where, radius: 20000, items: lines })
          : await fetchNearbyShops({ ...where, radius: 20000 })
      );
    } catch {
      // Fail soft — see the component comment.
      setShops([]);
    }
  }, [coords, basketKey]);

  useEffect(() => {
    load();
  }, [load]);

  /** With no basket every shop is orderable; the question has not been asked. */
  const orderable = (shop) => shop.deliverable && (shop.canFillBasket ?? true);

  const best = shops.find(orderable) || null;
  const chosenShop = selectedShop ? shops.find((s) => s.id === selectedShop.id) : null;

  /**
   * Move a selection that can no longer fill the basket onto one that can.
   *
   * This is the automatic part, and it is scoped to a shop the customer already
   * chose. Auto-selecting a shop for someone browsing a MARKET would silently
   * swap their seller and reprice their basket underneath them — a market and a
   * shop are different sellers with different price sheets, so that has to stay
   * the explicit switch it is today.
   *
   * `onSelectShop` is read through a ref so this fires on the shop list changing
   * and not on the parent handing down a new callback identity.
   */
  const selectRef = useRef(onSelectShop);
  useEffect(() => {
    selectRef.current = onSelectShop;
  });

  useEffect(() => {
    if (!selectedShop || !chosenShop || orderable(chosenShop) || !best) return;
    selectRef.current?.(best);
  }, [selectedShop, chosenShop, best]);

  if (shops.length === 0) return null;

  const hasBasket = basketKey.length > 0;
  const usableShops = shops.filter(orderable);
  /** Shops are nearby, but this basket is bigger than any one of them stocks. */
  const noneCanFill = hasBasket && usableShops.length === 0;

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
            {t('shops.nearYou')}
          </span>
          <span className="block text-[14px] font-extrabold text-gray-900 truncate">
            {/* How many shops are NEARBY, which is always `shops.length`.
                This counted `usableShops` once there was a basket, so three
                shops down the road announced themselves as "1 nearby" — the
                title repeating the subtitle underneath it and hiding the other
                two, which are still worth knowing about and still listed when
                this opens. How many can fill the basket is the line below. */}
            {selectedShop
              ? selectedShop.name
              : noneCanFill
                ? t('shops.noneCanFill')
                : t('shops.nearbyCount', { count: shops.length })}
          </span>
          <span className="block text-[11.5px] text-gray-500 truncate">
            {noneCanFill
              ? t('shops.noneCanFillHint')
              : selectedShop
                ? t('shops.shoppingHere', { km: selectedShop.distanceKm })
                : hasBasket
                  ? t('shops.canFillCount', { count: usableShops.length })
                  : t('shops.buyDirect')}
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
            const canOrder = orderable(shop);
            // Only worth pointing out when there is something to compare it to.
            const isBest = hasBasket && canOrder && shop.id === best?.id && shops.length > 1;

            return (
              <li key={shop.id}>
                <button
                  onClick={() => {
                    if (!canOrder) return;
                    onSelectShop(shop);
                    setExpanded(false);
                  }}
                  disabled={!canOrder}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left active:bg-gray-50 disabled:opacity-50"
                >
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[13.5px] font-bold text-gray-900 truncate">
                        {shop.name}
                      </span>
                      {isBest && (
                        <span className="shrink-0 text-[9px] font-black uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-1.5 py-0.5">
                          {t('shops.bestMatch')}
                        </span>
                      )}
                    </span>
                    <span className="block text-[11.5px] text-gray-500 truncate">
                      {/* What stops this shop being usable comes first — the
                          address is no help when the answer is "not this one".
                          Distance is only the reason when coverage is not. */}
                      {hasBasket && !shop.canFillBasket
                        ? t('shops.hasSomeOfBasket', { covered: shop.covered, total: shop.total })
                        : !shop.deliverable
                          ? t('shops.tooFar', { km: shop.distanceKm })
                          : hasBasket
                            ? t('shops.hasWholeBasket', {
                                total: shop.total,
                                km: shop.distanceKm,
                              })
                            : shop.address
                              ? t('shops.withAddress', { km: shop.distanceKm, address: shop.address })
                              : t('shops.distanceOnly', { km: shop.distanceKm })}
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
