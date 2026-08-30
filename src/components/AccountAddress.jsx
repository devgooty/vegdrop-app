import React, { useState } from 'react';
import { MapPin, Trash2, Navigation } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { savedCustomerAddress, saveCustomerAddress, clearCustomerAddress } from '../services/address';
import { reverseGeocodeGPS } from '../services/geocode';
import MapLocationPicker from './MapLocationPicker';

/**
 * The "Saved Address" screen in the Account tab.
 *
 * There is one delivery address per customer, not an address book — see
 * services/address.js for why a fabricated default was worse than none. This
 * screen is a second door onto that same value (the first is the bar atop the
 * home tab), so it reads and writes through the identical service and picker
 * rather than keeping a state of its own.
 */
export default function AccountAddress({ onAddressChange }) {
  const { t } = useLanguage();
  const [address, setAddress] = useState(() => savedCustomerAddress());
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const handleConfirm = (newAddress, _details, coords) => {
    saveCustomerAddress(newAddress, coords);
    setAddress(newAddress);
    setIsPickerOpen(false);
    if (onAddressChange) onAddressChange(newAddress, coords);
  };

  const handleRemove = () => {
    clearCustomerAddress();
    setAddress(null);
    if (onAddressChange) onAddressChange(null, null);
  };

  return (
    <div className="space-y-4 text-left animate-fade-in w-full max-w-md mx-auto">
      <div className="bg-white/90 backdrop-blur-sm rounded-[2rem] p-5 border border-white/50 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 shrink-0 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 text-emerald-600 flex items-center justify-center shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(16,185,129,0.1)]">
            <MapPin className="w-5 h-5 drop-shadow-sm" />
          </div>
          <div className="flex-1 min-w-0">
            {address ? (
              <p className="font-bold text-slate-800 text-sm leading-snug break-words">{address}</p>
            ) : (
              <p className="font-bold text-amber-700 text-sm leading-snug">{t('delivery.setAddress')}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5 mt-4">
          <button
            onClick={() => setIsPickerOpen(true)}
            className="flex-1 skeuo-btn-emerald flex items-center justify-center gap-1.5 text-xs font-black px-3 py-2.5 rounded-2xl shadow-xs transition-all active:scale-95 cursor-pointer"
          >
            <Navigation className="w-3.5 h-3.5" />
            {address ? t('account.changeAddress') : t('delivery.setAddress')}
          </button>
          {address && (
            <button
              onClick={handleRemove}
              className="flex items-center justify-center gap-1.5 text-xs font-black px-3 py-2.5 rounded-2xl bg-red-50 text-red-600 border border-red-100 transition-all active:scale-95 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('account.removeAddress')}
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] font-semibold text-slate-400 leading-relaxed px-2">
        {t('account.savedAddressNote')}
      </p>

      {isPickerOpen && (
        <MapLocationPicker
          onClose={() => setIsPickerOpen(false)}
          onConfirm={handleConfirm}
          reverseGeocodeGPS={reverseGeocodeGPS}
        />
      )}
    </div>
  );
}
