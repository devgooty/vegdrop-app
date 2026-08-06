import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, LocateFixed, MapPin, Loader2, ShoppingBag, Store, Navigation, RefreshCw } from 'lucide-react';

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

export default function MapLocationPicker({ onClose, onConfirm, reverseGeocodeGPS }) {
  const defaultPosition = [20.5937, 78.9629];

  const [gpsPos, setGpsPos] = useState(null); // The actual GPS-pinned position
  const [flyToPos, setFlyToPos] = useState(null);
  const [isDetecting, setIsDetecting] = useState(false);
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

  const detectAndFetch = () => {
    if (!navigator.geolocation) {
      setGpsError(true);
      return;
    }
    setIsDetecting(true);
    setGpsError(false);
    setFormattedFullAddress('');
    setLocationDetails(null);
    setNearbyPlaces([]);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        const pos = { lat: latitude, lng: longitude };
        setGpsPos(pos);
        setFlyToPos(pos);
        try {
          const { formattedFullAddress, detailsObj } = await reverseGeocodeGPS(latitude, longitude);
          setFormattedFullAddress(formattedFullAddress);
          setLocationDetails(detailsObj);
          fetchNearbyPlaces(latitude, longitude);
        } catch (e) {
          setFormattedFullAddress('Could not fetch address.');
        }
        setIsDetecting(false);
        setHasInitialLoaded(true);
      },
      (err) => {
        setIsDetecting(false);
        setGpsError(true);
        setHasInitialLoaded(true);
        setGpsPos({ lat: defaultPosition[0], lng: defaultPosition[1] });
        setFlyToPos({ lat: defaultPosition[0], lng: defaultPosition[1] });
        setFormattedFullAddress('Location permission denied. Please enable GPS.');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  // Auto-detect on open
  useEffect(() => {
    detectAndFetch();
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

  return (
    <div className="fixed inset-0 bg-[#FFFDF9] z-[1000] flex flex-col animate-fade-in h-[100dvh] w-full">

      {/* FLOATING BACK BUTTON */}
      <div className="absolute top-6 left-4 z-[500]">
        <button
          onClick={onClose}
          className="bg-white p-3 rounded-full shadow-[0_4px_12px_rgba(0,0,0,0.15)] text-[#1B4D3E] hover:bg-gray-50 transition-colors shrink-0 cursor-pointer active:scale-95 border border-gray-100"
        >
          <ArrowLeft className="w-5 h-5 stroke-[2.5]" />
        </button>
      </div>

      {/* MAP - fixed view, no drag to change location */}
      <div className="relative flex-1 bg-gray-100">
        {hasInitialLoaded && gpsPos && (
          <MapContainer
            center={[mapCenter.lat, mapCenter.lng]}
            zoom={17}
            zoomControl={false}
            attributionControl={false}
            className="w-full h-full"
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <Marker position={[gpsPos.lat, gpsPos.lng]} icon={customerMarkerIcon} />
            <MapFlyTo position={flyToPos} />
          </MapContainer>
        )}

        {/* Loading overlay while detecting */}
        {isDetecting && (
          <div className="absolute inset-0 bg-white/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3 z-[400]">
            <div className="w-16 h-16 rounded-full bg-[#1B4D3E]/10 flex items-center justify-center animate-pulse">
              <LocateFixed className="w-8 h-8 text-[#1B4D3E]" />
            </div>
            <p className="text-sm font-bold text-[#1B4D3E]">Getting your exact location...</p>
            <p className="text-xs text-gray-500">Please allow GPS access if prompted</p>
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
              <span>Re-detect Location</span>
            </button>
          </div>
        )}

        {/* GPS Error state */}
        {gpsError && !isDetecting && (
          <div className="absolute bottom-20 left-4 right-4 z-[400] bg-red-50 border border-red-200 rounded-2xl p-3 text-xs text-red-700 font-semibold text-center">
            ⚠️ GPS access denied. Please enable location in your browser settings and tap Re-detect.
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
              <p className="text-[10px] font-extrabold text-[#1B4D3E] uppercase tracking-widest mb-0.5">Your Exact Location</p>
              <h3 className="font-extrabold text-base text-gray-900 line-clamp-1">
                {locationDetails?.mandal && locationDetails.mandal !== 'N/A'
                  ? locationDetails.mandal
                  : (locationDetails?.village && locationDetails.village !== 'N/A'
                    ? locationDetails.village
                    : (isDetecting ? '...' : 'Fetching...'))}
              </h3>
              <div className="text-gray-500 text-xs mt-0.5 leading-snug line-clamp-2 min-h-[28px]">
                {isDetecting ? (
                  <span className="flex items-center gap-1.5 text-[#1B4D3E] font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching exact address...
                  </span>
                ) : (
                  formattedFullAddress || 'Waiting for GPS...'
                )}
              </div>
            </div>
          </div>
        </div>

        {/* NEARBY MARKETS & SHOPS */}
        <div className="flex-1 overflow-y-auto px-5 pb-3 min-h-0">
          <div className="flex items-center gap-2 mb-2">
            <Store className="w-4 h-4 text-[#1B4D3E]" />
            <p className="text-[12px] font-extrabold text-gray-800 uppercase tracking-wider">Nearby Markets & Shops</p>
            {isLoadingNearby && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400 ml-auto" />}
          </div>

          {isLoadingNearby && nearbyPlaces.length === 0 && (
            <div className="flex flex-col items-center py-3 gap-2">
              <div className="flex gap-1.5">
                {[0, 1, 2].map(i => (
                  <div key={i} className="h-16 w-24 bg-gray-100 rounded-xl animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                ))}
              </div>
              <p className="text-[10px] text-gray-400 font-medium">Scanning for nearby markets...</p>
            </div>
          )}

          {!isLoadingNearby && !isDetecting && nearbyPlaces.length === 0 && locationDetails && (
            <div className="text-center py-4">
              <ShoppingBag className="w-8 h-8 text-gray-200 mx-auto mb-1" />
              <p className="text-[11px] text-gray-400 font-medium">No registered markets found nearby.<br />This area may not be mapped on OpenStreetMap yet.</p>
            </div>
          )}

          {nearbyPlaces.length > 0 && (
            <div className="flex gap-2.5 overflow-x-auto no-scrollbar pb-2">
              {nearbyPlaces.map(place => (
                <div key={place.id} className="flex-shrink-0 w-28 bg-[#F6F3EC] border border-[#E5DFD1] rounded-2xl p-2.5 flex flex-col gap-1">
                  <div className="text-lg leading-none">{place.type.split(' ')[0]}</div>
                  <p className="text-[11px] font-extrabold text-[#1B4D3E] line-clamp-2 leading-tight">{place.name}</p>
                  <p className="text-[9px] text-[#8A7E6B] font-semibold">{place.type.split(' ').slice(1).join(' ')}</p>
                  <div className="flex items-center gap-0.5 mt-auto">
                    <Navigation className="w-2.5 h-2.5 text-[#C8372D]" />
                    <span className="text-[9px] font-bold text-[#C8372D]">
                      {place.dist >= 1000 ? `${(place.dist / 1000).toFixed(1)}km` : `${place.dist}m`} away
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Verify/Edit Pincode field */}
        {!isDetecting && locationDetails && (
          <div className="px-5 pb-1">
            <label className="block text-[10px] font-extrabold text-[#1B4D3E] uppercase tracking-wider mb-1">Verify/Edit Pincode</label>
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
              placeholder="Enter correct 6-digit Pincode"
            />
          </div>
        )}

        {/* Confirm Button */}
        <div className="p-5 pt-3 pb-8">
          <button
            onClick={handleConfirm}
            disabled={isDetecting || !locationDetails}
            className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-bold py-3.5 px-4 rounded-xl flex items-center justify-center shadow-md transition-all cursor-pointer text-[15px] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed gap-2"
          >
            <MapPin className="w-4 h-4" />
            Confirm & Deliver Here
          </button>
        </div>
      </div>
    </div>
  );
}
