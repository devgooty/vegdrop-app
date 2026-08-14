import React, { useState, useEffect } from 'react';
import { setScheduleStatus, cancelSchedule, describeRecurrence } from '../services/schedules';
import { Package, Clock, IndianRupee, MapPin, ArrowRight, ShoppingBag, CalendarRange, RotateCw, PauseCircle, PlayCircle, Trash2, CalendarDays, CalendarClock, Calendar as CalendarIcon, ChevronRight, Navigation, X, AlertTriangle } from 'lucide-react';

/**
 * Plain-language labels for the market fulfillment stages.
 *
 * The coarse status underneath says "Pending" for everything from "just placed"
 * to "stalls are deciding", which tells a waiting customer nothing. These say
 * what is actually happening to their vegetables.
 */
const MARKET_STAGE = {
  sourcing: 'Finding a stall',
  partial_review: 'Needs your answer',
  packing: 'Being packed',
  awaiting_rider: 'Ready for pickup',
  collecting: 'Rider collecting',
  dispatched: 'On the way',
  delivered: 'Delivered',
  failed: 'Could not fill',
  cancelled: 'Cancelled',
};

/**
 * The journey an order makes, in the order it makes it.
 *
 * Mirrors the server's `fulfillment.status` values rather than inventing a
 * parallel vocabulary, so a stage is marked reached only when the server says
 * the order actually reached it.
 */
const ORDER_STAGES = [
  { key: 'sourcing', label: 'Finding a stall', hint: 'Stalls in the market are deciding who can fill this.' },
  { key: 'packing', label: 'Being packed', hint: 'Your vegetables are being bagged.' },
  { key: 'awaiting_rider', label: 'Waiting for a rider', hint: 'Packed, and waiting for someone to collect it.' },
  { key: 'collecting', label: 'Rider collecting', hint: 'A rider is walking the stalls to pick everything up.' },
  { key: 'dispatched', label: 'On the way', hint: 'It has left the market.' },
  { key: 'delivered', label: 'Delivered', hint: '' },
];

/** Whether a stage is done, current, or still ahead. */
function stageState(order, key) {
  const current = order.fulfillmentStatus;

  // A legacy order has no fulfilment detail, so it is placed against the coarse
  // status instead of being shown as stuck at the first stage forever.
  if (!current) {
    const coarse = { Pending: 'sourcing', Preparing: 'packing', 'Out for Delivery': 'dispatched', Delivered: 'delivered' };
    const mapped = coarse[order.status];
    if (!mapped) return 'pending';
    const at = ORDER_STAGES.findIndex((s) => s.key === mapped);
    const index = ORDER_STAGES.findIndex((s) => s.key === key);
    return index < at ? 'done' : index === at ? 'current' : 'pending';
  }

  const at = ORDER_STAGES.findIndex((s) => s.key === current);
  const index = ORDER_STAGES.findIndex((s) => s.key === key);
  if (at === -1) return 'pending';
  return index < at ? 'done' : index === at ? 'current' : 'pending';
}

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
  onGoHome,
  /** Only offered while stalls are still deciding — see the card below. */
  onCancelOrder,
  /**
   * Answers to "only some of your items are available".
   *
   * Both optional: if neither is wired the card still explains the situation,
   * and the server settles it on the customer's behalf when the decision window
   * lapses. A missing handler must never leave someone stuck.
   */
  onAcceptPartial,
  onRetryPartial,
}) {
  const [activeTab, setActiveTab] = useState('recent');
  const [trackingModalOrder, setTrackingModalOrder] = useState(null);
  const [busyScheduleId, setBusyScheduleId] = useState(null);
  const [scheduleError, setScheduleError] = useState(null);
  /**
   * The simulated rider that used to live here is gone.
   *
   * It built a Leaflet map behind an `if (!window.L) return` guard — a global
   * that does not exist, so it never drew a single tile — and then animated a
   * green dot from a point 800 m north of the customer towards their door over
   * thirty timer ticks. It was not the rider, and it was not moving.
   *
   * Nothing in this system can tell a customer where their rider is: the order
   * carries `assignedTo`, not a position, and a rider's live coordinates are
   * deliberately never exposed outside dispatch (see the note on User.rider).
   * A tracking screen that invents the one thing it exists to show is worse
   * than one that admits it does not know.
   *
   * So the modal below reports what is actually known — which stage the order
   * has reached, and the address it is going to.
   */

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

  /**
   * Pausing and cancelling go to the server.
   *
   * Both used to edit a local array — the schedule "paused" on screen and went
   * on doing nothing, because it had never been anywhere to pause. The server's
   * answer is applied to the list rather than a guess about what it will be,
   * since resuming recomputes the next date and only it knows what that is.
   */
  const toggleScheduleStatus = async (schedule) => {
    if (!setScheduledOrders) return;
    setBusyScheduleId(schedule.id);
    try {
      const updated = await setScheduleStatus(
        schedule.id,
        schedule.status === 'active' ? 'paused' : 'active'
      );
      setScheduledOrders((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setScheduleError(err.message || 'Could not change that repeat delivery.');
    } finally {
      setBusyScheduleId(null);
    }
  };

  const deleteSchedule = async (scheduleId) => {
    if (!setScheduledOrders) return;
    if (!window.confirm('Stop this repeat delivery? Orders already placed are unaffected.')) return;

    setBusyScheduleId(scheduleId);
    try {
      await cancelSchedule(scheduleId);
      setScheduledOrders((prev) => prev.filter((s) => s.id !== scheduleId));
    } catch (err) {
      setScheduleError(err.message || 'Could not stop that repeat delivery.');
    } finally {
      setBusyScheduleId(null);
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
      // The filter buttons are labelled Daily/Weekly/Monthly; the server
      // stores the lowercase form.
      return s.frequency === String(scheduleFilter).toLowerCase();
    })
    .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));

  const filterButtons = [
    { key: 'All', label: 'All', icon: CalendarRange, color: 'text-[#1B4D3E]' },
    { key: 'Daily', label: 'Daily', icon: CalendarDays, color: 'text-blue-600' },
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
      <div className="bg-[#1B4D3E] text-white pt-safe-6 pb-4 px-4 shadow-lg sticky top-0 z-20">
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
                <p className="text-sm text-gray-500 mb-6">You haven't placed any orders with VegDrop yet. Start exploring fresh produce!</p>
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
                          {MARKET_STAGE[order.fulfillmentStatus] || order.status}
                        </span>
                      </div>
                      {order.marketName && (
                        <p className="text-[10px] font-bold text-[#1B4D3E] mb-1">{order.marketName}</p>
                      )}
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

                  {/*
                    Market orders: say what is actually happening, and offer
                    cancel only while it is genuinely still possible.

                    Once a stall accepts, the produce is set aside and the order
                    locks. The button DISAPPEARS at that point rather than
                    failing when tapped — a button that exists but always errors
                    is worse than no button.
                  */}
                  {order.fulfillmentStatus === 'sourcing' && (
                    <div className="mt-3 space-y-2">
                      <div className="flex items-start gap-2 text-[11px] font-semibold text-amber-800 bg-amber-50 p-2.5 rounded-xl border border-amber-200">
                        <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <p className="leading-snug">
                          {order.sourcingAttempt > 1
                            ? `Checking another market nearby (try ${order.sourcingAttempt}).`
                            : 'Finding a stall to fill your order. This usually takes under a minute.'}
                        </p>
                      </div>
                      {onCancelOrder && (
                        <button
                          onClick={() => onCancelOrder(order)}
                          className="w-full py-2.5 border border-rose-200 text-rose-700 font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          Cancel order
                        </button>
                      )}
                    </div>
                  )}

                  {/*
                    The market found some of the order but not all of it.

                    Both options are offered plainly, with the money spelled
                    out, because this is a decision about what they pay for. If
                    they say nothing, the server sends what it has and refunds
                    the rest — so the copy must not imply the order is stuck.
                  */}
                  {order.awaitingPartialChoice && (
                    <div className="mt-3 space-y-2">
                      <div className="text-[11px] font-semibold text-amber-900 bg-amber-50 p-3 rounded-xl border border-amber-200">
                        <div className="flex items-start gap-2">
                          <PauseCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <p className="leading-snug">
                            {order.availableItems.length} of{' '}
                            {order.availableItems.length + order.unavailableItems.length} items are
                            available here.
                          </p>
                        </div>

                        {order.unavailableItems.length > 0 && (
                          <p className="mt-2 leading-snug font-medium text-amber-800">
                            Not available:{' '}
                            {order.unavailableItems
                              .map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`)
                              .join(', ')}
                            .
                          </p>
                        )}
                      </div>

                      {onAcceptPartial && (
                        <button
                          onClick={() => onAcceptPartial(order)}
                          className="w-full py-2.5 bg-[#0B7A37] text-white font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          Send the {order.availableItems.length} available
                          {order.unavailableValue > 0 &&
                            (order.alreadyPaid
                              ? ` · ₹${order.unavailableValue} back`
                              : ` · pay ₹${order.unavailableValue} less`)}
                        </button>
                      )}

                      {onRetryPartial && (
                        <button
                          onClick={() => onRetryPartial(order)}
                          className="w-full py-2.5 border border-[#0B7A37] text-[#0B7A37] font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          Try another market for everything
                        </button>
                      )}

                      {onCancelOrder && (
                        <button
                          onClick={() => onCancelOrder(order)}
                          className="w-full py-2.5 border border-rose-200 text-rose-700 font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          Cancel order
                        </button>
                      )}
                    </div>
                  )}

                  {order.fulfillmentStatus === 'packing' && (
                    <div className="mt-3 flex items-start gap-2 text-[11px] font-semibold text-emerald-800 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                      <Package className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">
                        Accepted — your order is being packed and can no longer be cancelled.
                        {order.droppedItems.length > 0 &&
                          ` ${order.droppedItems.map((i) => i.name).join(', ')} could not be sourced and ${
                            order.droppedItems.length === 1 ? 'was' : 'were'
                          } ${
                            order.droppedItems.some((i) => i.refunded > 0) ? 'refunded' : 'removed'
                          }.`}
                      </p>
                    </div>
                  )}

                  {order.fulfillmentStatus === 'awaiting_rider' && (
                    <div className="mt-3 flex items-start gap-2 text-[11px] font-semibold text-emerald-800 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                      <Package className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">Packed and waiting for a rider.</p>
                    </div>
                  )}

                  {order.fulfillmentStatus === 'collecting' && (
                    <div className="mt-3 flex items-start gap-2 text-[11px] font-semibold text-emerald-800 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                      <Navigation className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">Your rider is collecting from the stalls.</p>
                    </div>
                  )}

                  {order.fulfillmentStatus === 'failed' && (
                    <div className="mt-3 flex items-start gap-2 text-[11px] font-semibold text-rose-800 bg-rose-50 p-2.5 rounded-xl border border-rose-200">
                      <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">
                        No stall nearby could fill this one, so it was cancelled and your money
                        refunded. Try a different market.
                      </p>
                    </div>
                  )}

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
            {/*
              The warning that stood here — "plans only, not yet placed" — was
              true when schedules lived in React state and nothing turned one
              into a delivery. They are now real records the server acts on, so
              the honest thing to show is the failure of an individual schedule,
              which is the case that actually needs explaining.
            */}
            {scheduleError && (
              <div
                role="alert"
                className="mb-4 bg-red-50 border border-red-200 rounded-2xl p-3 text-[12.5px] text-red-800 font-medium"
              >
                {scheduleError}
              </div>
            )}

            {/* Frequency Filter Buttons */}
            <div className="flex flex-col gap-2 pb-4">
              {filterButtons.map(btn => {
                const Icon = btn.icon;
                const isActive = scheduleFilter === btn.key;
                const count = btn.key === 'All' 
                  ? (scheduledOrders || []).length 
                  : (scheduledOrders || []).filter(s => s.frequency === String(btn.key).toLowerCase()).length;
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

                {/* Once a single delivery day is picked, the full grid just repeats
                    the same answer back — collapse it to the date itself. */}
                {scheduleFilter === 'Daily' && selectedDates.length > 0 ? (
                  <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 mb-4 flex items-center justify-between animate-scale-in">
                    <div className="flex items-center gap-3">
                      <div className="bg-white rounded-xl p-2.5 shadow-sm border border-blue-100">
                        <CalendarIcon className="w-5 h-5 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-blue-500 uppercase tracking-wider">Delivery Date</p>
                        <p className="font-black text-gray-800 text-sm">
                          {new Date(selectedDates[0]).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedDates([])}
                      className="text-xs font-bold text-blue-600 hover:text-blue-800 underline"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
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
                  </>
                )}

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
                    <div key={schedule.id} className={`bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 transition-all relative overflow-hidden group animate-fade-in mb-4 ${schedule.status === 'paused' ? 'opacity-70' : ''}`}>
                      
                      {/* Frequency ribbon */}
                      <div className={`absolute -right-8 top-4 rotate-45 text-[9px] font-black uppercase tracking-wider py-1 px-10 text-white shadow-sm ${freqStyle.bg}`}>
                        {String(schedule.frequency).replace(/^./, (c) => c.toUpperCase())}
                      </div>
                      
                      {/* Header row */}
                      <div className="flex justify-between items-start mb-3 pr-12">
                        <div>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-xs font-black text-gray-900 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200 shadow-xs">
                              {schedule.id}
                            </span>
                            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                              schedule.status === 'active' 
                                ? 'bg-emerald-100 text-emerald-800 border-emerald-200' 
                                : 'bg-amber-100 text-amber-800 border-amber-200'
                            }`}>
                              <RotateCw className={`w-3 h-3 ${schedule.status === 'active' ? 'animate-spin' : ''}`} style={schedule.status === 'active' ? { animationDuration: '3s' } : {}} /> 
                              {schedule.status === 'active' ? 'Active' : 'Paused'}
                            </span>
                          </div>
                          
                          {/* Frequency label */}
                          <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${freqStyle.badge}`}>
                            {freqStyle.label}
                          </span>
                          
                          <div className="flex items-center gap-1 text-[11px] text-gray-500 font-bold mt-2">
                            <CalendarRange className="w-3.5 h-3.5 text-[#1B4D3E]" />
                            <span>Next Delivery: <span className="text-[#1B4D3E] font-extrabold">{new Date(schedule.nextRunAt).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span></span>
                          </div>
                        </div>
                        {/*
                          No total here, deliberately.

                          This used to print a rupee figure computed in the
                          browser at the moment the schedule was created — the
                          basket price multiplied by the number of dates ticked.
                          A standing order has no total: each delivery is priced
                          from the market's sheet on the morning it ships, which
                          is the only honest answer for vegetables ordered weeks
                          ahead. What it recurs on is the useful fact.
                        */}
                        <div className="text-right mt-1 max-w-[45%]">
                          <span className="text-[11px] font-black text-[#1B4D3E] block leading-tight">
                            {describeRecurrence(schedule)}
                          </span>
                          <span className="text-[9px] text-gray-400 font-bold uppercase">
                            priced on the day
                          </span>
                        </div>
                      </div>

                      {/* Items */}
                      <div className="bg-[#FAF7F2] rounded-xl p-3 border border-[#EAE3D2] shadow-inner mb-3">
                        <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                          <Package className="w-3 h-3" /> Subscribed Items
                        </h4>
                        <div className="space-y-1.5">
                          {/* Quantities and names, no line prices — the same
                              reason the card carries no total. */}
                          {schedule.items.map((item, idx) => (
                            <div key={idx} className="flex justify-between text-xs font-bold">
                              <span className="text-gray-700">
                                {item.quantity}x {item.name || 'Item'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Why nothing arrived, when that is the case. */}
                      {schedule.lastFailure && (
                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                          <p className="text-[11px] text-amber-900 leading-snug">
                            {schedule.lastFailure.message}
                          </p>
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 pt-1">
                        <button 
                          onClick={() => toggleScheduleStatus(schedule)}
                          disabled={busyScheduleId === schedule.id}
                          className={`flex-1 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm border active:scale-95 ${
                            schedule.status === 'active' 
                              ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                          }`}
                        >
                          {schedule.status === 'active' ? (
                            <><PauseCircle className="w-4 h-4" /> Pause Delivery</>
                          ) : (
                            <><PlayCircle className="w-4 h-4" /> Resume Delivery</>
                          )}
                        </button>
                        <button 
                          onClick={() => deleteSchedule(schedule.id)}
                          disabled={busyScheduleId === schedule.id}
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
                <p className="font-black text-base">Order progress</p>
                <p className="text-emerald-200 text-xs">Order #{trackingModalOrder.id} • {trackingModalOrder.customerName}</p>
              </div>
              <button onClick={() => setTrackingModalOrder(null)} className="p-1.5 bg-white/20 rounded-full">
                <X className="w-5 h-5 text-white" />
              </button>
            </div>

            {/*
              The stages the order has actually reached.

              This replaced a banner reading "Delivery agent is on the way to
              your location", shown regardless of state — including while stalls
              were still deciding whether they could fill the order at all — and
              a 320px map drawing a rider whose position nobody knows.
            */}
            <ol className="px-5 py-4 space-y-3">
              {ORDER_STAGES.map((stage) => {
                const state = stageState(trackingModalOrder, stage.key);
                return (
                  <li key={stage.key} className="flex items-start gap-3">
                    <span
                      className={`w-5 h-5 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-[10px] font-black ${
                        state === 'done'
                          ? 'bg-emerald-500 text-white'
                          : state === 'current'
                            ? 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-400'
                            : 'bg-gray-100 text-gray-300'
                      }`}
                    >
                      {state === 'done' ? '✓' : ''}
                    </span>
                    <div className="min-w-0">
                      <p
                        className={`text-[13px] font-bold ${
                          state === 'pending' ? 'text-gray-400' : 'text-gray-900'
                        }`}
                      >
                        {stage.label}
                      </p>
                      {state === 'current' && (
                        <p className="text-[11.5px] text-emerald-700">{stage.hint}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

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
