import React, { useState, useEffect, useCallback } from 'react';
import { MapPin, LoaderCircle } from 'lucide-react';
import { currentPosition, savedCustomerCoords } from '../services/markets';

/** Remembers that we already asked, so this appears once rather than every visit. */
const PRIMER_KEY = 'vegdrop_location_primer';

export function primerAnswered() {
  try {
    return Boolean(localStorage.getItem(PRIMER_KEY));
  } catch {
    return false;
  }
}

/**
 * Ask why before asking for the permission.
 *
 * The browser's own dialog gives no reason and cannot be reopened: once someone
 * denies it, the app cannot prompt again, and every distance-based feature is
 * dead for that person until they find the setting themselves. So the expensive
 * question gets a cheap one in front of it — this card explains what location is
 * for, and only the explicit "Allow" ever reaches `getCurrentPosition`.
 *
 * Non-blocking on purpose. Declining leaves the whole catalog browsable; the
 * only thing lost is the ordering by distance.
 */
export default function LocationPrimer({ onLocated }) {
  const [visible, setVisible] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (savedCustomerCoords() || primerAnswered()) return;

    let cancelled = false;

    /**
     * Only worth showing while the browser would actually prompt. If permission
     * is already granted there is nothing to explain, and if it was denied the
     * prompt will never appear again, so a card promising otherwise would just
     * be a dead button.
     */
    async function decide() {
      let state = 'prompt';
      try {
        if (navigator.permissions?.query) {
          const status = await navigator.permissions.query({ name: 'geolocation' });
          state = status.state;
        }
      } catch {
        // Permissions API unsupported (older Safari): assume it would prompt.
      }
      if (cancelled) return;
      if (state === 'granted') {
        const found = await currentPosition();
        if (!cancelled && found) onLocated?.(found);
        return;
      }
      if (state === 'prompt') setVisible(true);
    }

    decide();
    return () => {
      cancelled = true;
    };
  }, [onLocated]);

  const remember = useCallback((answer) => {
    try {
      localStorage.setItem(PRIMER_KEY, answer);
    } catch {
      // Private mode with storage disabled: the card reappears next visit, which
      // is a nuisance rather than a fault.
    }
  }, []);

  const handleAllow = useCallback(async () => {
    setAsking(true);
    const found = await currentPosition();
    setAsking(false);
    remember(found ? 'granted' : 'denied');
    setVisible(false);
    if (found) {
      try {
        localStorage.setItem('vegdrop_customer_coords', JSON.stringify(found));
      } catch {
        // Non-fatal: the coordinates still reach this session through onLocated.
      }
      onLocated?.(found);
    }
  }, [onLocated, remember]);

  const handleDismiss = useCallback(() => {
    remember('declined');
    setVisible(false);
  }, [remember]);

  if (!visible) return null;

  return (
    <div className="mx-4 mt-4 rounded-2xl bg-white border border-gray-200 shadow-sm px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
          <MapPin className="w-4.5 h-4.5 text-emerald-600" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-bold text-gray-900">Show shops near you?</p>
          <p className="text-[12px] text-gray-500 mt-1 leading-relaxed">
            We use your location only to show the shops and markets that can deliver to you. It is
            never shared with anyone else.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-3.5">
        <button
          onClick={handleDismiss}
          className="flex-1 border border-gray-300 text-gray-600 rounded-xl py-2.5 text-[13px] font-bold"
        >
          Not now
        </button>
        <button
          onClick={handleAllow}
          disabled={asking}
          className="flex-1 bg-emerald-600 text-white rounded-xl py-2.5 text-[13px] font-bold flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {asking ? <LoaderCircle className="w-4 h-4 animate-spin" /> : null}
          Allow location
        </button>
      </div>
    </div>
  );
}
