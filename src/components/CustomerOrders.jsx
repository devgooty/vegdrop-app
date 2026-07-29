import React, { useState, useEffect, useRef } from 'react';
import { Package, Clock, IndianRupee, MapPin, ArrowRight, ShoppingBag, CalendarRange, RotateCw, PauseCircle, PlayCircle, Trash2, CalendarDays, CalendarClock, Calendar as CalendarIcon, ChevronRight, Navigation, X } from 'lucide-react';

export default function CustomerOrders({ 
  orders, 
  scheduledOrders, 
  setScheduledOrders, 
  cartItems, 
  setCartItems, 
  selectedDates,
  setSelectedDates,
  scheduleFilter,
  setScheduleFilter,
  handleScheduleCart,
  onStartScheduledShopping, 
  onGoHome 
}) {
  const [activeTab, setActiveTab] = useState('recent');
  const [trackingModalOrder, setTrackingModalOrder] = useState(null);
  const trackingMapRef = useRef(null);
  const trackingMapInstanceRef = useRef(null);

  // Build Leaflet tracking map for customer when modal opens
  useEffect(() => {
    if (!trackingModalOrder || !trackingMapRef.current) return;
    if (!window.L) return;

    // destroy previous
    if (trackingMapInstanceRef.current) {
      trackingMapInstanceRef.current.remove();
      trackingMapInstanceRef.current = null;
    }

    const customerCoords = trackingModalOrder.deliveryCoords;
    const center = customerCoords ? [customerCoords.lat, customerCoords.lng] : [12.9716, 77.5946];

    const map = window.L.map(trackingMapRef.current, { attributionControl: false }).setView(center, 14);
    trackingMapInstanceRef.current = map;

    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    // Customer delivery pin
    if (customerCoords) {
      window.L.marker([customerCoords.lat, customerCoords.lng], {
        icon: window.L.divIcon({ className: '', html: '<div style="font-size:28px;line-height:1;">📍</div>', iconAnchor: [14, 28] })
      }).addTo(map).bindPopup('Your delivery location').openPopup();
    }

    // Simulated delivery agent starting ~800m north of customer
    const agentStartLat = (customerCoords?.lat ?? 12.9716) + 0.007;
    const agentStartLng = (customerCoords?.lng ?? 77.5946);

    const agentMarker = window.L.circleMarker([agentStartLat, agentStartLng], {
      radius: 9, color: '#1B4D3E', fillColor: '#22c55e', fillOpacity: 1, weight: 3
    }).addTo(map).bindPopup('🚴 Delivery Agent');

    if (customerCoords) {
      window.L.polyline([[agentStartLat, agentStartLng], [customerCoords.lat, customerCoords.lng]], {
        color: '#1B4D3E', weight: 3, dashArray: '6 4', opacity: 0.7
      }).addTo(map);
      map.fitBounds([[agentStartLat, agentStartLng], [customerCoords.lat, customerCoords.lng]], { padding: [40, 40] });
    }

    // Animate agent marker moving toward customer over 30 steps
    let step = 0;
    const totalSteps = 30;
    const interval = setInterval(() => {
      step++;
      if (step >= totalSteps) { clearInterval(interval); return; }
      const t = step / totalSteps;
      const lat = agentStartLat + t * ((customerCoords?.lat ?? agentStartLat) - agentStartLat);
      const lng = agentStartLng + t * ((customerCoords?.lng ?? agentStartLng) - agentStartLng);
      agentMarker.setLatLng([lat, lng]);
    }, 600);

    return () => {
      clearInterval(interval);
      if (trackingMapInstanceRef.current) { trackingMapInstanceRef.current.remove(); trackingMapInstanceRef.current = null; }
    };
  }, [trackingModalOrder]);

  // Calendar logic: Rolling 30-day window starting from today
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daysArray = React.useMemo(() => {
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      return d;
    });
  }, [today.getTime()]);

  const firstDayOfWeek = today.getDay();
  const emptyDays = Array.from({ length: firstDayOfWeek }, (_, i) => i);

  const startMonth = daysArray[0].toLocaleString('default', { month: 'short' });
  const endMonth = daysArray[daysArray.length - 1].toLocaleString('default', { month: 'short' });
  const calendarTitle = startMonth === endMonth ? `${startMonth} ${today.getFullYear()}` : `${startMonth} - ${endMonth} ${today.getFullYear()}`;

  const formatDateStr = (d) => {
    const offset = d.getTimezoneOffset();
    const localDate = new Date(d.getTime() - (offset * 60 * 1000));
    return localDate.toISOString().split('T')[0];
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'Pending': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'Preparing': return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'Out for Delivery': return 'bg-purple-100 text-purple-800 border-purple-200';
      case 'Delivered': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case 'Cancelled': return 'bg-rose-100 text-rose-800 border-rose-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const toggleScheduleStatus = (scheduleId) => {
    if (!setScheduledOrders) return;
    setScheduledOrders(prev => prev.map(s => {
      if (s.id === scheduleId) {
        return { ...s, status: s.status === 'Active' ? 'Paused' : 'Active' };
      }
      return s;
    }));
  };

  const deleteSchedule = (scheduleId) => {
    if (!setScheduledOrders) return;
    if (window.confirm('Are you sure you want to cancel this scheduled delivery?')) {
      setScheduledOrders(prev => prev.filter(s => s.id !== scheduleId));
    }
  };

  const handleDateClick = (dateObj) => {
    const dateStr = formatDateStr(dateObj);
    if (scheduleFilter === 'Daily') {
      setSelectedDates([dateStr]);
    } else if (scheduleFilter === 'Weekly') {
      if (selectedDates.includes(dateStr)) {
        setSelectedDates(prev => prev.filter(d => d !== dateStr));
      } else {
        if (selectedDates.length >= 7) {
          alert("You can select up to 7 days maximum for a weekly schedule.");
          return;
        }
        setSelectedDates(prev => [...prev, dateStr].sort());
      }
    } else if (scheduleFilter === 'Monthly') {
      if (selectedDates.includes(dateStr)) {
        setSelectedDates(prev => prev.filter(d => d !== dateStr));
      } else {
        if (selectedDates.length >= 30) {
          alert(`You can select up to 30 days maximum.`);
          return;
        }
        setSelectedDates(prev => [...prev, dateStr].sort());
      }
    }
  };

  // Reset selected dates when switching filters
  React.useEffect(() => {
    setSelectedDates([]);
  }, [scheduleFilter, setSelectedDates]);

  // Filter and sort scheduled orders by frequency and next delivery date
  const filteredSchedules = (scheduledOrders || [])
    .filter(s => {
      if (scheduleFilter === 'All') return true;
      return s.frequency === scheduleFilter;
    })
    .sort((a, b) => a.nextDeliveryDate - b.nextDeliveryDate);

  const filterButtons = [
    { key: 'All', label: 'All', icon: CalendarRange, color: 'text-[#1B4D3E]' },
    { key: 'Daily', label: 'Day by Day', icon: CalendarDays, color: 'text-blue-600' },
    { key: 'Weekly', label: 'Weekly', icon: CalendarClock, color: 'text-purple-600' },
    { key: 'Monthly', label: 'Monthly', icon: CalendarIcon, color: 'text-amber-600' },
  ];

  const getFrequencyStyle = (frequency) => {
    switch (frequency) {
      case 'Daily': return { bg: 'bg-blue-500', badge: 'bg-blue-100 text-blue-800 border-blue-200', label: '📅 Daily Delivery' };
      case 'Weekly': return { bg: 'bg-purple-500', badge: 'bg-purple-100 text-purple-800 border-purple-200', label: '🗓️ Weekly Delivery' };
      case 'Monthly': return { bg: 'bg-amber-500', badge: 'bg-amber-100 text-amber-800 border-amber-200', label: '📆 Monthly Delivery' };
      default: return { bg: 'bg-gray-400', badge: 'bg-gray-100 text-gray-800 border-gray-200', label: 'Scheduled' };
    }
  };

  return (
    <div className="animate-fade-in pb-12">
      {/* Header */}
      <div className="bg-[#1B4D3E] text-white pt-6 pb-4 px-4 shadow-lg sticky top-0 z-20">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
            <Package className="w-5 h-5 text-amber-300" />
          </div>
          <div>
            <h1 className="font-vintage text-2xl font-black tracking-wide drop-shadow-md">My Orders</h1>
            <p className="text-emerald-100 text-xs font-medium">Track purchases & subscriptions</p>
          </div>
        </div>

        {/* Main Tabs */}
        <div className="flex bg-white/10 p-1 rounded-xl backdrop-blur-sm">
          <button
            onClick={() => setActiveTab('recent')}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'recent' 
                ? 'bg-white text-[#1B4D3E] shadow-sm' 
                : 'text-white/80 hover:bg-white/5'
            }`}
          >
            <Clock className="w-3.5 h-3.5" /> Recent Orders
          </button>
          <button
            onClick={() => setActiveTab('scheduled')}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'scheduled' 
                ? 'bg-white text-[#1B4D3E] shadow-sm' 
                : 'text-white/80 hover:bg-white/5'
            }`}
          >
            <CalendarRange className="w-3.5 h-3.5" /> Scheduled Deliveries
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4 pt-4">
        
        {/* ==================== RECENT ORDERS TAB ==================== */}
        {activeTab === 'recent' && (
          <>
            {orders.length === 0 ? (
              <div className="bg-white rounded-3xl p-8 text-center shadow-lg border border-gray-100 mt-4 animate-scale-in">
                <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ShoppingBag className="w-10 h-10 text-emerald-300" />
                </div>
                <h3 className="font-bold text-lg text-gray-800 mb-2">No Orders Yet!</h3>
                <p className="text-sm text-gray-500 mb-6">You haven't placed any orders with VegBazzar yet. Start exploring fresh produce!</p>
                <button
                  onClick={onGoHome}
                  className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-bold py-3 px-6 rounded-2xl shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 mx-auto w-full"
                >
                  Start Shopping <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            ) : (
              orders.map((order) => (
                <div key={order.id} className="bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 hover:shadow-md transition-shadow relative overflow-hidden group animate-fade-in">
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-[#1B4D3E] to-emerald-400 opacity-80" />
                  
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-black text-gray-900 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200 shadow-xs">
                          #{String(order.id).slice(-6)}
                        </span>
                        <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${getStatusColor(order.status)}`}>
                          {order.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-gray-500 font-semibold">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(order.timestamp).toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-black text-[#1B4D3E] flex items-center justify-end drop-shadow-sm">
                        <IndianRupee className="w-4 h-4" />
                        {order.totalAmount}
                      </span>
                      <span className="text-[9px] text-gray-400 font-bold uppercase tracking-wider">{order.paymentMethod || 'Online'}</span>
                    </div>
                  </div>

                  <div className="bg-[#FAF7F2] rounded-xl p-3 border border-[#EAE3D2] shadow-inner mb-3">
                    <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                      <Package className="w-3 h-3" /> Order Items
                    </h4>
                    <div className="space-y-1.5">
                      {order.items.map((item, idx) => (
                        <div key={idx} className="flex justify-between text-xs font-bold">
                          <span className="text-gray-700">{item.quantity}x {item.name}</span>
                          <span className="text-gray-900">₹{item.price * item.quantity}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-start gap-2 text-xs font-medium text-gray-600 bg-gray-50 p-2.5 rounded-xl border border-gray-100">
                    <MapPin className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    <p className="line-clamp-2 leading-tight">{order.deliveryAddress || order.address}</p>
                  </div>

                  {/* Track Your Order button for Out for Delivery */}
                  {order.status === 'Out for Delivery' && (
                    <button
                      onClick={() => setTrackingModalOrder(order)}
                      className="mt-3 w-full py-2.5 bg-gradient-to-r from-[#1B4D3E] to-emerald-600 text-white font-black text-xs rounded-xl shadow-md flex items-center justify-center gap-2 active:scale-95 transition-transform animate-pulse"
                    >
                      <Navigation className="w-4 h-4" />
                      Track Your Order Live 🚴
                    </button>
                  )}
                </div>
              ))
            )}
          </>
        )}

        {/* ==================== SCHEDULED DELIVERIES TAB ==================== */}
        {activeTab === 'scheduled' && (
          <>
            {/* Frequency Filter Buttons */}
            <div className="flex flex-col gap-2 pb-4">
              {filterButtons.map(btn => {
                const Icon = btn.icon;
                const isActive = scheduleFilter === btn.key;
                const count = btn.key === 'All' 
                  ? (scheduledOrders || []).length 
                  : (scheduledOrders || []).filter(s => s.frequency === btn.key).length;
                return (
                  <button
                    key={btn.key}
                    onClick={() => setScheduleFilter(btn.key)}
                    className={`flex items-center justify-between w-full px-4 py-3 rounded-2xl text-sm font-extrabold transition-all shadow-sm border active:scale-95 ${
                      isActive
                        ? 'bg-[#1B4D3E] text-white border-[#1B4D3E] shadow-md'
                        : 'bg-white text-gray-700 border-gray-200 hover:border-[#1B4D3E]/30'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`w-5 h-5 ${isActive ? 'text-amber-300' : btn.color}`} />
                      {btn.label}
                    </div>
                    <span className={`text-xs rounded-full px-2.5 py-0.5 font-black ${
                      isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* CALENDAR SCHEDULING (Visible in Daily, Weekly, and Monthly mode) */}
            {['Daily', 'Weekly', 'Monthly'].includes(scheduleFilter) && (
              <div className="bg-white rounded-[1.5rem] p-4 shadow-md border border-gray-100 animate-scale-in mb-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="font-black text-gray-800 text-lg">Pick Date{['Weekly', 'Monthly'].includes(scheduleFilter) ? 's' : ''}</h3>
                    <p className="text-xs font-bold text-blue-500">
                      {scheduleFilter === 'Weekly' 
                        ? 'Select 3 to 7 days for weekly delivery' 
                        : scheduleFilter === 'Monthly'
                          ? `Select at least 15 days`
                          : 'Schedule your cart for delivery'}
                    </p>
                  </div>
                  <div className="bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs font-black shadow-inner border border-blue-100">
                    {calendarTitle}
                  </div>
                </div>

                {/* Days of week */}
                <div className="grid grid-cols-7 gap-1 mb-2 text-center text-[10px] font-black text-gray-400 uppercase tracking-wider">
                  {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
                    <div key={day}>{day}</div>
                  ))}
                </div>

                {/* Calendar Grid */}
                <div className="grid grid-cols-7 gap-1.5 mb-4">
                  {emptyDays.map(empty => (
                    <div key={`empty-${empty}`} className="h-8"></div>
                  ))}
                  {daysArray.map((dateObj, idx) => {
                    const dateStr = formatDateStr(dateObj);
                    const isSelected = selectedDates.includes(dateStr);
                    const isToday = idx === 0; // The first day in our array is always today
                    return (
                      <button
                        key={dateStr}
                        onClick={() => handleDateClick(dateObj)}
                        className={`relative h-9 rounded-xl text-xs font-extrabold flex items-center justify-center transition-all shadow-sm ${
                          isSelected 
                            ? 'bg-blue-600 text-white shadow-md scale-110'
                            : isToday 
                              ? 'bg-amber-100 text-amber-800 border border-amber-200'
                              : 'bg-gray-50 text-gray-700 border border-gray-100 hover:bg-blue-50'
                        }`}
                      >
                        {dateObj.getDate()}
                        
                        {/* Tiny Cart Badge for Selected Dates */}
                        {isSelected && (
                          <div 
                            onClick={(e) => {
                              e.stopPropagation();
                              onStartScheduledShopping();
                            }}
                            className="absolute -top-1.5 -right-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-full p-0.5 shadow-sm border border-white z-10 animate-scale-in cursor-pointer active:scale-95"
                          >
                            <ShoppingBag className="w-2.5 h-2.5" />
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* Validation messages for Weekly & Monthly */}
                {scheduleFilter === 'Weekly' && selectedDates.length > 0 && selectedDates.length < 3 && (
                  <div className="text-center text-xs font-bold text-amber-600 bg-amber-50 rounded-lg py-2 mb-4 border border-amber-200">
                    Please select at least {3 - selectedDates.length} more day{3 - selectedDates.length > 1 ? 's' : ''}.
                  </div>
                )}
                {scheduleFilter === 'Monthly' && selectedDates.length > 0 && selectedDates.length < 15 && (
                  <div className="text-center text-xs font-bold text-amber-600 bg-amber-50 rounded-lg py-2 mb-4 border border-amber-200">
                    Please select at least {15 - selectedDates.length} more day{15 - selectedDates.length > 1 ? 's' : ''}.
                  </div>
                )}

                {/* Cart Items Summary */}
                {selectedDates.length > 0 && (
                  <div className="bg-blue-50/50 rounded-xl p-3 border border-blue-100 animate-fade-in">
                    <h4 className="text-xs font-black text-blue-800 flex items-center justify-between mb-2">
                      <span>Order Summary ({['Weekly', 'Monthly'].includes(scheduleFilter) ? `${selectedDates.length} days` : '1 day'})</span>
                      <span className="bg-white px-2 py-0.5 rounded-md border border-blue-200">{cartItems?.length || 0} items</span>
                    </h4>
                    
                    {(!cartItems || cartItems.length === 0) ? (
                      <div className="text-center py-5 bg-white rounded-lg border border-blue-100 border-dashed">
                        <ShoppingBag className="w-8 h-8 text-blue-200 mx-auto mb-2" />
                        <p className="text-[10px] font-bold text-gray-500">Your cart is empty.</p>
                        <p className="text-[9px] text-gray-400 mb-3">Add items to schedule a delivery.</p>
                        <button 
                          onClick={onStartScheduledShopping}
                          className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white text-[10px] font-black px-5 py-2 rounded-full shadow-sm transition-all active:scale-95"
                        >
                          Go to Store
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1.5 mb-3 max-h-32 overflow-y-auto no-scrollbar">
                          {cartItems.map((item, idx) => (
                            <div key={idx} className="flex justify-between items-center text-xs font-bold bg-white p-2 rounded-lg shadow-xs border border-blue-50">
                              <span className="text-gray-700 flex items-center gap-1.5">
                                <span className="bg-blue-100 text-blue-700 w-4 h-4 flex items-center justify-center rounded text-[9px]">{item.quantity}</span>
                                {item.name}
                              </span>
                              <span className="text-gray-900">₹{item.price * item.quantity}</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between font-black text-sm pt-2 border-t border-blue-200 mb-3">
                          <span className="text-gray-800">Total {['Weekly', 'Monthly'].includes(scheduleFilter) ? `for ${selectedDates.length} days` : ''}:</span>
                          <span className="text-blue-700">
                            ₹{(cartItems.reduce((acc, i) => acc + (i.price * i.quantity), 0)) * (['Weekly', 'Monthly'].includes(scheduleFilter) ? selectedDates.length : 1)}
                          </span>
                        </div>
                        
                        <button
                          onClick={handleScheduleCart}
                          className={`w-full font-black py-3 rounded-xl shadow-md transition-all flex items-center justify-center gap-2 ${
                            (scheduleFilter === 'Weekly' && selectedDates.length < 3) || (scheduleFilter === 'Monthly' && selectedDates.length < 15)
                              ? 'bg-gray-300 text-gray-500 cursor-not-allowed opacity-70'
                              : 'bg-blue-600 hover:bg-blue-700 text-white active:scale-95'
                          }`}
                        >
                          Schedule Delivery <ChevronRight className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Filtered Results */}
            {filteredSchedules.length === 0 ? (
              <div className="bg-white rounded-3xl p-8 text-center shadow-lg border border-gray-100 mt-2 animate-scale-in">
                <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <RotateCw className="w-10 h-10 text-amber-400" />
                </div>
                <h3 className="font-bold text-lg text-gray-800 mb-2">
                  {scheduleFilter === 'All' ? 'No Active Schedules' : `No ${scheduleFilter} Schedules`}
                </h3>
                <p className="text-sm text-gray-500 mb-6">
                  {scheduleFilter === 'All' 
                    ? 'Subscribe to your daily essentials to automate your deliveries!' 
                    : `You don't have any ${scheduleFilter.toLowerCase()} delivery schedules yet.`}
                </p>
                <button
                  onClick={onGoHome}
                  className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-bold py-3 px-6 rounded-2xl shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 mx-auto w-full"
                >
                  Explore Essentials <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                <h3 className="font-black text-gray-400 text-xs uppercase tracking-widest pl-2 mb-2 mt-4">Existing Schedules</h3>
                {filteredSchedules.map((schedule) => {
                  const freqStyle = getFrequencyStyle(schedule.frequency);
                  return (
                    <div key={schedule.id} className={`bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 transition-all relative overflow-hidden group animate-fade-in mb-4 ${schedule.status === 'Paused' ? 'opacity-70' : ''}`}>
                      
                      {/* Frequency ribbon */}
                      <div className={`absolute -right-8 top-4 rotate-45 text-[9px] font-black uppercase tracking-wider py-1 px-10 text-white shadow-sm ${freqStyle.bg}`}>
                        {schedule.frequency}
                      </div>
                      
                      {/* Header row */}
                      <div className="flex justify-between items-start mb-3 pr-12">
                        <div>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-xs font-black text-gray-900 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200 shadow-xs">
                              {schedule.id}
                            </span>
                            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                              schedule.status === 'Active' 
                                ? 'bg-emerald-100 text-emerald-800 border-emerald-200' 
                                : 'bg-amber-100 text-amber-800 border-amber-200'
                            }`}>
                              <RotateCw className={`w-3 h-3 ${schedule.status === 'Active' ? 'animate-spin' : ''}`} style={schedule.status === 'Active' ? { animationDuration: '3s' } : {}} /> 
                              {schedule.status}
                            </span>
                          </div>
                          
                          {/* Frequency label */}
                          <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${freqStyle.badge}`}>
                            {freqStyle.label}
                          </span>
                          
                          <div className="flex items-center gap-1 text-[11px] text-gray-500 font-bold mt-2">
                            <CalendarRange className="w-3.5 h-3.5 text-[#1B4D3E]" />
                            <span>Next Delivery: <span className="text-[#1B4D3E] font-extrabold">{new Date(schedule.nextDeliveryDate).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span></span>
                          </div>
                        </div>
                        <div className="text-right mt-1">
                          <span className="text-lg font-black text-[#1B4D3E] flex items-center justify-end">
                            <IndianRupee className="w-4 h-4" />
                            {schedule.totalAmount}
                          </span>
                          <span className="text-[9px] text-gray-400 font-bold uppercase">per {schedule.frequency === 'Daily' ? 'day' : schedule.frequency === 'Weekly' ? 'week' : 'month'}</span>
                        </div>
                      </div>

                      {/* Items */}
                      <div className="bg-[#FAF7F2] rounded-xl p-3 border border-[#EAE3D2] shadow-inner mb-3">
                        <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                          <Package className="w-3 h-3" /> Subscribed Items
                        </h4>
                        <div className="space-y-1.5">
                          {schedule.items.map((item, idx) => (
                            <div key={idx} className="flex justify-between text-xs font-bold">
                              <span className="text-gray-700">{item.quantity}x {item.name}</span>
                              <span className="text-gray-900">₹{item.price * item.quantity}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 pt-1">
                        <button 
                          onClick={() => toggleScheduleStatus(schedule.id)}
                          className={`flex-1 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm border active:scale-95 ${
                            schedule.status === 'Active' 
                              ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                          }`}
                        >
                          {schedule.status === 'Active' ? (
                            <><PauseCircle className="w-4 h-4" /> Pause Delivery</>
                          ) : (
                            <><PlayCircle className="w-4 h-4" /> Resume Delivery</>
                          )}
                        </button>
                        <button 
                          onClick={() => deleteSchedule(schedule.id)}
                          className="p-2.5 rounded-xl text-rose-500 bg-rose-50 border border-rose-100 hover:bg-rose-100 transition-all shadow-sm active:scale-95"
                          title="Cancel Subscription"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>

      {/* Live Order Tracking Modal */}
      {trackingModalOrder && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[2000] flex items-end justify-center" onClick={() => setTrackingModalOrder(null)}>
          <div className="bg-white w-full max-w-md rounded-t-3xl shadow-2xl overflow-hidden animate-slide-up" onClick={e => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-[#1B4D3E] to-emerald-600 text-white px-5 py-4 flex items-center justify-between">
              <div>
                <p className="font-black text-base">🚴 Live Order Tracking</p>
                <p className="text-emerald-200 text-xs">Order #{trackingModalOrder.id} • {trackingModalOrder.customerName}</p>
              </div>
              <button onClick={() => setTrackingModalOrder(null)} className="p-1.5 bg-white/20 rounded-full">
                <X className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Status bar */}
            <div className="px-4 py-2 bg-emerald-50 border-b border-emerald-100 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
              <p className="text-xs font-bold text-emerald-800">Delivery agent is on the way to your location</p>
            </div>

            {/* Map */}
            <div ref={trackingMapRef} className="w-full" style={{ height: '320px' }} />

            {/* Address bar */}
            <div className="px-4 py-3 flex items-start gap-2 border-t border-gray-100">
              <MapPin className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] text-gray-400 font-bold uppercase">Delivering to</p>
                <p className="text-xs font-semibold text-gray-700">{trackingModalOrder.deliveryAddress || trackingModalOrder.address}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
