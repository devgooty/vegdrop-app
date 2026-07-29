import React, { useState, useEffect, useRef } from 'react';
import {
  Truck, CheckCircle2, Clock, MapPin, Phone, Navigation, DollarSign,
  LogOut, User, Zap, Home, Map as MapIcon, Wallet, ArrowLeft, Check, Camera, MessageSquare, PackageCheck, Bell, X
} from 'lucide-react';

export default function DeliveryPanel({ user, orders, onUpdateOrderStatus, onLogout, notifications = [], onClearNotification }) {
  // Navigation & State
  const [activeTab, setActiveTab] = useState('home');
  const [isOnline, setIsOnline] = useState(false);
  const [acceptedOrders, setAcceptedOrders] = useState([]);
  const [trackingOrder, setTrackingOrder] = useState(null); // order being tracked on map
  const [agentCoords, setAgentCoords] = useState(null);     // live GPS of delivery agent
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const navigationMapRef = useRef(null);
  const navigationMapInstanceRef = useRef(null);
  const watchIdRef = useRef(null);
  const roadRouteRef = useRef(null); // stores OSRM real road coordinates array
  const agentMarkerRef = useRef(null); // reference to map tab bike marker
  const navAgentMarkerRef = useRef(null); // reference to nav screen bike marker
  
  // Deep Dive State
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [activeScreen, setActiveScreen] = useState('list'); // 'list', 'request', 'pickup', 'navigation', 'confirmation'
  const [otpInput, setOtpInput] = useState('');

  // Live GPS Simulation State
  const [isSimulatingGPS, setIsSimulatingGPS] = useState(true);
  const [simulatedProgress, setSimulatedProgress] = useState(0.15); // 0 to 1 along route

  // Derived Stats
  const completedDeliveriesCount = orders.filter((o) => o.status === 'Delivered').length;
  const totalEarnings = completedDeliveriesCount * 45; // ₹45 per delivery

  // Helpers
  const handleAcceptOrder = (order) => {
    setAcceptedOrders(prev => [...prev, order.id]);
    if (onClearNotification) onClearNotification(order.id); // dismiss notification
    setSelectedOrder(null);
    setActiveScreen('list');
    setActiveTab('orders');
  };

  // Start/stop watching agent GPS when going online/offline
  useEffect(() => {
    if (isOnline && navigator.geolocation) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => setAgentCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    } else {
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    }
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, [isOnline]);

  // Automatically simulate live GPS movement along route
  useEffect(() => {
    if ((activeScreen !== 'navigation' && activeTab !== 'map') || !isSimulatingGPS) return;
    const interval = setInterval(() => {
      setSimulatedProgress((prev) => {
        if (prev >= 0.95) return 0.05; // loop simulation
        return prev + 0.02;
      });
    }, 1200);
    return () => clearInterval(interval);
  }, [activeScreen, activeTab, isSimulatingGPS]);

  // Build Leaflet map when map tab opens or tracking order changes
  useEffect(() => {
    if (activeTab !== 'map' || !mapContainerRef.current) return;
    if (!window.L) return; // Leaflet not loaded

    // Destroy previous map
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const storeCoords = { lat: 12.9716, lng: 77.5946 };
    const customerCoords = trackingOrder?.deliveryCoords || selectedOrder?.deliveryCoords || { lat: 12.9352, lng: 77.6245 };
    const currentLat = storeCoords.lat + (customerCoords.lat - storeCoords.lat) * simulatedProgress;
    const currentLng = storeCoords.lng + (customerCoords.lng - storeCoords.lng) * simulatedProgress;

    const map = window.L.map(mapContainerRef.current, { attributionControl: false }).setView([currentLat, currentLng], 14);
    mapInstanceRef.current = map;

    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    // Store marker
    window.L.marker([storeCoords.lat, storeCoords.lng], {
      icon: window.L.divIcon({ className: '', html: '<div style="font-size:28px;line-height:1;">🏪</div>', iconAnchor: [14, 28] })
    }).addTo(map).bindPopup('🏪 Bazzar Hub (Store)');

    // Customer drop-off marker
    window.L.marker([customerCoords.lat, customerCoords.lng], {
      icon: window.L.divIcon({ className: '', html: '<div style="font-size:28px;line-height:1;">📍</div>', iconAnchor: [14, 28] })
    }).addTo(map).bindPopup(`📦 Deliver to: ${trackingOrder?.customerName || 'Customer'}`);

    // Fetch REAL turn-by-turn road route from OSRM API
    const fetchRoadRoute = async () => {
      try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${storeCoords.lng},${storeCoords.lat};${customerCoords.lng},${customerCoords.lat}?overview=full&geometries=geojson`);
        const data = await res.json();
        if (data.routes && data.routes[0] && mapInstanceRef.current === map) {
          const roadCoords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
          roadRouteRef.current = roadCoords;

          window.L.polyline(roadCoords, {
            color: '#2563eb', weight: 6, opacity: 0.9, lineJoin: 'round', lineCap: 'round'
          }).addTo(map);

          const idx = Math.min(Math.floor(simulatedProgress * roadCoords.length), roadCoords.length - 1);
          const currentPos = roadCoords[idx] || [storeCoords.lat, storeCoords.lng];

          const marker = window.L.circleMarker(currentPos, {
            radius: 11, color: '#16a34a', fillColor: '#22c55e', fillOpacity: 1, weight: 3
          }).addTo(map).bindPopup('🚴 Delivery Agent (Live on Road)');
          agentMarkerRef.current = marker;

          map.fitBounds(roadCoords, { padding: [50, 50] });
          return;
        }
      } catch (err) {
        console.warn('OSRM road route error:', err);
      }

      // Fallback if offline
      window.L.polyline([[storeCoords.lat, storeCoords.lng], [customerCoords.lat, customerCoords.lng]], {
        color: '#2563eb', weight: 5, opacity: 0.8
      }).addTo(map);
      map.fitBounds([[storeCoords.lat, storeCoords.lng], [customerCoords.lat, customerCoords.lng]], { padding: [50, 50] });
    };

    fetchRoadRoute();

    setTimeout(() => {
      if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize();
    }, 250);

    return () => { if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null; } };
  }, [activeTab, trackingOrder, selectedOrder]);

  // Build Leaflet map for navigation screen overlay
  useEffect(() => {
    if (activeScreen !== 'navigation' || !navigationMapRef.current) return;
    if (!window.L) return; // Leaflet not loaded

    // Destroy previous map
    if (navigationMapInstanceRef.current) {
      navigationMapInstanceRef.current.remove();
      navigationMapInstanceRef.current = null;
    }

    const storeCoords = { lat: 12.9716, lng: 77.5946 }; // Bazzar Hub MG Road
    const customerCoords = selectedOrder?.deliveryCoords || { lat: 12.9352, lng: 77.6245 };
    const currentLat = storeCoords.lat + (customerCoords.lat - storeCoords.lat) * simulatedProgress;
    const currentLng = storeCoords.lng + (customerCoords.lng - storeCoords.lng) * simulatedProgress;

    const map = window.L.map(navigationMapRef.current, {
      zoomControl: false,
      attributionControl: false
    }).setView([currentLat, currentLng], 14);
    navigationMapInstanceRef.current = map;

    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    // Store marker (store icon)
    window.L.marker([storeCoords.lat, storeCoords.lng], {
      icon: window.L.divIcon({ className: '', html: '<div style="font-size:28px;line-height:1;">🏪</div>', iconAnchor: [14, 28] })
    }).addTo(map).bindPopup('🏪 Bazzar Hub (Store)');

    // Customer drop-off marker (red pin)
    window.L.marker([customerCoords.lat, customerCoords.lng], {
      icon: window.L.divIcon({ className: '', html: '<div style="font-size:28px;line-height:1;">📍</div>', iconAnchor: [14, 28] })
    }).addTo(map).bindPopup(`📦 Deliver to: ${selectedOrder?.customerName || 'Customer'}`);

    // Fetch REAL turn-by-turn road route from OSRM API
    const fetchRoadRoute = async () => {
      try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${storeCoords.lng},${storeCoords.lat};${customerCoords.lng},${customerCoords.lat}?overview=full&geometries=geojson`);
        const data = await res.json();
        if (data.routes && data.routes[0] && navigationMapInstanceRef.current === map) {
          const roadCoords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
          roadRouteRef.current = roadCoords;

          window.L.polyline(roadCoords, {
            color: '#2563eb', weight: 6, opacity: 0.9, lineJoin: 'round', lineCap: 'round'
          }).addTo(map);

          const idx = Math.min(Math.floor(simulatedProgress * roadCoords.length), roadCoords.length - 1);
          const currentPos = roadCoords[idx] || [storeCoords.lat, storeCoords.lng];

          const marker = window.L.circleMarker(currentPos, {
            radius: 11, color: '#16a34a', fillColor: '#22c55e', fillOpacity: 1, weight: 3
          }).addTo(map).bindPopup('🚴 Delivery Agent (Live on Road)');
          navAgentMarkerRef.current = marker;

          map.fitBounds(roadCoords, { padding: [50, 50] });
          return;
        }
      } catch (err) {
        console.warn('OSRM road route error:', err);
      }

      // Fallback if offline
      window.L.polyline([[storeCoords.lat, storeCoords.lng], [customerCoords.lat, customerCoords.lng]], {
        color: '#2563eb', weight: 5, opacity: 0.8
      }).addTo(map);
      map.fitBounds([[storeCoords.lat, storeCoords.lng], [customerCoords.lat, customerCoords.lng]], { padding: [50, 50] });
    };

    fetchRoadRoute();

    setTimeout(() => {
      if (navigationMapInstanceRef.current) navigationMapInstanceRef.current.invalidateSize();
    }, 250);

    return () => { if (navigationMapInstanceRef.current) { navigationMapInstanceRef.current.remove(); navigationMapInstanceRef.current = null; } };
  }, [activeScreen, selectedOrder]);

  // Smoothly update bike marker position WITHOUT zooming in/out or resetting the map
  useEffect(() => {
    const storeCoords = { lat: 12.9716, lng: 77.5946 };
    const customerCoords = trackingOrder?.deliveryCoords || selectedOrder?.deliveryCoords || { lat: 12.9352, lng: 77.6245 };
    let nextPos;
    if (roadRouteRef.current && roadRouteRef.current.length > 0) {
      const idx = Math.min(Math.floor(simulatedProgress * roadRouteRef.current.length), roadRouteRef.current.length - 1);
      nextPos = roadRouteRef.current[idx];
    } else {
      nextPos = [
        storeCoords.lat + (customerCoords.lat - storeCoords.lat) * simulatedProgress,
        storeCoords.lng + (customerCoords.lng - storeCoords.lng) * simulatedProgress
      ];
    }
    if (nextPos) {
      if (agentMarkerRef.current && agentMarkerRef.current.setLatLng) agentMarkerRef.current.setLatLng(nextPos);
      if (navAgentMarkerRef.current && navAgentMarkerRef.current.setLatLng) navAgentMarkerRef.current.setLatLng(nextPos);
    }
  }, [simulatedProgress, trackingOrder, selectedOrder]);

  const handleMarkPickedUp = (orderId) => {
    onUpdateOrderStatus(orderId, 'Out for Delivery');
    setSelectedOrder(null);
    setActiveScreen('list');
  };

  const handleMarkDelivered = (orderId) => {
    onUpdateOrderStatus(orderId, 'Delivered');
    setSelectedOrder(null);
    setActiveScreen('list');
    setActiveTab('home');
  };

  const openScreen = (order, screen) => {
    setSelectedOrder(order);
    setActiveScreen(screen);
  };

  // Renders
  const renderHome = () => (
    <div className="space-y-6 animate-fade-in pb-20">
      {/* Top Profile Section */}
      <div className="flex items-center justify-between bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center border-2 border-emerald-500 overflow-hidden">
            <User className="w-8 h-8 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-lg font-black text-gray-900">{user ? user.name : 'Delivery Partner'}</h2>
            <div className="flex items-center gap-1 text-sm font-bold text-amber-500">
              4.9 ⭐ <span className="text-gray-400 font-normal">(124 trips)</span>
            </div>
          </div>
        </div>
        <button 
          onClick={() => setIsOnline(!isOnline)}
          className={`relative w-14 h-8 rounded-full transition-colors duration-300 ease-in-out ${isOnline ? 'bg-emerald-500' : 'bg-gray-300'}`}
        >
          <div className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform duration-300 ease-in-out ${isOnline ? 'translate-x-7' : 'translate-x-1'}`} />
        </button>
      </div>

      {!isOnline && (
        <div className="bg-rose-50 border border-rose-100 rounded-2xl p-5 text-center shadow-sm">
          <Truck className="w-12 h-12 text-rose-300 mx-auto mb-2" />
          <h3 className="font-bold text-rose-900 mb-1">You are currently offline</h3>
          <p className="text-xs text-rose-600 mb-4">Go online to start receiving delivery requests and earning money.</p>
          <button 
            onClick={() => setIsOnline(true)}
            className="bg-emerald-600 text-white font-black px-6 py-3 rounded-xl w-full shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2"
          >
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
            GO ONLINE
          </button>
        </div>
      )}

      {isOnline && (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Today's Trips</span>
              <span className="text-3xl font-black text-gray-900">{completedDeliveriesCount}</span>
            </div>
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Earnings</span>
              <span className="text-3xl font-black text-emerald-600">₹{totalEarnings}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={() => setActiveTab('orders')}
              className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white p-4 rounded-2xl shadow-md flex items-center gap-3 transition-colors text-left"
            >
              <PackageCheck className="w-8 h-8 opacity-80" />
              <span className="font-bold text-sm leading-tight">View Active<br/>Orders</span>
            </button>
            <button 
              onClick={() => setActiveTab('earnings')}
              className="bg-white border border-gray-200 text-gray-800 p-4 rounded-2xl shadow-sm flex items-center gap-3 transition-colors text-left"
            >
              <Wallet className="w-8 h-8 text-emerald-600 opacity-80" />
              <span className="font-bold text-sm leading-tight">View Payout<br/>Details</span>
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderOrdersList = () => {
    if (!isOnline) {
      return (
        <div className="text-center py-20 px-4">
          <h3 className="font-bold text-gray-900 mb-2">Offline Mode</h3>
          <p className="text-sm text-gray-500 mb-6">You must be online to view and accept orders.</p>
          <button 
            onClick={() => setIsOnline(true)}
            className="bg-emerald-600 text-white font-black px-6 py-3 rounded-xl shadow-lg active:scale-95 transition-transform"
          >
            GO ONLINE
          </button>
        </div>
      );
    }

    const availableRequests = orders.filter(o => o.status === 'Preparing' && !acceptedOrders.includes(o.id));
    const activePickups = orders.filter(o => o.status === 'Preparing' && acceptedOrders.includes(o.id));
    const activeDeliveries = orders.filter(o => o.status === 'Out for Delivery');

    return (
      <div className="space-y-6 pb-20 animate-fade-in">
        {/* New Requests Section */}
        <div>
          <h3 className="font-black text-gray-900 text-sm mb-3 px-1 flex items-center justify-between">
            <span>New Requests</span>
            <span className="bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full text-[10px]">{availableRequests.length}</span>
          </h3>
          {availableRequests.length === 0 ? (
            <p className="text-xs text-gray-400 italic px-1">No new requests right now. Scanning area...</p>
          ) : (
            <div className="space-y-3">
              {availableRequests.map(order => (
                <div key={order.id} className="bg-white border-l-4 border-emerald-500 rounded-xl p-4 shadow-sm cursor-pointer hover:shadow-md transition-shadow" onClick={() => openScreen(order, 'request')}>
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-bold text-gray-900">Order {order.id}</span>
                    <span className="text-emerald-600 font-black">₹45 <span className="text-[10px] text-gray-400 font-normal">est.</span></span>
                  </div>
                  {(order.deliveryAddress || order.address) && (
                    <div className="flex items-start gap-1 mb-2 text-[11px] text-gray-500">
                      <MapPin className="w-3 h-3 mt-0.5 text-rose-400 shrink-0" />
                      <span className="line-clamp-2">{order.deliveryAddress || order.address}</span>
                    </div>
                  )}
                  <button className="w-full bg-emerald-50 text-emerald-700 font-bold py-2 rounded-lg border border-emerald-200">
                    View Details
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Pickups */}
        <div>
          <h3 className="font-black text-gray-900 text-sm mb-3 px-1 flex items-center justify-between">
            <span>To Pick Up</span>
            <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-[10px]">{activePickups.length}</span>
          </h3>
          {activePickups.length === 0 ? (
            <p className="text-xs text-gray-400 italic px-1">No pending pickups.</p>
          ) : (
            <div className="space-y-3">
              {activePickups.map(order => (
                <div key={order.id} className="bg-amber-50 border border-amber-200 rounded-xl p-4 shadow-sm cursor-pointer" onClick={() => openScreen(order, 'pickup')}>
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-bold text-amber-900">Pickup {order.id}</span>
                  </div>
                  <div className="text-xs text-amber-700/80 mb-3">Bazzar Hub (MG Road)</div>
                  <button className="w-full bg-amber-600 text-white font-bold py-2 rounded-lg shadow-sm pointer-events-none">
                    View Pickup Details
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Deliveries */}
        <div>
          <h3 className="font-black text-gray-900 text-sm mb-3 px-1 flex items-center justify-between">
            <span>To Deliver</span>
            <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full text-[10px]">{activeDeliveries.length}</span>
          </h3>
          {activeDeliveries.length === 0 ? (
            <p className="text-xs text-gray-400 italic px-1">No active deliveries.</p>
          ) : (
            <div className="space-y-3">
              {activeDeliveries.map(order => (
                <div key={order.id} className="bg-purple-50 border border-purple-200 rounded-xl p-4 shadow-sm">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-bold text-purple-900">Dropoff {order.id}</span>
                  </div>
                  <div className="text-xs text-purple-700/80 mb-1 line-clamp-2">{order.deliveryAddress || order.address}</div>
                  <div className="flex gap-2 mt-3">
                    <button
                      className="flex-1 bg-purple-600 text-white font-bold py-2 rounded-lg shadow-sm active:scale-95 transition-transform"
                      onClick={() => openScreen(order, 'navigation')}
                    >
                      Start Navigation
                    </button>
                    <button
                      className="flex-1 bg-emerald-50 border border-emerald-200 text-emerald-700 font-bold py-2 rounded-lg active:scale-95 transition-transform"
                      onClick={() => { setTrackingOrder(order); setActiveTab('map'); }}
                    >
                      🗺️ Track Live
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderNewRequest = () => (
    <div className="absolute inset-0 bg-gray-50 z-50 flex flex-col animate-slide-up">
      <div className="bg-white p-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={() => setActiveScreen('list')} className="p-1 rounded-full bg-gray-100"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-black text-lg">New Request</h2>
      </div>
      
      <div className="flex-1 p-5 space-y-6">
        <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 p-6 text-center">
          <span className="block text-sm font-bold text-gray-500 mb-1">Estimated Earnings</span>
          <span className="text-5xl font-black text-emerald-600">₹45</span>
        </div>

        <div className="relative pl-6 space-y-8 before:absolute before:inset-y-2 before:left-2.5 before:w-0.5 before:bg-gray-200">
          <div className="relative">
            <span className="absolute -left-[27px] bg-white p-1 rounded-full border-2 border-emerald-500">
              <div className="w-2 h-2 bg-emerald-500 rounded-full" />
            </span>
            <p className="font-black text-sm text-gray-900">Bazzar Hub (MG Road)</p>
            <p className="text-xs text-gray-500">Pickup</p>
          </div>
          <div className="relative">
            <span className="absolute -left-[27px] bg-white p-1 rounded-full border-2 border-rose-500">
              <MapPin className="w-2 h-2 text-rose-500" />
            </span>
            <p className="font-black text-sm text-gray-900">{selectedOrder?.address}</p>
            <p className="text-xs text-gray-500">Dropoff • 2.5 km</p>
          </div>
        </div>

        <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 flex items-center gap-3">
          <Clock className="w-5 h-5 text-emerald-600" />
          <span className="font-bold text-emerald-900 text-sm">Est. total time: 14 mins</span>
        </div>
      </div>

      <div className="p-4 bg-white border-t border-gray-200 flex gap-3">
        <button onClick={() => setActiveScreen('list')} className="flex-1 py-4 bg-gray-100 text-gray-700 rounded-xl font-bold active:scale-95 transition-transform">Reject</button>
        <button onClick={() => handleAcceptOrder(selectedOrder)} className="flex-1 py-4 bg-emerald-600 text-white rounded-xl font-black shadow-lg active:scale-95 transition-transform">✅ Accept Order</button>
      </div>
    </div>
  );

  const renderPickupScreen = () => (
    <div className="absolute inset-0 bg-gray-50 z-50 flex flex-col animate-slide-up">
      <div className="bg-white p-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={() => setActiveScreen('list')} className="p-1 rounded-full bg-gray-100"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-black text-lg">Pickup Details</h2>
      </div>
      
      <div className="flex-1 p-5 overflow-y-auto space-y-6">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-black text-gray-900 mb-1">Store Details</h3>
          <p className="text-gray-600 text-sm">Bazzar Hub</p>
          <p className="text-gray-400 text-xs mb-3">MG Road, Indiranagar</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                if (selectedOrder) setTrackingOrder(selectedOrder);
                setActiveScreen('navigation');
              }}
              className="w-full flex items-center justify-center gap-2 bg-blue-50 hover:bg-blue-100 text-blue-700 py-3 rounded-xl font-bold border border-blue-200 active:scale-95 transition-transform cursor-pointer text-xs shadow-xs"
            >
              <Navigation className="w-4 h-4" /> Live Map
            </button>
            <button
              type="button"
              onClick={() => {
                const query = encodeURIComponent('Bazzar Hub, MG Road, Indiranagar, Bangalore');
                window.open(`https://www.google.com/maps/dir/?api=1&destination=${query}`, '_blank');
              }}
              className="w-full flex items-center justify-center gap-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 py-3 rounded-xl font-bold border border-emerald-200 active:scale-95 transition-transform cursor-pointer text-xs shadow-xs"
              title="Open turn-by-turn directions in Google Maps"
            >
              <MapPin className="w-4 h-4" /> Google Maps
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <h3 className="font-black text-gray-900 mb-3 border-b pb-2">Order Items ({selectedOrder?.items?.length})</h3>
          <ul className="space-y-3">
            {selectedOrder?.items?.map((item, idx) => (
              <li key={idx} className="flex justify-between items-center text-sm">
                <span className="font-bold text-gray-700">{item.quantity}x {item.name}</span>
                <span className="text-gray-400">Verify</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="p-4 bg-white border-t border-gray-200">
        <button onClick={() => handleMarkPickedUp(selectedOrder?.id)} className="w-full py-4 bg-[#1B4D3E] text-white rounded-xl font-black shadow-lg flex justify-center items-center gap-2 active:scale-95 transition-transform">
          <PackageCheck className="w-5 h-5" /> Mark as Picked Up
        </button>
      </div>
    </div>
  );

  const renderNavigationScreen = () => (
    <div className="absolute inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up overflow-hidden">
      {/* Real Map Background */}
      <div ref={navigationMapRef} className="absolute inset-0 z-0 w-full h-full" />
      <div className="absolute inset-0 z-0 bg-gradient-to-b from-slate-900/40 via-transparent to-slate-900/30 pointer-events-none" />

      {/* Floating Header */}
      <div className="relative z-10 p-4 flex items-center justify-between">
        <button onClick={() => setActiveScreen('pickup')} className="p-2 rounded-full bg-slate-800/80 backdrop-blur-md text-white shadow-lg cursor-pointer hover:bg-slate-700"><ArrowLeft className="w-5 h-5" /></button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const query = encodeURIComponent(selectedOrder?.address || 'MG Road, Indiranagar, Bangalore');
              window.open(`https://www.google.com/maps/dir/?api=1&destination=${query}`, '_blank');
            }}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-full font-bold text-xs shadow-lg flex items-center gap-1.5 cursor-pointer"
          >
            <MapPin className="w-3.5 h-3.5" /> Open Google Maps App 🗺️
          </button>
          <div className="bg-emerald-500 text-white px-3 py-1.5 rounded-full font-black shadow-lg flex items-center gap-1.5 text-xs">
            <span className="animate-pulse">🟢</span> {(4.2 * (1 - simulatedProgress)).toFixed(1)} km • ~{Math.max(1, Math.round(4.2 * (1 - simulatedProgress) * 3))} mins
          </div>
        </div>
      </div>

      <div className="flex-1 pointer-events-none" />



      {/* Bottom Sheet */}
      <div className="relative z-10 bg-white rounded-t-3xl p-5 shadow-[0_-10px_40px_rgba(0,0,0,0.15)]">
        <div className="w-12 h-1.5 bg-gray-200 rounded-full mx-auto mb-4" />
        
        {/* Distance & ETA Banner */}
        <div className="bg-gradient-to-r from-emerald-50 to-blue-50 border border-emerald-200/80 rounded-2xl p-3.5 mb-5 flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-black text-lg shadow-sm">
              🚴
            </div>
            <div>
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wide">Remaining Distance</p>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="text-2xl font-black text-emerald-900">
                  {(4.2 * (1 - simulatedProgress)).toFixed(1)} km
                </span>
                <span className="text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                  ~{Math.max(1, Math.round(4.2 * (1 - simulatedProgress) * 3))} mins ETA
                </span>
              </div>
            </div>
          </div>
          <div className="text-right border-l border-emerald-200/60 pl-3">
            <p className="text-[10px] text-gray-400 font-bold uppercase">Speed</p>
            <p className="text-sm font-black text-gray-800">26 km/h</p>
          </div>
        </div>

        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">Delivering to</p>
            <h3 className="font-black text-gray-900 text-lg">{selectedOrder?.customerName}</h3>
            <p className="text-sm text-gray-600 line-clamp-1">{selectedOrder?.address}</p>
          </div>
          <div className="flex gap-2">
            <a href={`tel:${selectedOrder?.phone || '9876543210'}`} className="w-11 h-11 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 shadow-sm active:scale-95 transition-transform">
              <Phone className="w-5 h-5" />
            </a>
            <button
              type="button"
              onClick={() => {
                const query = encodeURIComponent(selectedOrder?.address || 'MG Road, Indiranagar, Bangalore');
                window.open(`https://www.google.com/maps/dir/?api=1&destination=${query}`, '_blank');
              }}
              title="Open directions in Google Maps"
              className="w-11 h-11 rounded-full bg-blue-50 hover:bg-blue-100 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm active:scale-95 transition-transform cursor-pointer"
            >
              <Navigation className="w-5 h-5" />
            </button>
          </div>
        </div>

        <button onClick={() => setActiveScreen('confirmation')} className="w-full py-4 bg-emerald-600 text-white rounded-xl font-black shadow-lg flex justify-center items-center gap-2 active:scale-95 transition-transform">
          <MapPin className="w-5 h-5" /> Arrived at Destination
        </button>
      </div>
    </div>
  );

  const renderConfirmationScreen = () => (
    <div className="absolute inset-0 bg-gray-50 z-50 flex flex-col animate-slide-up">
      <div className="bg-white p-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={() => setActiveScreen('navigation')} className="p-1 rounded-full bg-gray-100"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-black text-lg">Delivery Confirmation</h2>
      </div>
      
      <div className="flex-1 p-5 overflow-y-auto space-y-6">
        <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 p-6 text-center">
          <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h3 className="font-black text-gray-900 text-lg mb-1">You've Arrived!</h3>
          <p className="text-gray-500 text-sm">Please verify the OTP provided by the customer before handing over the package.</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-center">
          <h4 className="font-bold text-gray-700 mb-3 text-sm">Enter 4-Digit Delivery OTP</h4>
          <input 
            type="text" 
            value={otpInput}
            onChange={(e) => setOtpInput(e.target.value)}
            placeholder="• • • •"
            className="w-full bg-gray-50 border-2 border-gray-200 rounded-xl py-3 text-center text-2xl font-black tracking-[1em] focus:border-emerald-500 outline-none transition-colors"
            maxLength={4}
          />
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <button className="w-full flex items-center justify-center gap-2 bg-slate-50 text-slate-700 py-3 rounded-xl font-bold border border-slate-200 active:scale-95 transition-transform">
            <Camera className="w-5 h-5" /> Upload Delivery Photo
          </button>
        </div>
      </div>

      <div className="p-4 bg-white border-t border-gray-200">
        <button 
          onClick={() => handleMarkDelivered(selectedOrder?.id)} 
          disabled={otpInput.length < 4}
          className={`w-full py-4 rounded-xl font-black shadow-lg flex justify-center items-center gap-2 transition-all ${
            otpInput.length === 4 
              ? 'bg-emerald-600 text-white active:scale-95' 
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          <Check className="w-5 h-5" /> Verify OTP & Complete
        </button>
      </div>
    </div>
  );

  const renderEarnings = () => (
    <div className="space-y-6 animate-fade-in pb-20">
      <div className="bg-gradient-to-br from-emerald-800 to-[#1B4D3E] p-6 rounded-3xl shadow-xl text-white">
        <span className="block text-emerald-200 text-sm font-bold uppercase tracking-wider mb-1">Weekly Payout</span>
        <h2 className="text-5xl font-black mb-4">₹{totalEarnings * 3}</h2>
        <div className="flex justify-between items-center border-t border-emerald-700/50 pt-4 mt-2">
          <div>
            <span className="block text-xs text-emerald-300">Available Balance</span>
            <span className="font-bold text-lg">₹{totalEarnings}</span>
          </div>
          <button className="bg-white text-emerald-900 px-4 py-2 rounded-xl font-black text-xs shadow-md active:scale-95 transition-transform">
            Withdraw Money
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <h3 className="font-black text-gray-900 mb-4 border-b pb-2">Recent Activity</h3>
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-50 rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <p className="font-bold text-gray-800 text-sm">Delivery Completed</p>
                  <p className="text-xs text-gray-400">Today, 2:30 PM</p>
                </div>
              </div>
              <span className="font-black text-emerald-600">+₹45</span>
            </div>
          ))}
        </div>
      </div>
      
      <button className="w-full bg-gray-100 text-gray-700 font-bold py-4 rounded-2xl active:scale-95 transition-transform">
        Download Report
      </button>
    </div>
  );

  const renderProfile = () => (
    <div className="space-y-6 animate-fade-in pb-20">
      <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100 text-center">
        <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center border-4 border-white shadow-lg mx-auto mb-4">
          <User className="w-12 h-12 text-emerald-600" />
        </div>
        <h2 className="text-2xl font-black text-gray-900">{user ? user.name : 'Delivery Partner'}</h2>
        <p className="text-gray-500 mb-4">{user ? user.phone : '+91 98765 00000'}</p>
        <div className="inline-flex bg-emerald-50 text-emerald-700 px-4 py-1.5 rounded-full font-bold text-sm border border-emerald-200">
          Verified Partner ✔️
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <button className="w-full p-4 flex justify-between items-center border-b border-gray-50 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left">
          <span className="font-bold text-gray-700">Account Details</span>
          <span className="text-gray-400">›</span>
        </button>
        <button className="w-full p-4 flex justify-between items-center border-b border-gray-50 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left">
          <span className="font-bold text-gray-700">Vehicle Information</span>
          <span className="text-gray-400">›</span>
        </button>
        <button className="w-full p-4 flex justify-between items-center hover:bg-gray-50 active:bg-gray-100 transition-colors text-left">
          <span className="font-bold text-gray-700">Help & Support</span>
          <span className="text-gray-400">›</span>
        </button>
      </div>

      {onLogout && (
        <button 
          onClick={onLogout}
          className="w-full bg-rose-50 text-rose-600 font-black py-4 rounded-2xl border border-rose-100 active:scale-95 transition-transform flex items-center justify-center gap-2"
        >
          <LogOut className="w-5 h-5" /> SIGN OUT
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-[100dvh] bg-gray-50 flex flex-col font-sans relative max-w-md mx-auto shadow-2xl overflow-hidden border-x border-gray-200">
      {/* Header with notification bell */}
      <header className="bg-white px-5 py-4 border-b border-gray-100 shadow-sm sticky top-0 z-40">
        <div className="flex items-center justify-between">
          <h1 className="font-black text-xl text-gray-900 tracking-tight">
            {activeTab === 'home' && 'Dashboard'}
            {activeTab === 'orders' && 'Active Tasks'}
            {activeTab === 'map' && '🗺 Live Tracking'}
            {activeTab === 'earnings' && 'Earnings'}
            {activeTab === 'profile' && 'My Profile'}
          </h1>
          {/* Notification bell */}
          <div className="relative">
            <Bell className="w-6 h-6 text-gray-500" />
            {notifications.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-rose-500 text-white text-[10px] font-black rounded-full flex items-center justify-center animate-bounce">{notifications.length}</span>
            )}
          </div>
        </div>

        {/* Notification banners */}
        {notifications.map((notif) => (
          <div
            key={notif.id}
            className="mt-3 bg-emerald-600 text-white px-3 py-2.5 rounded-xl flex items-start gap-2 shadow-md animate-pulse cursor-pointer"
            onClick={() => {
              if (onClearNotification) onClearNotification(notif.id);
              setTrackingOrder(notif);
              setActiveTab('orders');
            }}
          >
            <Bell className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-black text-xs">🔔 New Delivery Request!</p>
              <p className="text-[10px] text-emerald-200 truncate">Order {notif.id} • {notif.customerName} • {notif.deliveryAddress || notif.address}</p>
            </div>
            <button
              className="shrink-0 p-0.5 bg-emerald-700 rounded-full"
              onClick={(e) => { e.stopPropagation(); if(onClearNotification) onClearNotification(notif.id); }}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 overflow-y-auto relative">
        {activeTab === 'home' && renderHome()}
        {activeTab === 'orders' && renderOrdersList()}
        {activeTab === 'map' && (
          <div className="flex flex-col h-[calc(100dvh-160px)]">
            {(() => {
              const mapOrder = trackingOrder || selectedOrder || orders[0];
              return mapOrder ? (
                <>
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mb-3 text-xs flex justify-between items-center">
                    <div>
                      <p className="font-bold text-emerald-800">📦 Delivering to: {mapOrder.customerName}</p>
                      <p className="text-emerald-600 truncate">{mapOrder.deliveryAddress || mapOrder.address}</p>
                    </div>
                    <span className="bg-emerald-600 text-white px-2 py-1 rounded-md text-[10px] font-black animate-pulse">LIVE TRACKING</span>
                  </div>
                  <div ref={mapContainerRef} className="flex-1 rounded-2xl overflow-hidden border border-gray-200 shadow-md" style={{ minHeight: '300px' }} />
                </>
              ) : (
                <div className="text-center py-20">
                  <MapIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500 font-bold">Accept an order to view live tracking.</p>
                </div>
              );
            })()}
          </div>
        )}
        {activeTab === 'earnings' && renderEarnings()}
        {activeTab === 'profile' && renderProfile()}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 mx-auto w-full max-w-md bg-white border-t border-gray-200 pb-safe pt-2 px-6 flex justify-between items-center shadow-[0_-10px_20px_rgba(0,0,0,0.03)] z-40 rounded-t-3xl">
        <NavButton icon={Home} label="Home" isActive={activeTab === 'home'} onClick={() => setActiveTab('home')} />
        <NavButton icon={PackageCheck} label="Orders" isActive={activeTab === 'orders'} onClick={() => setActiveTab('orders')} />
        <NavButton icon={MapIcon} label="Map" isActive={activeTab === 'map'} onClick={() => setActiveTab('map')} />
        <NavButton icon={Wallet} label="Earnings" isActive={activeTab === 'earnings'} onClick={() => setActiveTab('earnings')} />
        <NavButton icon={User} label="Profile" isActive={activeTab === 'profile'} onClick={() => setActiveTab('profile')} />
      </nav>

      {/* Overlays / Screens */}
      {activeScreen === 'request' && renderNewRequest()}
      {activeScreen === 'pickup' && renderPickupScreen()}
      {activeScreen === 'navigation' && renderNavigationScreen()}
      {activeScreen === 'confirmation' && renderConfirmationScreen()}
    </div>
  );
}

const NavButton = ({ icon: Icon, label, isActive, onClick }) => (
  <button 
    onClick={onClick} 
    className="flex flex-col items-center gap-1 p-2 active:scale-90 transition-transform"
  >
    <div className={`p-1.5 rounded-xl transition-colors ${isActive ? 'bg-emerald-100 text-emerald-700' : 'text-gray-400'}`}>
      <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
    </div>
    <span className={`text-[10px] font-bold ${isActive ? 'text-emerald-700' : 'text-gray-400'}`}>{label}</span>
  </button>
);
