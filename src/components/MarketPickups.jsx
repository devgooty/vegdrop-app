import React, { useState, useEffect, useCallback } from 'react';
import {
  Store, MapPin, Navigation, Check, Package, Clock, X, PackageCheck, Phone,
} from 'lucide-react';
import { useToast } from './Toast';
import {
  fetchRiderOrders, acceptPickup, declinePickup, collectFromStall, markDelivered,
} from '../services/rider';

/**
 * Market pickups.
 *
 * A market order is not one address — it is a market, and several numbered
 * stalls inside it. This shows the round in walking order and lets the rider
 * tick each stall off; ticking the last one is what sends the order out for
 * delivery, so there is no separate "I'm leaving" step to forget.
 *
 * Offers arrive here one at a time, nearest rider first. Declining passes it
 * straight to the next rider rather than letting it sit.
 */
export default function MarketPickups({ isOnline }) {
  const toast = useToast();

  const [offers, setOffers] = useState([]);
  const [assigned, setAssigned] = useState([]);
  const [busy, setBusy] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchRiderOrders();
      setOffers(data.offers);
      setAssigned(data.assigned);
    } catch {
      /* Transient; the next tick retries. */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const poll = () => {
      if (!document.hidden) refresh();
    };
    const interval = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refresh]);

  const run = async (id, action, successMessage) => {
    setBusy(id);
    try {
      await action();
      if (successMessage) toast.success(successMessage);
      await refresh();
    } catch (err) {
      toast.error(
        err.code === 'OFFER_GONE'
          ? 'Another rider took that one.'
          : err.message || 'That did not work.'
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  // Nothing to show and nothing pending: stay out of the way entirely.
  if (loaded && offers.length === 0 && assigned.length === 0) {
    if (!isOnline) return null;
    return (
      <div className="mx-4 mb-4 rounded-2xl border border-dashed border-gray-300 bg-white px-5 py-6 text-center">
        <Store className="w-6 h-6 text-gray-400 mx-auto mb-2" />
        <p className="text-[13.5px] font-bold text-gray-900">No market pickups right now</p>
        <p className="text-[12px] text-gray-500 mt-1">
          You will be offered the nearest one as soon as a market has an order ready.
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 mb-4 space-y-3">
      {offers.map((order) => (
        <article
          key={order.id}
          className="rounded-2xl border-2 border-emerald-500 bg-white shadow-lg overflow-hidden"
        >
          <div className="bg-emerald-500 px-4 py-2 flex items-center justify-between">
            <span className="text-[12px] font-extrabold text-white uppercase tracking-wide">
              New pickup
            </span>
            <span className="text-[12px] font-bold text-white">{order.orderNumber}</span>
          </div>

          <div className="p-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <Store className="w-4.5 h-4.5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[14px] font-bold text-gray-900">{order.marketName}</p>
                <p className="text-[12px] text-gray-500">{order.marketAddress}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {order.pickups.map((p) => (
                <span
                  key={p.stall}
                  className="text-[11.5px] font-bold bg-gray-100 text-gray-800 px-2.5 py-1 rounded-lg"
                >
                  Stall {p.stallNumber}
                </span>
              ))}
            </div>

            <div className="flex items-start gap-2.5 pt-1 border-t border-gray-100">
              <MapPin className="w-4.5 h-4.5 text-orange-500 shrink-0 mt-1.5" />
              <p className="text-[12.5px] text-gray-700 pt-1 leading-snug">{order.address}</p>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => run(order.id, () => declinePickup(order.id), 'Passed to the next rider')}
                disabled={busy === order.id}
                className="px-4 py-3 rounded-xl border border-gray-300 text-gray-600 text-[13.5px] font-bold disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
              <button
                onClick={() => run(order.id, () => acceptPickup(order.id), 'Pickup accepted 🚴')}
                disabled={busy === order.id}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[14px] font-bold py-3 rounded-xl transition active:translate-y-px disabled:opacity-50"
              >
                {busy === order.id ? 'Working…' : 'Accept pickup'}
              </button>
            </div>
          </div>
        </article>
      ))}

      {assigned.map((order) => {
        const remaining = order.pickups.filter((p) => !p.collected);
        const readyToLeave = order.status === 'dispatched';

        return (
          <article key={order.id} className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-[13.5px] font-bold text-gray-900 truncate">{order.marketName}</p>
                <p className="text-[11.5px] text-gray-500">{order.orderNumber}</p>
              </div>
              <span className="text-[11px] font-bold bg-gray-100 text-gray-700 px-2.5 py-1 rounded-full shrink-0">
                {readyToLeave ? 'On the way' : `${remaining.length} stall${remaining.length === 1 ? '' : 's'} left`}
              </span>
            </div>

            {!readyToLeave && (
              <ul className="divide-y divide-gray-100">
                {order.pickups.map((pickup) => {
                  const packed = pickup.lines.every((l) => l.packedAt);
                  return (
                    <li key={pickup.stall} className="px-4 py-3 flex items-center gap-3">
                      <span
                        className={`w-9 h-9 rounded-xl flex items-center justify-center text-[12px] font-extrabold shrink-0 ${
                          pickup.collected
                            ? 'bg-emerald-100 text-emerald-700'
                            : packed
                              ? 'bg-gray-900 text-white'
                              : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {pickup.stallNumber}
                      </span>

                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-gray-900 truncate">
                          {pickup.lines.map((l) => `${l.name} ×${l.quantity}`).join(', ')}
                        </p>
                        {!packed && !pickup.collected && (
                          <p className="text-[11.5px] text-amber-600 flex items-center gap-1 mt-0.5">
                            <Clock className="w-3 h-3" /> still packing
                          </p>
                        )}
                      </div>

                      {pickup.collected ? (
                        <Check className="w-5 h-5 text-emerald-600 shrink-0" strokeWidth={3} />
                      ) : (
                        <button
                          onClick={() =>
                            run(
                              order.id,
                              () => collectFromStall(order.id, pickup.stall),
                              `Collected from stall ${pickup.stallNumber}`
                            )
                          }
                          disabled={!packed || busy === order.id}
                          className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-[12px] font-bold shrink-0 disabled:bg-gray-200 disabled:text-gray-400"
                        >
                          <Package className="w-4 h-4" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="p-3 bg-gray-50 space-y-2">
              <div className="flex items-start gap-2 px-1">
                <MapPin className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
                <p className="text-[12.5px] text-gray-700 leading-snug flex-1">{order.address}</p>
              </div>

              <div className="flex gap-2">
                {order.phone && (
                  <a
                    href={`tel:${order.phone}`}
                    className="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 flex items-center justify-center"
                    aria-label="Call the customer"
                  >
                    <Phone className="w-4 h-4" />
                  </a>
                )}
                {order.deliveryLat != null && (
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${order.deliveryLat},${order.deliveryLng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 flex items-center justify-center"
                    aria-label="Navigate"
                  >
                    <Navigation className="w-4 h-4" />
                  </a>
                )}
                <button
                  onClick={() => run(order.id, () => markDelivered(order.id), 'Delivered ✅')}
                  disabled={!readyToLeave || busy === order.id}
                  className="flex-1 bg-gray-900 hover:bg-black text-white text-[14px] font-bold py-3 rounded-xl transition active:translate-y-px disabled:bg-gray-200 disabled:text-gray-400"
                >
                  <span className="flex items-center justify-center gap-2">
                    <PackageCheck className="w-4 h-4" />
                    {readyToLeave ? 'Mark delivered' : 'Collect everything first'}
                  </span>
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
