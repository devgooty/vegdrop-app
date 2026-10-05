import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, LocateFixed, MapPin, Loader2, ShoppingBag, Store, Navigation, RefreshCw, Search } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

// Fix Leaflet default icon issue in React/Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Custom SVG pin — always renders reliably at the exact GPS point
const customerMarkerIcon = L.divIcon({
  className: '',
  html: `
    <div style="position:relative; display:flex; flex-direction:column; align-items:center;">
      <!-- Pulsing ring (CSS class on parent avoids style-tag stripping) -->
      <div style="
        position:absolute;
        top: -8px; left: -8px;
        width: 52px; height: 52px;
        border-radius: 50%;
        background: rgba(27,77,62,0.18);
        animation: vegpulse 1.8s ease-out infinite;
      "></div>
      <!-- Main pin SVG -->
      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44" fill="none">
        <ellipse cx="18" cy="41" rx="7" ry="3" fill="rgba(0,0,0,0.18)"/>
        <path d="M18 0C9.163 0 2 7.163 2 16c0 10.627 14.144 25.658 15.137 26.719a1.2 1.2 0 0 0 1.726 0C19.856 41.658 34 26.627 34 16 34 7.163 26.837 0 18 0z" fill="#1B4D3E"/>
        <circle cx="18" cy="16" r="7" fill="white"/>
        <circle cx="18" cy="16" r="4" fill="#1B4D3E"/>
      </svg>
    </div>
    <style>
      @keyframes vegpulse {
        0%   { transform: scale(0.6); opacity: 1; }
        100% { transform: scale(1.9); opacity: 0; }
      }
    </style>
  `,
  iconSize: [36, 44],
  iconAnchor: [18, 44],
  popupAnchor: [0, -44],
});


// Fly to position on map
function MapFlyTo({ position }) {
  const map = useMap();
  useEffect(() => {
    if (position) {
      map.flyTo([position.lat, position.lng], 17, { animate: true, duration: 1.2 });
    }
  }, [position, map]);
  return null;
}

// A tap anywhere on the map moves the pin there.
function TapToPin({ onPick }) {
  useMapEvents({
    click(event) {
      onPick(event.latlng.lat, event.latlng.lng, { fly: false });
    },
  });
  return null;
}

/**
 * `manual`: opened from "Select location manually" — start on search and the
 * map, not on GPS. Either way the pin can be searched for, tapped or dragged.
 */
export default function MapLocationPicker({ onClose, onConfirm, reverseGeocodeGPS, manual = false }) {
  const { t } = useLanguage();
  const defaultPosition = [20.5937, 78.9629];

  const [gpsPos, setGpsPos] = useState(null); // where the pin is: GPS, search, tap or drag
  const [flyToPos, setFlyToPos] = useState(null);
  const [isDetecting, setIsDetecting] = useState(false); // waiting on GPS
  const [isResolving, setIsResolving] = useState(false); // looking up the pin's address
  const [locationDetails, setLocationDetails] = useState(null);
  const [formattedFullAddress, setFormattedFullAddress] = useState('');
  const [nearbyPlaces, setNearbyPlaces] = useState([]);
  const [isLoadingNearby, setIsLoadingNearby] = useState(false);
  const [hasInitialLoaded, setHasInitialLoaded] = useState(false);
  const [gpsError, setGpsError] = useState(false);

  const fetchNearbyPlaces = async (lat, lng) => {
    setIsLoadingNearby(true);
    setNearbyPlaces([]);
    try {
      const query = `
        [out:json][timeout:15];
        (
          node["shop"~"greengrocer|supermarket|grocery|convenience|general|farm"](around:1500,${lat},${lng});
          node["amenity"~"marketplace|market"](around:1500,${lat},${lng});
          way["shop"~"greengrocer|supermarket|grocery|convenience|general"](around:1500,${lat},${lng});
          way["amenity"~"marketplace|market"](around:1500,${lat},${lng});
        );
        out center 15;
      `;
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!res.ok) {
        throw new Error(`Overpass API returned status: ${res.status}`);
      }
      const data = await res.json();

      const places = (data.elements || [])
        .map(el => {
          const placeLat = el.lat || el.center?.lat;
          const placeLng = el.lon || el.center?.lon;
          if (!placeLat || !placeLng) return null;

          const R = 6371000;
          const dLat = (placeLat - lat) * Math.PI / 180;
          const dLon = (placeLng - lng) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * Math.PI / 180) * Math.cos(placeLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
          const dist = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

          const tags = el.tags || {};
          const shopType = tags.shop || tags.amenity || 'store';
          const typeLabel = {
            greengrocer: '🥦 Vegetable Shop',
            supermarket: '🏬 Supermarket',
            grocery: '🛒 Grocery Store',
            convenience: '🏪 Convenience Store',
            marketplace: '🏟️ Market',
            market: '🏟️ Market',
            general: '🛒 General Store',
            farm: '🌾 Farm Store',
          }[shopType] || '🏪 Shop';

          return {
            id: el.id,
            name: tags.name || tags['name:en'] || typeLabel.split(' ').slice(1).join(' '),
            type: typeLabel,
            dist,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8);

      setNearbyPlaces(places);
    } catch (err) {
      console.warn('Nearby places fetch failed:', err);
    } finally {
      setIsLoadingNearby(false);
    }
  };

  /**
   * Put the pin somewhere and look up what is there — from GPS, a search
   * result, a tap on the map or a drag of the pin. Only the latest lookup may
   * land: a slow one for where the pin used to be must not overwrite the next.
   */
  const lookupSeq = useRef(0);
  const placePin = async (lat, lng, { fly = true } = {}) => {
    const seq = ++lookupSeq.current;
    const pos = { lat, lng };
    setGpsPos(pos);
    if (fly) setFlyToPos(pos);
    setHasInitialLoaded(true);
    setGpsError(false);
    setIsResolving(true);
    setFormattedFullAddress('');
    setLocationDetails(null);
    setNearbyPlaces([]);
    try {
      const { formattedFullAddress, detailsObj } = await reverseGeocodeGPS(lat, lng);
      if (seq !== lookupSeq.current) return;
      setFormattedFullAddress(formattedFullAddress);
      setLocationDetails(detailsObj);
      fetchNearbyPlaces(lat, lng);
    } catch {
      if (seq === lookupSeq.current) setFormattedFullAddress(t('map.addressFailed'));
    } finally {
      if (seq === lookupSeq.current) setIsResolving(false);
    }
  };

  const detectAndFetch = () => {
    if (!navigator.geolocation) {
      setGpsError(true);
      setHasInitialLoaded(true);
      return;
    }
    setIsDetecting(true);
    setGpsError(false);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsDetecting(false);
        placePin(position.coords.latitude, position.coords.longitude);
      },
      () => {
        setIsDetecting(false);
        setGpsError(true);
        setHasInitialLoaded(true);
        // No pin rather than one in the middle of the country at street zoom,
        // which read as "this is where you are". The map opens zoomed out so
        // the shopper can search or tap instead.
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  // GPS on open, unless the shopper chose to pick by hand — they came here
  // because location is off or refused, so asking again would only fail.
  useEffect(() => {
    if (manual) {
      setHasInitialLoaded(true);
      return;
    }
    detectAndFetch();
  }, []);

  /**
   * Find a place by name or pincode (OpenStreetMap's Nominatim — free, no key,
   * one request per submit rather than per keystroke, as its usage policy asks).
   */
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null); // null: no search yet
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

  const runSearch = async (event) => {
    event?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setIsSearching(true);
    setSearchError(false);
    try {
      const params = /^\d{6}$/.test(q)
        ? `postalcode=${q}&country=India`
        : `q=${encodeURIComponent(q)}&countrycodes=in`;
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&${params}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`search ${res.status}`);
      const data = await res.json();
      setResults(
        (Array.isArray(data) ? data : []).map((place) => ({
          id: place.place_id,
          name: place.display_name,
          lat: Number(place.lat),
          lng: Number(place.lon),
        }))
      );
    } catch {
      setSearchError(true);
      setResults(null);
    } finally {
      setIsSearching(false);
    }
  };

  const chooseResult = (place) => {
    setResults(null);
    setQuery('');
    placePin(place.lat, place.lng);
  };

  /**
   * Freeze the page underneath while the picker is up.
   *
   * Nothing here is scrollable except the nearby-shops strip, so a drag that
   * starts anywhere else reaches the shop behind and scrolls it — and the
   * header this picker is opened from collapses its address row once that
   * happens, taking the picker with it (see the portal below). Locking the
   * body means the gesture has nowhere to go in the first place.
   *
   * `position: fixed` pinned to a negative `top` rather than `overflow: hidden`,
   * and the forced re-measure before restoring the offset, for the reasons
   * spelled out at length on the same effect in CartModal.
   *
   * `overscroll-behavior` is the other half, and locking without it is why the
   * picker still bounced back to the home page on a phone after the portal
   * landed. Pinning the body stops the document SCROLLING; it does not stop the
   * browser's own over-scroll gesture. Nothing in this overlay is a scroll
   * container except the two strips below, so a vertical drag anywhere else —
   * the map's dead space, the address block, the gap beside the confirm button —
   * finds no scrollable ancestor and is handed to the root scroller as
   * over-scroll. At scroll offset zero on Android Chrome that IS pull-to-refresh:
   * the page reloads, the app boots at its default screen, and the shopper is
   * looking at the home page with the picker gone. It reads exactly like the
   * collapse the portal fixed, which is what made it look already solved.
   *
   * Set on `documentElement`, not on this overlay: the property only governs
   * elements that actually scroll, so putting it on a non-scrolling div does
   * nothing at all. The root scroller is the one being over-scrolled, so it is
   * the one that has to refuse.
   *
   * Nothing reproduces this on a desktop browser, and synthetic TouchEvents will
   * not either — pull-to-refresh and rubber-band are native compositor gestures.
   * Verify it on a real handset, not in device emulation.
   */
  useEffect(() => {
    const { body } = document;
    const root = document.documentElement;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
      overscroll: body.style.overscrollBehavior,
      rootOverscroll: root.style.overscrollBehavior,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    root.style.overscrollBehavior = 'none';

    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      body.style.overscrollBehavior = previous.overscroll;
      root.style.overscrollBehavior = previous.rootOverscroll;
      void body.offsetHeight;
      window.scrollTo(0, scrollY);
    };
  }, []);

  const handleConfirm = () => {
    if (locationDetails && formattedFullAddress) {
      /**
       * The GPS fix goes out with the address.
       *
       * It was held here and dropped: callers got a human-readable string and no
       * coordinates, so a customer who set their address through this picker had
       * nothing for the nearby-markets and nearby-shops queries to work from,
       * and the app silently re-prompted for location later.
       */
      onConfirm(formattedFullAddress, locationDetails, gpsPos);
    }
  };

  const mapCenter = gpsPos || { lat: defaultPosition[0], lng: defaultPosition[1] };

  /*
    Rendered into `document.body`, not where it is written.

    Both callers mount this inside the sticky header: DeliveryLocationBar lives
    in the address row, and that row is a `max-h-0 opacity-0 overflow-hidden`
    box the moment the shopper scrolls. A child of it is clipped to nothing and
    faded out — so opening the picker and then dragging the map collapsed the
    whole screen and left the shopper looking at the home page, with the picker
    still mounted and invisible behind it.

    `position: fixed` did not save it, and could not: the header carries
    `backdrop-filter` for its frosted tint, and a backdrop-filter other than
    `none` makes the element a containing block for fixed-position descendants,
    exactly as `transform` and `filter` do. So `inset-0` resolved against the
    header's box rather than the viewport. A portal is the fix for both faults
    at once, because it takes the overlay out of that subtree entirely.

    Anything full-screen opened from inside the header needs this. Do not
    "simplify" it back to a plain return.
  */
  return createPortal(
    <div className="fixed inset-0 bg-[#FFFDF9] z-[1000] flex flex-col animate-fade-in h-[100dvh] w-full">

      {/* FLOATING BACK BUTTON */}
      <div className="absolute top-[calc(1.5rem+env(safe-area-inset-top,0px))] left-4 right-4 z-[500] flex items-start gap-2">
        <button
          onClick={onClose}
          aria-label={t('common.back')}
          className="bg-white p-3 rounded-full shadow-[0_4px_12px_rgba(0,0,0,0.15)] text-[#1B4D3E] hover:bg-gray-50 transition-colors shrink-0 cursor-pointer active:scale-95 border border-gray-100"
        >
          <ArrowLeft className="w-5 h-5 stroke-[2.5]" />
        </button>

        {/* SEARCH — the way to set an address with location off */}
        <div className="flex-1 min-w-0">
          <form
            onSubmit={runSearch}
            className="flex items-center bg-white rounded-full shadow-[0_4px_12px_rgba(0,0,0,0.15)] border border-gray-100 pl-4 pr-1.5 h-[46px]"
          >
            <input
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchError(false);
              }}
              placeholder={t('map.searchPlaceholder')}
              className="flex-1 min-w-0 bg-transparent text-[14px] text-gray-900 placeholder:text-gray-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={isSearching || !query.trim()}
              aria-label={t('map.searchPlaceholder')}
              className="w-9 h-9 rounded-full bg-[#1B4D3E] text-white flex items-center justify-center shrink-0 disabled:opacity-50 cursor-pointer"
            >
              {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </button>
          </form>

          {(searchError || results) && (
            <div className="mt-2 bg-white rounded-2xl shadow-[0_8px_24px_rgba(0,0,0,0.15)] border border-gray-100 overflow-hidden max-h-[40vh] overflow-y-auto overscroll-contain">
              {searchError && <p className="px-4 py-3 text-[13px] text-red-700">{t('map.searchFailed')}</p>}
              {results && results.length === 0 && (
                <p className="px-4 py-3 text-[13px] text-gray-500">{t('map.searchNone')}</p>
              )}
              {results?.map((place) => (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => chooseResult(place)}
                  className="w-full text-left px-4 py-2.5 border-b last:border-b-0 border-gray-100 flex items-start gap-2 active:bg-gray-50 cursor-pointer"
                >
                  <MapPin className="w-4 h-4 text-[#1B4D3E] shrink-0 mt-0.5" />
                  <span className="text-[13px] text-gray-800 leading-snug line-clamp-2">{place.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MAP — tap it, or drag the pin, to move where the order goes */}
      <div className="relative flex-1 bg-gray-100">
        {hasInitialLoaded && (
          <MapContainer
            center={[mapCenter.lat, mapCenter.lng]}
            // Zoomed out to the country until there is a pin to look at.
            zoom={gpsPos ? 17 : 5}
            zoomControl={false}
            attributionControl={false}
            className="w-full h-full"
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {gpsPos && (
              <Marker
                position={[gpsPos.lat, gpsPos.lng]}
                icon={customerMarkerIcon}
                draggable
                eventHandlers={{
                  dragend: (event) => {
                    const { lat, lng } = event.target.getLatLng();
                    placePin(lat, lng, { fly: false });
                  },
                }}
              />
            )}
            <TapToPin onPick={placePin} />
            <MapFlyTo position={flyToPos} />
          </MapContainer>
        )}

        {/* Loading overlay while detecting */}
        {isDetecting && (
          <div className="absolute inset-0 bg-white/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3 z-[400]">
            <div className="w-16 h-16 rounded-full bg-[#1B4D3E]/10 flex items-center justify-center animate-pulse">
              <LocateFixed className="w-8 h-8 text-[#1B4D3E]" />
            </div>
            <p className="text-sm font-bold text-[#1B4D3E]">{t('map.detecting')}</p>
            <p className="text-xs text-gray-500">{t('map.allowGps')}</p>
          </div>
        )}

        {/* Re-detect FAB */}
        {!isDetecting && (
          <div className="absolute bottom-5 right-4 z-[400]">
            <button
              onClick={detectAndFetch}
              className="bg-white px-4 py-3 rounded-full shadow-lg border border-gray-100 flex items-center gap-2 text-[#2D2A26] font-bold text-sm hover:bg-gray-50 active:scale-95 transition-transform cursor-pointer"
            >
              <RefreshCw className="w-4 h-4 text-[#1B4D3E]" />
              <span>{t('map.redetect')}</span>
            </button>
          </div>
        )}

        {/* GPS failed and there is no pin yet. How to place one by hand is
            said in the sheet below. */}
        {gpsError && !gpsPos && !isDetecting && (
          <div className="absolute bottom-20 left-4 right-4 z-[400] bg-red-50 border border-red-200 rounded-2xl p-3 text-xs text-red-700 font-semibold text-center pointer-events-none">
            {t('map.gpsDenied')}
          </div>
        )}
      </div>

      {/* BOTTOM SHEET */}
      <div className="bg-white rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.08)] z-[500] relative border-t border-gray-100 flex flex-col max-h-[55vh]">

        {/* Address section */}
        <div className="p-5 pb-3">
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4"></div>

          <div className="flex gap-3 items-start mb-4">
            <div className="mt-0.5 shrink-0 w-10 h-10 rounded-full bg-[#1B4D3E]/10 flex items-center justify-center">
              <MapPin className="w-5 h-5 text-[#1B4D3E]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11.5px] font-extrabold text-[#1B4D3E] uppercase tracking-widest mb-0.5">{t('map.exactLocation')}</p>
              <h3 className="font-extrabold text-base text-gray-900 line-clamp-1">
                {locationDetails?.mandal && locationDetails.mandal !== 'N/A'
                  ? locationDetails.mandal
                  : (locationDetails?.village && locationDetails.village !== 'N/A'
                    ? locationDetails.village
                    : (isDetecting || isResolving ? '...' : gpsPos ? t('map.fetching') : t('delivery.setAddress')))}
              </h3>
              <div className="text-gray-500 text-xs mt-0.5 leading-snug line-clamp-2 min-h-[28px]">
                {isDetecting || isResolving ? (
                  <span className="flex items-center gap-1.5 text-[#1B4D3E] font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('map.fetchingAddress')}
                  </span>
                ) : (
                  formattedFullAddress || (gpsPos ? t('map.waitingGps') : t('map.tapToPin'))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* NEARBY MARKETS & SHOPS */}
        {/* `overscroll-contain`: reaching the end of this list must not hand
            the rest of the gesture to the document behind, which is the
            over-scroll that pull-to-refresh is triggered by. Same reason it is
            on the strip below, and on the three other scrollers in the app. */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-3 min-h-0">
          <div className="flex items-center gap-2 mb-2">
            <Store className="w-4 h-4 text-[#1B4D3E]" />
            <p className="text-[13.5px] font-extrabold text-gray-800 uppercase tracking-wider">{t('map.nearbyTitle')}</p>
            {isLoadingNearby && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400 ml-auto" />}
          </div>

          {isLoadingNearby && nearbyPlaces.length === 0 && (
            <div className="flex flex-col items-center py-3 gap-2">
              <div className="flex gap-1.5">
                {[0, 1, 2].map(i => (
                  <div key={i} className="h-16 w-24 bg-gray-100 rounded-xl animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                ))}
              </div>
              <p className="text-[11.5px] text-gray-400 font-medium">{t('map.scanning')}</p>
            </div>
          )}

          {!isLoadingNearby && !isDetecting && !isResolving && nearbyPlaces.length === 0 && locationDetails && (
            <div className="text-center py-4">
              <ShoppingBag className="w-8 h-8 text-gray-200 mx-auto mb-1" />
              <p className="text-[12.5px] text-gray-400 font-medium">
                {t('map.noneNearby')}<br />{t('map.noneNearbyHint')}
              </p>
            </div>
          )}

          {nearbyPlaces.length > 0 && (
            <div className="flex gap-2.5 overflow-x-auto overscroll-contain no-scrollbar pb-2">
              {nearbyPlaces.map(place => (
                <div key={place.id} className="flex-shrink-0 w-28 bg-[#F6F3EC] border border-[#E5DFD1] rounded-2xl p-2.5 flex flex-col gap-1">
                  <div className="text-lg leading-none">{place.type.split(' ')[0]}</div>
                  <p className="text-[12.5px] font-extrabold text-[#1B4D3E] line-clamp-2 leading-tight">{place.name}</p>
                  <p className="text-[10.5px] text-[#8A7E6B] font-semibold">{place.type.split(' ').slice(1).join(' ')}</p>
                  <div className="flex items-center gap-0.5 mt-auto">
                    <Navigation className="w-2.5 h-2.5 text-[#C8372D]" />
                    <span className="text-[10.5px] font-bold text-[#C8372D]">
                      {t('map.distanceAway', {
                        distance:
                          place.dist >= 1000
                            ? `${(place.dist / 1000).toFixed(1)}km`
                            : `${place.dist}m`,
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Verify/Edit Pincode field */}
        {!isDetecting && !isResolving && locationDetails && (
          <div className="px-5 pb-1">
            <label className="block text-[11.5px] font-extrabold text-[#1B4D3E] uppercase tracking-wider mb-1">{t('map.pincodeLabel')}</label>
            <input
              type="text"
              maxLength={6}
              value={locationDetails.pincode === 'Not Found' || locationDetails.pincode === 'N/A' ? '' : (locationDetails.pincode || '')}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '');
                const oldPin = locationDetails.pincode;
                setLocationDetails(prev => ({ ...prev, pincode: val }));
                if (oldPin && formattedFullAddress.includes(oldPin)) {
                  setFormattedFullAddress(prev => prev.replace(oldPin, val));
                } else {
                  setFormattedFullAddress(prev => {
                    const match = prev.match(/\d{6}$/);
                    if (match) {
                      return prev.replace(match[0], val);
                    }
                    return prev + ' - ' + val;
                  });
                }
              }}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-mono font-bold text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
              placeholder={t('map.pincodePlaceholder')}
            />
          </div>
        )}

        {/* Confirm Button */}
        <div className="p-5 pt-3 pb-8">
          <button
            onClick={handleConfirm}
            disabled={isDetecting || isResolving || !locationDetails}
            className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-bold py-3.5 px-4 rounded-xl flex items-center justify-center shadow-md transition-all cursor-pointer text-[16.5px] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed gap-2"
          >
            <MapPin className="w-4 h-4" />
            {t('map.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
