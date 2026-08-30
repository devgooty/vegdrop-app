import React, { useState, useEffect } from 'react';
import { MapPin, ChevronDown } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import MapLocationPicker from './MapLocationPicker';
import { savedCustomerAddress, saveCustomerAddress } from '../services/address';
import { reverseGeocodeGPS } from '../services/geocode';

/**
 * The "DELIVERY TO" text, and everything that keeps it current.
 *
 * Lifted out of HomeHeroBanner so the header can render it above the search
 * bar instead of the carousel scrolling it away with the rest of the home
 * content — the address a shopper is buying for belongs in the part of the
 * screen that never leaves, the same reasoning that keeps the wallet balance
 * there. The carousel itself has no opinion about where the customer is, so
 * it stayed behind in HomeHeroBanner.
 *
 * Renders as plain text on the header's own background rather than as a
 * bordered pill — a quick "Detect GPS" shortcut used to sit beside it, but
 * MapLocationPicker (opened by tapping the address) already offers GPS
 * detection, so the shortcut was a second control for the same action.
 */
export default function DeliveryLocationBar({ onAddressChange }) {
  const { t } = useLanguage();
  /**
   * Null until the customer has actually told us where they are.
   *
   * This used to fall back to a hardcoded Bengaluru address, so someone who had
   * never entered one saw "Deliver to: Koramangala … 560034" in the header while
   * MarketPicker — which needs coordinates, and had none — said "Set your
   * delivery address" directly below it. The two are now the same fact.
   */
  const [location, setLocation] = useState(() => {
    let saved = savedCustomerAddress();
    if (saved && (saved.includes('516439') || saved.includes('516227'))) {
      saved = saved.replace(/516439|516227/g, '521230');
      saveCustomerAddress(saved);
    }
    return saved;
  });
  const [locationDetails, setLocationDetails] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  /**
   * Attempt automatic high precision GPS detection on mount if not saved.
   *
   * Gated on the primer having been answered. This used to fire unconditionally,
   * which meant the browser's permission dialog appeared with no explanation of
   * what it was for — and a denial there is permanent, so a badly-timed prompt
   * costs every distance-based feature for good. LocationPrimer asks first; this
   * only tops up the address afterwards.
   */
  useEffect(() => {
    const saved = savedCustomerAddress();
    const primerAnswered = localStorage.getItem('vegdrop_location_primer');
    if (primerAnswered && (!saved || saved.includes('516439')) && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          const { formattedFullAddress, detailsObj } = await reverseGeocodeGPS(latitude, longitude);
          saveLocation(formattedFullAddress, detailsObj, { lat: latitude, lng: longitude });
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveLocation = (newLoc, details = null, coords = null) => {
    setLocation(newLoc);
    if (details) setLocationDetails(details);
    saveCustomerAddress(newLoc, coords);
    // Lets the shop re-resolve which markets can reach the new address without
    // waiting for a reload — MarketPicker keys its lookup off the saved coords.
    if (onAddressChange) onAddressChange(newLoc, coords);
  };

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="flex items-start gap-2 hover:opacity-80 transition-opacity cursor-pointer min-w-0 text-left"
        title={t('delivery.changeAddressTitle')}
      >
        <div className="relative flex items-center justify-center shrink-0 mt-0.5">
          <MapPin className="w-4 h-4 text-emerald-700 animate-pulse" />
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-emerald-500 rounded-full ring-1 ring-white" />
        </div>
        <div className="min-w-0">
          {/* Bold and dark, like a heading — the address itself sits underneath
              in a lighter weight, the same split the reference screenshot uses
              between a place name and its full address. */}
          <span className="flex items-center gap-1 text-sm font-extrabold text-[#1A1A1A] leading-tight">
            {location ? t('delivery.deliverTo') : t('delivery.deliveryTo')}
            <ChevronDown className="w-3.5 h-3.5 text-[#1A1A1A]/70 shrink-0" />
          </span>
          <span className="block text-xs font-normal text-[#9A958A] truncate leading-tight mt-0.5">
            {location || t('delivery.setAddress')}
          </span>
        </div>
      </button>

      {/* DETAILED FULL ADDRESS LOCATION SELECTOR MODAL */}
      {isModalOpen && (
        <MapLocationPicker
          onClose={() => setIsModalOpen(false)}
          onConfirm={(address, details, coords) => {
            // `coords` is the picker's GPS fix. Without it this path saved an
            // address with no coordinates, and everything distance-based had to
            // ask the browser all over again.
            saveLocation(address, details, coords);
            setIsModalOpen(false);
          }}
          reverseGeocodeGPS={reverseGeocodeGPS}
        />
      )}
    </>
  );
}
