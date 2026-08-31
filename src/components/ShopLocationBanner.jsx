import React, { useState, useCallback } from 'react';
import { MapPin, Check, LoaderCircle, AlertTriangle } from 'lucide-react';
import { saveShopLocation } from '../services/shops';
import { currentPosition } from '../services/markets';

/**
 * "Where is your shop?" — the one thing an independent shopkeeper has to give
 * us before customers can find them.
 *
 * Deliberately an inline strip that expands in place rather than a modal. The
 * KYC modal already opens unprompted on this screen, and two stacked modals on
 * first sign-in is a wall, not onboarding. This gates nothing either: the panel,
 * the catalog and the legacy order flow all work without a pin. The only
 * consequence of skipping is not being listed, which is what the copy says.
 *
 * Deliberately not the Leaflet map picker: that modal fixes its pin to the GPS
 * fix and forbids dragging it, so over a plain getCurrentPosition() it buys only
 * a reverse-geocoded string — at the cost of pulling the whole maps chunk into a
 * bundle that never loads it today. A shopkeeper knows their own address.
 */
export default function ShopLocationBanner({ shop, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(shop?.name || '');
  const [address, setAddress] = useState(shop?.address || '');
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleDetect = useCallback(async () => {
    setLocating(true);
    setError(null);
    const found = await currentPosition();
    setLocating(false);
    if (!found) {
      setError(
        'Could not read your location. Allow location for this site in your browser, then try again.'
      );
      return;
    }
    setCoords(found);
  }, []);

  const handleSave = useCallback(async () => {
    if (!coords) return;
    setSaving(true);
    setError(null);
    try {
      await saveShopLocation({ ...coords, name: name.trim(), address: address.trim() });
      onSaved?.();
    } catch (err) {
      setError(err.message || 'Could not save your shop location.');
    } finally {
      setSaving(false);
    }
  }, [coords, name, address, onSaved]);

  if (!expanded) {
    return (
      <div className="bg-[#0B7A37] text-white px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-xs font-medium leading-snug">
          Add your shop location so customers nearby can find you.
        </p>
        <button
          onClick={() => setExpanded(true)}
          className="shrink-0 bg-white text-[#0B7A37] text-xs font-bold px-3 py-1.5 rounded-lg"
        >
          Add location
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white border-b border-gray-200 px-4 py-4">
      <div className="flex items-start gap-2.5 mb-3">
        <MapPin className="w-4.5 h-4.5 text-[#0B7A37] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold text-gray-900">Where is your shop?</p>
          <p className="text-[13px] text-gray-500 mt-0.5 leading-relaxed">
            Customers within a few kilometres will see your shop and the items you list.
          </p>
        </div>
      </div>

      <label className="block text-[12.5px] font-bold text-gray-500 uppercase tracking-wide mb-1">
        Shop name
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Ravi Vegetables"
        maxLength={160}
        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-[15px] mb-3 focus:outline-none focus:border-[#0B7A37]"
      />

      <label className="block text-[12.5px] font-bold text-gray-500 uppercase tracking-wide mb-1">
        Shop address
      </label>
      <textarea
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Street, landmark, area"
        rows={2}
        maxLength={500}
        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-[15px] mb-3 resize-none focus:outline-none focus:border-[#0B7A37]"
      />

      <button
        onClick={handleDetect}
        disabled={locating}
        className="w-full flex items-center justify-center gap-2 border border-[#0B7A37] text-[#0B7A37] rounded-xl py-2.5 text-[14.5px] font-bold mb-3 disabled:opacity-60"
      >
        {locating ? (
          <>
            <LoaderCircle className="w-4 h-4 animate-spin" />
            Finding your shop…
          </>
        ) : coords ? (
          <>
            <Check className="w-4 h-4" strokeWidth={3} />
            Location captured — tap to redo
          </>
        ) : (
          <>
            <MapPin className="w-4 h-4" />
            Use my current location
          </>
        )}
      </button>

      {error && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 mb-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[13.5px] text-amber-900 leading-relaxed">{error}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setExpanded(false)}
          className="flex-1 border border-gray-300 text-gray-600 rounded-xl py-2.5 text-[14.5px] font-bold"
        >
          Later
        </button>
        <button
          onClick={handleSave}
          disabled={!coords || saving}
          className="flex-1 bg-[#0B7A37] text-white rounded-xl py-2.5 text-[14.5px] font-bold disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save shop location'}
        </button>
      </div>

      {/*
        Stated up front rather than discovered after saving: a shop only appears
        once the settlement account is verified, because nobody else vets an
        independent shop the way a market owner vets a stall.
      */}
      {shop && !shop.kycVerified && (
        <p className="text-[12.5px] text-gray-500 mt-3 leading-relaxed">
          Your shop appears to customers once your bank verification is complete.
        </p>
      )}
    </div>
  );
}
