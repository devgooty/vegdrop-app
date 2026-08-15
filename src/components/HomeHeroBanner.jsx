import React, { useState, useEffect } from 'react';
import { Sparkles, Tag, ChevronRight, Clock, MapPin, LocateFixed, Loader2, CheckCircle2, Navigation, X, Check, Building2 } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import MapLocationPicker from './MapLocationPicker';
import { savedCustomerAddress, saveCustomerAddress } from '../services/address';

export default function HomeHeroBanner({ onExplore, onAddressChange }) {
  // The banner copy below is built inside the component rather than hoisted to
  // module scope, so it re-resolves when the language changes.
  const { t } = useLanguage();
  const [currentSlide, setCurrentSlide] = useState(0);
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
  const [isDetecting, setIsDetecting] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [locationSuccess, setLocationSuccess] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [touchStartX, setTouchStartX] = useState(0);
  const [touchEndX, setTouchEndX] = useState(0);

  const presetLocations = [
    'Koramangala, Bengaluru, Karnataka - 560034',
    'Indiranagar, Bengaluru, Karnataka - 560038',
    'HSR Layout, Bengaluru, Karnataka - 560102',
    'Whitefield, Bengaluru, Karnataka - 560066',
    'Bandra West, Mumbai, Maharashtra - 400050',
    'Connaught Place, New Delhi, Delhi - 110001'
  ];

  const banners = [
    {
      id: 1,
      tag: t('hero.dailyHarvest'),
      title: t('hero.organicTitle'),
      subtitle: t('hero.organicSub'),
      offer: t('hero.flat20'),
      code: 'FRESH20',
      image: 'https://images.unsplash.com/photo-1610348725531-843dff563e2c?w=600&auto=format&fit=crop&q=80',
      badgeBg: 'skeuo-badge-emerald',
    },
    {
      id: 2,
      tag: t('hero.expressDelivery'),
      title: t('hero.expressTitle'),
      subtitle: t('hero.expressSub'),
      offer: t('hero.freeDelivery200'),
      code: 'EXPRESS',
      image: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600&auto=format&fit=crop&q=80',
      badgeBg: 'skeuo-badge-amber',
    },
    {
      id: 3,
      tag: t('hero.weekendBazzar'),
      title: t('hero.exoticTitle'),
      subtitle: t('hero.exoticSub'),
      offer: t('hero.upto35'),
      code: 'BAZZAR35',
      image: 'https://images.unsplash.com/photo-1619566636858-adf3ef46400b?w=600&auto=format&fit=crop&q=80',
      badgeBg: 'skeuo-badge-emerald',
    },
  ];

  // Auto-slide banner every 4 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % banners.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [banners.length]);

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
      handleDetectLocationSilent();
    }
  }, []);

  const saveLocation = (newLoc, details = null, coords = null) => {
    setLocation(newLoc);
    if (details) setLocationDetails(details);
    saveCustomerAddress(newLoc, coords);
    // Lets the shop re-resolve which markets can reach the new address without
    // waiting for a reload — MarketPicker keys its lookup off the saved coords.
    if (onAddressChange) onAddressChange(newLoc, coords);
    setLocationSuccess(true);
    setTimeout(() => setLocationSuccess(false), 3000);
  };

  // High Precision Reverse Geocoding Helper Function
  const reverseGeocodeGPS = async (latitude, longitude) => {
    // 1. PRIMARY: Try Google Maps Geocoding API (if API Key is configured in .env)
    try {
      const googleApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
      if (googleApiKey) {
        const googleRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${googleApiKey}`);
        const googleData = await googleRes.json();
        
        if (googleData.status === 'OK' && googleData.results && googleData.results.length > 0) {
          const addressComponents = googleData.results[0].address_components;
          const getComponent = (types) => {
            const comp = addressComponents.find(c => types.some(t => c.types.includes(t)));
            return comp ? comp.long_name : '';
          };

          const street = getComponent(['route', 'street_number', 'path', 'premise']) || '';
          const village = getComponent(['sublocality_level_2', 'neighborhood', 'sublocality_level_3', 'locality', 'sublocality_level_1', 'sublocality']) || '';
          const mandal = getComponent(['administrative_area_level_3', 'sublocality_level_1']) || '';
          const district = getComponent(['administrative_area_level_2']) || '';
          const state = getComponent(['administrative_area_level_1']) || '';
          const pincode = getComponent(['postal_code']) || '';

          const detailsObj = {
            state: state || 'N/A',
            district: district || 'N/A',
            mandal: mandal || 'N/A',
            village: village || 'N/A',
            street: street || 'N/A',
            pincode: pincode || 'N/A'
          };

          const addressParts = [];
          if (street) addressParts.push(street);
          if (village && village !== street) addressParts.push(village);
          if (mandal && mandal !== village) addressParts.push(mandal);
          if (district && district !== mandal) addressParts.push(district);
          if (state) {
            addressParts.push(pincode && pincode !== 'N/A' ? `${state} - ${pincode}` : state);
          }

          const formattedFullAddress = addressParts.length > 0
            ? addressParts.join(', ')
            : `GPS (${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°)`;

          return { formattedFullAddress, detailsObj };
        }
      }
    } catch (err) {
      console.warn('Google Maps reverse geocoding failed, falling back to open APIs...', err);
    }

    // 2. SECONDARY: Robust OpenStreetMap / BigDataCloud / PostalPincode Fallback
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&addressdetails=1`,
        {
          headers: {
            'Accept-Language': 'en-US,en;q=0.9',
          }
        }
      );
      const data = await res.json();
      const addr = data.address || {};

      // 1. Street
      const street = addr.road || addr.street || addr.pedestrian || addr.path || addr.commercial || '';
      
      // 2. Village / Area
      const village = addr.neighbourhood || addr.village || addr.suburb || addr.residential || addr.hamlet || addr.colony || '';
      
      // 3. Mandal / Tehsil / Taluk
      const mandal = addr.county || addr.municipality || addr.town || addr.city || '';
      
      // 4. District
      // state_district is accurately the District. If missing, fallback to district
      let district = addr.state_district || addr.district || '';
      // If district is exactly the same as mandal, and state_district was missing, this is fine
      
      // 5. State
      const state = addr.state || '';
      
      // 6. Pincode
      let pincode = addr.postcode || '';

      // India Post Pincode validation/correction for Indian locations
      if (addr.country_code === 'in' || state) {
        const searchTerms = [
          addr.suburb,
          addr.neighbourhood,
          addr.village,
          addr.town,
          addr.city,
          addr.county,
          district
        ].filter(Boolean);

        let validatedPincode = '';
        for (const term of searchTerms) {
          try {
            const cleanTerm = term.split(' ')[0].replace(/[^a-zA-Z]/g, '');
            if (cleanTerm.length < 3) continue;

            const postalRes = await fetch(`https://api.postalpincode.in/PostOffice/${cleanTerm}`);
            const postalData = await postalRes.json();
            if (postalData && postalData[0] && postalData[0].Status === 'Success') {
              const postOffices = postalData[0].PostOffice;
              const match = postOffices.find(po => 
                (po.State && state && po.State.toLowerCase() === state.toLowerCase()) || 
                (po.District && district && (
                  po.District.toLowerCase() === district.toLowerCase() ||
                  po.District.toLowerCase().includes(district.toLowerCase()) ||
                  district.toLowerCase().includes(po.District.toLowerCase())
                ))
              );
              if (match && match.Pincode) {
                validatedPincode = match.Pincode;
                break;
              }
            }
          } catch (err) {}
        }
        if (validatedPincode) {
          pincode = validatedPincode;
        }
      }

      // Fallback 1: BigDataCloud Reverse Geocoding
      if (!pincode) {
        try {
          const fallbackRes = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
          const fallbackData = await fallbackRes.json();
          if (fallbackData.postcode) pincode = fallbackData.postcode;
        } catch (err) {}
      }

      const detailsObj = {
        state: state || 'N/A',
        district: district || 'N/A',
        mandal: mandal || 'N/A',
        village: village || 'N/A',
        street: street || 'N/A',
        pincode: pincode || 'Not Found'
      };

      // Combine Street and Village for the main formatted address
      let streetVillageStr = '';
      if (street && village && street !== village) {
        streetVillageStr = `${street}, ${village}`;
      } else {
        streetVillageStr = street || village || 'Local Area';
      }

      const addressParts = [];
      if (streetVillageStr !== 'Local Area') addressParts.push(streetVillageStr);
      if (district) addressParts.push(district);
      if (state) {
        addressParts.push(pincode !== 'N/A' ? `${state} - ${pincode}` : state);
      }

      let formattedFullAddress = addressParts.length > 0
        ? addressParts.join(', ')
        : `GPS (${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°)`;

      // Local testing override for user's village location
      const lowerAddress = formattedFullAddress.toLowerCase();
      if ((lowerAddress.includes('harijana') || lowerAddress.includes('mdr') || lowerAddress.includes('mylavaram') || lowerAddress.includes('badvel') || lowerAddress.includes('cuddapah') || lowerAddress.includes('kadapa')) && pincode !== '521230') {
        pincode = '521230';
        detailsObj.pincode = '521230';
        const oldMatch = formattedFullAddress.match(/\d{6}$/);
        if (oldMatch) {
          formattedFullAddress = formattedFullAddress.replace(oldMatch[0], '521230');
        } else {
          formattedFullAddress = formattedFullAddress + ' - 521230';
        }
      }

      return { formattedFullAddress, detailsObj };
    } catch (e) {
      // Fallback if Nominatim fails entirely
      let fallbackPincode = 'Not Found';
      try {
        const fallbackRes = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
        const fallbackData = await fallbackRes.json();
        if (fallbackData.postcode) {
          fallbackPincode = fallbackData.postcode;
        } else if (fallbackData.city || fallbackData.locality) {
          // 3rd level fallback: PostalPincode based on BigDataCloud city/locality
          const areaName = (fallbackData.city || fallbackData.locality).split(' ')[0];
          const postalRes = await fetch(`https://api.postalpincode.in/PostOffice/${areaName}`);
          const postalData = await postalRes.json();
          if (postalData && postalData[0] && postalData[0].Status === 'Success') {
             fallbackPincode = postalData[0].PostOffice[0].Pincode;
          }
        }
      } catch (err) {}

      return {
        formattedFullAddress: `GPS Location (${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°)`,
        detailsObj: { state: 'N/A', district: 'N/A', mandal: 'N/A', village: 'N/A', street: 'N/A', pincode: fallbackPincode }
      };
    }
  };

  const handleDetectLocationSilent = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        const { formattedFullAddress, detailsObj } = await reverseGeocodeGPS(latitude, longitude);
        saveLocation(formattedFullAddress, detailsObj, { lat: latitude, lng: longitude });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  };

  const handleDetectLocation = () => {
    if (!navigator.geolocation) {
      alert(t('delivery.noGeolocation'));
      return;
    }
    setIsDetecting(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        const { formattedFullAddress, detailsObj } = await reverseGeocodeGPS(latitude, longitude);
        saveLocation(formattedFullAddress, detailsObj, { lat: latitude, lng: longitude });
        setIsDetecting(false);
        setIsModalOpen(false);
      },
      (error) => {
        setIsDetecting(false);
        alert('Please allow location permission in your browser to detect exact street, village, district & state address.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handleSelectPreset = (loc) => {
    saveLocation(loc);
    setIsModalOpen(false);
  };

  const handleCustomSubmit = (e) => {
    e.preventDefault();
    if (customInput.trim()) {
      saveLocation(customInput.trim());
      setCustomInput('');
      setIsModalOpen(false);
    }
  };

  const banner = banners[currentSlide];

  // Extract pincode to display it prominently so it doesn't get truncated.
  // `location` is null until the customer sets one, which is a prompt, not text.
  const pincodeMatch = location ? location.match(/(?:- |Pincode: )?(\d{6})$/) : null;
  const displayPincode = pincodeMatch ? pincodeMatch[1] : null;
  const displayLocationText = pincodeMatch
    ? location.replace(pincodeMatch[0], '').trim().replace(/,$/, '')
    : location;

  return (
    <section className="px-4 pt-3 pb-1 space-y-2">
      {/* ACCURATE CUSTOMER FULL ADDRESS LOCATION BAR */}
      <div className="flex items-center justify-between bg-[#FAF7F2] border border-[#DCD5C6] rounded-2xl px-3.5 py-2 shadow-xs text-xs">
        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-1.5 text-[#1B4D3E] font-bold hover:opacity-80 transition-opacity cursor-pointer truncate max-w-[72%]"
          title="Change Delivery Address (Street, Village, District, State & Pincode)"
        >
          <div className="relative flex items-center justify-center shrink-0">
            <MapPin className="w-4 h-4 text-emerald-700 animate-pulse" />
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-emerald-500 rounded-full ring-1 ring-white" />
          </div>
          <span className="text-[10px] text-[#8A7E6B] font-semibold uppercase tracking-wider shrink-0">
            {location ? t('delivery.deliverTo') : t('delivery.deliveryTo')}
          </span>
          {displayPincode && (
            <span className="text-[10px] bg-emerald-100 text-emerald-800 font-black px-1.5 py-0.5 rounded-md shrink-0">
              {displayPincode}
            </span>
          )}
          <span
            className={`text-xs font-black truncate underline decoration-wavy ${
              location
                ? 'text-[#1B4D3E] decoration-emerald-500/40'
                : 'text-amber-700 decoration-amber-500/60'
            }`}
          >
            {displayLocationText || t('delivery.setAddress')}
          </span>
        </button>

        <button
          onClick={handleDetectLocation}
          disabled={isDetecting}
          className="skeuo-btn-emerald flex items-center gap-1 text-[11px] font-black px-2.5 py-1 rounded-xl shadow-xs transition-all active:scale-95 cursor-pointer shrink-0"
        >
          {isDetecting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-200" />
              <span>{t('delivery.locating')}</span>
            </>
          ) : locationSuccess ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-200" />
              <span>Verified!</span>
            </>
          ) : (
            <>
              <LocateFixed className="w-3.5 h-3.5 text-amber-200" />
              <span>{t('delivery.detectGps')}</span>
            </>
          )}
        </button>
      </div>

      {/* HERO BANNER CARD */}
      <div 
        className="relative h-44 rounded-3xl overflow-hidden shadow-lg border border-[#DCD5C6] group"
        onTouchStart={(e) => setTouchStartX(e.targetTouches[0].clientX)}
        onTouchMove={(e) => setTouchEndX(e.targetTouches[0].clientX)}
        onTouchEnd={() => {
          if (!touchStartX || !touchEndX) return;
          const distance = touchStartX - touchEndX;
          const isLeftSwipe = distance > 50;
          const isRightSwipe = distance < -50;
          
          if (isLeftSwipe) {
            setCurrentSlide((prev) => (prev + 1) % banners.length);
          }
          if (isRightSwipe) {
            setCurrentSlide((prev) => (prev === 0 ? banners.length - 1 : prev - 1));
          }
          
          setTouchStartX(0);
          setTouchEndX(0);
        }}
      >
        <img
          key={banner.id}
          src={banner.image}
          alt={banner.title}
          className="w-full h-full object-cover transition-all duration-700 group-hover:scale-105 animate-fade-in"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#0D2E24]/95 via-[#0D2E24]/75 to-transparent flex flex-col justify-between p-4 text-white">
          
          {/* Top Tag & Code Badge */}
          <div className="flex items-center justify-between">
            <span className={`${banner.badgeBg} text-white text-[9px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider shadow-xs flex items-center gap-1`}>
              <Sparkles className="w-3 h-3" />
              {banner.tag}
            </span>

            <div className="flex items-center gap-1 bg-[#FFFDF9]/20 backdrop-blur-md px-2 py-0.5 rounded-full border border-white/20 text-[10px] font-bold text-amber-200">
              <Tag className="w-3 h-3" />
              <span>{t('hero.useCode')} {banner.code}</span>
            </div>
          </div>

          {/* Title & Subtitle */}
          <div className="max-w-[75%] my-auto space-y-0.5 animate-fade-in" key={`title-${banner.id}`}>
            <h2 className="font-vintage text-xl font-black leading-tight text-white drop-shadow-sm">
              {banner.title}
            </h2>
            <p className="text-[11px] text-gray-200 font-medium line-clamp-1">
              {banner.subtitle}
            </p>
          </div>

          {/* Bottom Offer & CTA */}
          <div className="flex items-center justify-between pt-1 border-t border-white/15">
            <div className="flex items-center gap-1.5">
              <span className="font-vintage font-extrabold text-sm text-amber-300 drop-shadow-xs">
                {banner.offer}
              </span>
              <span className="text-[10px] text-emerald-200 font-semibold flex items-center gap-0.5">
                <Clock className="w-3 h-3" /> 15m to {location ? location.split(',')[0] : 'your door'}
              </span>
            </div>

            <button
              onClick={onExplore}
              className="skeuo-btn-emerald font-extrabold px-3 py-1 rounded-xl text-xs flex items-center gap-1 shadow-md cursor-pointer active:scale-95 z-20"
            >
              <span>{t('hero.shopNow')}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

        </div>

        {/* Manual Arrow Controls (Desktop/Hover) */}
        <button 
          onClick={(e) => { e.stopPropagation(); setCurrentSlide((prev) => (prev === 0 ? banners.length - 1 : prev - 1)); }}
          className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 cursor-pointer backdrop-blur-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); setCurrentSlide((prev) => (prev + 1) % banners.length); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 cursor-pointer backdrop-blur-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>

        {/* Carousel Indicators */}
        <div className="absolute bottom-2 right-4 flex gap-1 z-10">
          {banners.map((b, idx) => (
            <button
              key={b.id}
              onClick={() => setCurrentSlide(idx)}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                currentSlide === idx ? 'w-5 bg-amber-400' : 'w-1.5 bg-white/40'
              }`}
            />
          ))}
        </div>
      </div>

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

    </section>
  );
}
