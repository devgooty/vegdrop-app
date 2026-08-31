import React, { useState, useEffect } from 'react';
import { setScheduleStatus, cancelSchedule, describeRecurrence } from '../services/schedules';
import { isFeatureEnabled } from '../services/apiClient';
import { Package, Clock, IndianRupee, MapPin, ArrowRight, ShoppingBag, CalendarRange, RotateCw, PauseCircle, PlayCircle, Trash2, CalendarDays, CalendarClock, Calendar as CalendarIcon, ChevronRight, Navigation, X, AlertTriangle, Lock } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { dateLocale } from '../i18n/catalog';

/**
 * Plain-language labels for the market fulfillment stages.
 *
 * The coarse status underneath says "Pending" for everything from "just placed"
 * to "stalls are deciding", which tells a waiting customer nothing. These say
 * what is actually happening to their vegetables.
 */
const MARKET_STAGE_KEY = {
  sourcing: 'stage.sourcing',
  partial_review: 'stage.partial_review',
  packing: 'stage.packing',
  awaiting_rider: 'stage.awaiting_rider',
  collecting: 'stage.collecting',
  dispatched: 'stage.dispatched',
  delivered: 'stage.delivered',
  failed: 'stage.failed',
  cancelled: 'stage.cancelled',
};

/**
 * The journey an order makes, in the order it makes it.
 *
 * Mirrors the server's `fulfillment.status` values rather than inventing a
 * parallel vocabulary, so a stage is marked reached only when the server says
 * the order actually reached it.
 */
const ORDER_STAGES = [
  { key: 'sourcing', labelKey: 'stage.sourcing', hintKey: 'stage.hint.sourcing' },
  { key: 'packing', labelKey: 'stage.packing', hintKey: 'stage.hint.packing' },
  // Longer wording than the badge's "Ready for pickup": on a progress list the
  // stage is read as what is happening, not as a status chip.
  { key: 'awaiting_rider', labelKey: 'stage.awaitingRiderLong', hintKey: 'stage.hint.awaiting_rider' },
  { key: 'collecting', labelKey: 'stage.collecting', hintKey: 'stage.hint.collecting' },
  { key: 'dispatched', labelKey: 'stage.dispatched', hintKey: 'stage.hint.dispatched' },
  { key: 'delivered', labelKey: 'stage.delivered', hintKey: null },
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
  const { t, language } = useLanguage();
  /**
   * The Scheduled Deliveries tab is locked off deployment-wide until
   * SCHEDULED_ORDERS_UNLOCK=1 is set on the API. The server refuses to create a
   * schedule and the sweeper places none while that is so; this only decides
   * what the screen offers.
   *
   * `activeTab` therefore cannot start on, or stay on, a locked tab — the state
   * outlives a re-render and the flag can arrive after mount.
   */
  const scheduledUnlocked = isFeatureEnabled('scheduledOrders');
  const [activeTab, setActiveTab] = useState('recent');

  useEffect(() => {
    if (!scheduledUnlocked && activeTab === 'scheduled') setActiveTab('recent');
  }, [scheduledUnlocked, activeTab]);
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

  // `'default'` is the browser's locale, not the app's — a calendar on a screen
  // set to Telugu was labelled "Aug - Sept" because the phone happened to be
  // en-US. The weekday strip below is derived the same way rather than from a
  // hardcoded ['Su', 'Mo', …], which had the same problem.
  const calendarLocale = dateLocale(language);
  const startMonth = daysArray[0].toLocaleString(calendarLocale, { month: 'short' });
  const endMonth = daysArray[daysArray.length - 1].toLocaleString(calendarLocale, { month: 'short' });
  const calendarTitle = startMonth === endMonth ? `${startMonth} ${today.getFullYear()}` : `${startMonth} - ${endMonth} ${today.getFullYear()}`;

  // 2024-01-07 was a Sunday, so index 0..6 walks Sunday through Saturday.
  const weekdayHeadings = React.useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Date(Date.UTC(2024, 0, 7 + i)).toLocaleDateString(calendarLocale, {
          weekday: 'short',
          timeZone: 'UTC',
        })
      ),
    [calendarLocale]
  );

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
      setScheduleError(err.message || t('sched.errChange'));
    } finally {
      setBusyScheduleId(null);
    }
  };

  const deleteSchedule = async (scheduleId) => {
    if (!setScheduledOrders) return;
    if (!window.confirm(t('sched.confirmStop'))) return;

    setBusyScheduleId(scheduleId);
    try {
      await cancelSchedule(scheduleId);
      setScheduledOrders((prev) => prev.filter((s) => s.id !== scheduleId));
    } catch (err) {
      setScheduleError(err.message || t('sched.errStop'));
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
          alert(t('sched.maxWeekly'));
          return;
        }
        setSelectedDates(prev => [...prev, dateStr].sort());
      }
    } else if (scheduleFilter === 'Monthly') {
      if (selectedDates.includes(dateStr)) {
        setSelectedDates(prev => prev.filter(d => d !== dateStr));
      } else {
        if (selectedDates.length >= 30) {
          alert(t('sched.maxMonthly'));
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

  // `key` stays English — it is compared against the server's `frequency` and
  // used to build state — while `labelKey` is what the button actually shows.
  const filterButtons = [
    { key: 'All', labelKey: 'sched.all', icon: CalendarRange, color: 'text-[#1B4D3E]' },
    { key: 'Daily', labelKey: 'sched.daily', icon: CalendarDays, color: 'text-blue-600' },
    { key: 'Weekly', labelKey: 'sched.weekly', icon: CalendarClock, color: 'text-purple-600' },
    { key: 'Monthly', labelKey: 'sched.monthly', icon: CalendarIcon, color: 'text-amber-600' },
  ];

  /** The Daily/Weekly/Monthly filter word, for a sentence that names it. */
  const frequencyWord = (key) =>
    t({ Daily: 'sched.daily', Weekly: 'sched.weekly', Monthly: 'sched.monthly' }[key] || 'sched.all');

  const getFrequencyStyle = (frequency) => {
    switch (frequency) {
      case 'Daily': return { bg: 'bg-blue-500', badge: 'bg-blue-100 text-blue-800 border-blue-200', label: t('sched.dailyDelivery') };
      case 'Weekly': return { bg: 'bg-purple-500', badge: 'bg-purple-100 text-purple-800 border-purple-200', label: t('sched.weeklyDelivery') };
      case 'Monthly': return { bg: 'bg-amber-500', badge: 'bg-amber-100 text-amber-800 border-amber-200', label: t('sched.monthlyDelivery') };
      default: return { bg: 'bg-gray-400', badge: 'bg-gray-100 text-gray-800 border-gray-200', label: t('sched.generic') };
    }
  };

  return (
    <div className="animate-fade-in pb-12 bg-[#F4F7F5] min-h-[calc(100dvh-4rem-env(safe-area-inset-bottom,0px))]">
      {/* Fresh mint wash + leaf-green ink — the sign-in palette, not cream or forest. */}
      <div className="bg-gradient-to-b from-[#E7F6EE] to-[#F4F7F5] pt-safe-6 pb-4 px-4 sticky top-0 z-20">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-2xl bg-[#FFC531] flex items-center justify-center shadow-[0_2px_8px_rgba(255,197,49,0.45)]">
            <Package className="w-5 h-5 text-[#0B7A37]" strokeWidth={2.4} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-[#0F1F17]">{t('orders.title')}</h1>
            <p className="text-[#5B6B62] text-xs font-medium">{t('orders.subtitle')}</p>
          </div>
        </div>

        {/* Main Tabs */}
        <div className="flex bg-[#D8F0E3] p-1 rounded-full">
          <button
            onClick={() => setActiveTab('recent')}
            className={`flex-1 py-2.5 text-xs font-bold rounded-full transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'recent'
                ? 'bg-white text-[#0B7A37] shadow-[0_1px_4px_rgba(11,122,55,0.18)]'
                : 'text-[#3D5C4A] hover:text-[#0B7A37]'
            }`}
          >
            <Clock className="w-3.5 h-3.5" /> {t('orders.tabRecent')}
          </button>
          <button
            onClick={() => scheduledUnlocked && setActiveTab('scheduled')}
            disabled={!scheduledUnlocked}
            aria-disabled={!scheduledUnlocked}
            title={scheduledUnlocked ? undefined : t('orders.scheduledLocked')}
            className={`flex-1 py-2.5 text-xs font-bold rounded-full transition-all flex items-center justify-center gap-1.5 ${
              !scheduledUnlocked
                ? 'text-[#8AA396] cursor-not-allowed'
                : activeTab === 'scheduled'
                ? 'bg-white text-[#0B7A37] shadow-[0_1px_4px_rgba(11,122,55,0.18)]'
                : 'text-[#3D5C4A] hover:text-[#0B7A37]'
            }`}
          >
            {scheduledUnlocked ? <CalendarRange className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
            {t('orders.tabScheduled')}
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4 pt-4">
        
        {/* ==================== RECENT ORDERS TAB ==================== */}
        {activeTab === 'recent' && (
          <>
            {orders.length === 0 ? (
              <div className="bg-white rounded-3xl p-8 text-center shadow-sm border border-[#E4EAE6] mt-2 animate-scale-in">
                <div className="w-20 h-20 bg-[#DCFCE7] rounded-full flex items-center justify-center mx-auto mb-4">
                  <ShoppingBag className="w-10 h-10 text-[#16A34A]" />
                </div>
                <h3 className="font-bold text-lg text-[#0F1F17] mb-2">{t('orders.noneTitle')}</h3>
                <p className="text-sm text-[#5B6B62] mb-6">{t('orders.noneBody')}</p>
                <button
                  onClick={onGoHome}
                  className="bg-[#0B7A37] hover:bg-[#08652C] text-white font-bold py-3 px-6 rounded-2xl shadow-[0_4px_12px_-4px_rgba(11,122,55,0.55)] transition-all active:scale-95 flex items-center justify-center gap-2 mx-auto w-full"
                >
                  {t('orders.startShopping')} <ArrowRight className="w-4 h-4" />
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
                        <span className={`text-[11.5px] font-extrabold px-2 py-0.5 rounded-full border ${getStatusColor(order.status)}`}>
                          {MARKET_STAGE_KEY[order.fulfillmentStatus]
                            ? t(MARKET_STAGE_KEY[order.fulfillmentStatus])
                            : order.status}
                        </span>
                      </div>
                      {order.marketName && (
                        <p className="text-[11.5px] font-bold text-[#1B4D3E] mb-1">{order.marketName}</p>
                      )}
                      <div className="flex items-center gap-1 text-[11.5px] text-gray-500 font-semibold">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(order.timestamp).toLocaleString(dateLocale(language))}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-black text-[#1B4D3E] flex items-center justify-end drop-shadow-sm">
                        <IndianRupee className="w-4 h-4" />
                        {order.totalAmount}
                      </span>
                      <span className="text-[10.5px] text-gray-400 font-bold uppercase tracking-wider">{order.paymentMethod || t('orders.online')}</span>
                    </div>
                  </div>

                  <div className="bg-[#FAF7F2] rounded-xl p-3 border border-[#EAE3D2] shadow-inner mb-3">
                    <h4 className="text-[11.5px] font-black text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                      <Package className="w-3 h-3" /> {t('orders.orderItems')}
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
                      <div className="flex items-start gap-2 text-[12.5px] font-semibold text-amber-800 bg-amber-50 p-2.5 rounded-xl border border-amber-200">
                        <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <p className="leading-snug">
                          {order.sourcingAttempt > 1
                            ? t('orders.sourcingRetry', { attempt: order.sourcingAttempt })
                            : t('orders.sourcingFirst')}
                        </p>
                      </div>
                      {onCancelOrder && (
                        <button
                          onClick={() => onCancelOrder(order)}
                          className="w-full py-2.5 border border-rose-200 text-rose-700 font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          {t('orders.cancel')}
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
                      <div className="text-[12.5px] font-semibold text-amber-900 bg-amber-50 p-3 rounded-xl border border-amber-200">
                        <div className="flex items-start gap-2">
                          <PauseCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <p className="leading-snug">
                            {t('orders.partialAvailable', {
                              available: order.availableItems.length,
                              total:
                                order.availableItems.length + order.unavailableItems.length,
                            })}
                          </p>
                        </div>

                        {order.unavailableItems.length > 0 && (
                          <p className="mt-2 leading-snug font-medium text-amber-800">
                            {t('orders.partialMissing', {
                              items: order.unavailableItems
                                .map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`)
                                .join(', '),
                            })}
                          </p>
                        )}
                      </div>

                      {onAcceptPartial && (
                        <button
                          onClick={() => onAcceptPartial(order)}
                          className="w-full py-2.5 bg-[#0B7A37] text-white font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          {t('orders.partialSend', { count: order.availableItems.length })}
                          {order.unavailableValue > 0 &&
                            t(order.alreadyPaid ? 'orders.partialRefund' : 'orders.partialPayLess', {
                              amount: order.unavailableValue,
                            })}
                        </button>
                      )}

                      {onRetryPartial && (
                        <button
                          onClick={() => onRetryPartial(order)}
                          className="w-full py-2.5 border border-[#0B7A37] text-[#0B7A37] font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          {t('orders.partialRetry')}
                        </button>
                      )}

                      {onCancelOrder && (
                        <button
                          onClick={() => onCancelOrder(order)}
                          className="w-full py-2.5 border border-rose-200 text-rose-700 font-black text-xs rounded-xl active:scale-95 transition-transform"
                        >
                          {t('orders.cancel')}
                        </button>
                      )}
                    </div>
                  )}

                  {/*
                    Shown as soon as a rider has actually accepted the pickup,
                    which for an independent-shop order can be well before
                    Out for Delivery — the shop still has to hand the bags
                    over. Not shown before that: a rider merely picked as
                    nearest has not agreed to anything yet.
                  */}
                  {order.riderName && (
                    <div className="mt-3 flex items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-[11.5px] font-bold text-gray-400 uppercase tracking-wide">
                          Delivery partner
                        </p>
                        <p className="text-xs font-bold text-gray-900 truncate">{order.riderName}</p>
                      </div>
                      {order.riderPhone && (
                        <a
                          href={`tel:${order.riderPhone}`}
                          className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-[12.5px] font-bold active:scale-95 transition-transform"
                        >
                          Call
                        </a>
                      )}
                    </div>
                  )}

                  {order.fulfillmentStatus === 'packing' && (
                    <div className="mt-3 flex items-start gap-2 text-[12.5px] font-semibold text-emerald-800 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                      <Package className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">
                        {t('orders.packingNote')}
                        {order.droppedItems.length > 0 &&
                          t(
                            order.droppedItems.some((i) => i.refunded > 0)
                              ? order.droppedItems.length === 1
                                ? 'orders.droppedRefundedOne'
                                : 'orders.droppedRefundedMany'
                              : order.droppedItems.length === 1
                                ? 'orders.droppedRemovedOne'
                                : 'orders.droppedRemovedMany',
                            { items: order.droppedItems.map((i) => i.name).join(', ') }
                          )}
                      </p>
                    </div>
                  )}

                  {order.fulfillmentStatus === 'awaiting_rider' && (
                    <div className="mt-3 flex items-start gap-2 text-[12.5px] font-semibold text-emerald-800 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                      <Package className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">{t('orders.awaitingRider')}</p>
                    </div>
                  )}

                  {order.fulfillmentStatus === 'collecting' && (
                    <div className="mt-3 flex items-start gap-2 text-[12.5px] font-semibold text-emerald-800 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                      <Navigation className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">{t('orders.collecting')}</p>
                    </div>
                  )}

                  {order.fulfillmentStatus === 'failed' && (
                    <div className="mt-3 flex items-start gap-2 text-[12.5px] font-semibold text-rose-800 bg-rose-50 p-2.5 rounded-xl border border-rose-200">
                      <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <p className="leading-snug">{t('orders.failedNote')}</p>
                    </div>
                  )}

                  {/* Track Your Order button for Out for Delivery */}
                  {order.status === 'Out for Delivery' && (
                    <button
                      onClick={() => setTrackingModalOrder(order)}
                      className="mt-3 w-full py-2.5 bg-gradient-to-r from-[#1B4D3E] to-emerald-600 text-white font-black text-xs rounded-xl shadow-md flex items-center justify-center gap-2 active:scale-95 transition-transform animate-pulse"
                    >
                      <Navigation className="w-4 h-4" />
                      {t('orders.trackLive')}
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
                className="mb-4 bg-red-50 border border-red-200 rounded-2xl p-3 text-[14px] text-red-800 font-medium"
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
                      {t(btn.labelKey)}
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
                    <h3 className="font-black text-gray-800 text-lg">
                      {t(
                        ['Weekly', 'Monthly'].includes(scheduleFilter)
                          ? 'sched.pickDates'
                          : 'sched.pickDate'
                      )}
                    </h3>
                    <p className="text-xs font-bold text-blue-500">
                      {scheduleFilter === 'Weekly'
                        ? t('sched.hintWeekly')
                        : scheduleFilter === 'Monthly'
                          ? t('sched.hintMonthly')
                          : t('sched.hintDaily')}
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
                        <p className="text-[11.5px] font-bold text-blue-500 uppercase tracking-wider">{t('sched.deliveryDate')}</p>
                        <p className="font-black text-gray-800 text-sm">
                          {new Date(selectedDates[0]).toLocaleDateString(dateLocale(language), { weekday: 'long', month: 'short', day: 'numeric' })}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedDates([])}
                      className="text-xs font-bold text-blue-600 hover:text-blue-800 underline"
                    >
                      {t('common.change')}
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Days of week */}
                    <div className="grid grid-cols-7 gap-1 mb-2 text-center text-[11.5px] font-black text-gray-400 uppercase tracking-wider">
                      {weekdayHeadings.map((day, i) => (
                        <div key={i}>{day}</div>
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
                    {3 - selectedDates.length === 1
                      ? t('sched.needMoreOne')
                      : t('sched.needMore', { count: 3 - selectedDates.length })}
                  </div>
                )}
                {scheduleFilter === 'Monthly' && selectedDates.length > 0 && selectedDates.length < 15 && (
                  <div className="text-center text-xs font-bold text-amber-600 bg-amber-50 rounded-lg py-2 mb-4 border border-amber-200">
                    {15 - selectedDates.length === 1
                      ? t('sched.needMoreOne')
                      : t('sched.needMore', { count: 15 - selectedDates.length })}
                  </div>
                )}

                {/* Cart Items Summary */}
                {selectedDates.length > 0 && (
                  <div className="bg-blue-50/50 rounded-xl p-3 border border-blue-100 animate-fade-in">
                    <h4 className="text-xs font-black text-blue-800 flex items-center justify-between mb-2">
                      <span>
                        {['Weekly', 'Monthly'].includes(scheduleFilter)
                          ? t('sched.summaryDays', { count: selectedDates.length })
                          : t('sched.summaryOneDay')}
                      </span>
                      <span className="bg-white px-2 py-0.5 rounded-md border border-blue-200">
                        {t('sched.itemCount', { count: cartItems?.length || 0 })}
                      </span>
                    </h4>
                    
                    {(!cartItems || cartItems.length === 0) ? (
                      <div className="text-center py-5 bg-white rounded-lg border border-blue-100 border-dashed">
                        <ShoppingBag className="w-8 h-8 text-blue-200 mx-auto mb-2" />
                        <p className="text-[11.5px] font-bold text-gray-500">{t('sched.cartEmpty')}</p>
                        <p className="text-[10.5px] text-gray-400 mb-3">{t('sched.cartEmptyHint')}</p>
                        <button 
                          onClick={onStartScheduledShopping}
                          className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white text-[11.5px] font-black px-5 py-2 rounded-full shadow-sm transition-all active:scale-95"
                        >
                          {t('sched.goToStore')}
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1.5 mb-3 max-h-32 overflow-y-auto no-scrollbar">
                          {cartItems.map((item, idx) => (
                            <div key={idx} className="flex justify-between items-center text-xs font-bold bg-white p-2 rounded-lg shadow-xs border border-blue-50">
                              <span className="text-gray-700 flex items-center gap-1.5">
                                <span className="bg-blue-100 text-blue-700 w-4 h-4 flex items-center justify-center rounded text-[10.5px]">{item.quantity}</span>
                                {item.name}
                              </span>
                              <span className="text-gray-900">₹{item.price * item.quantity}</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between font-black text-sm pt-2 border-t border-blue-200 mb-3">
                          <span className="text-gray-800">
                            {['Weekly', 'Monthly'].includes(scheduleFilter)
                              ? t('sched.totalForDays', { count: selectedDates.length })
                              : t('sched.total')}
                          </span>
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
                          {t('sched.scheduleDelivery')} <ChevronRight className="w-4 h-4" />
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
                  {scheduleFilter === 'All'
                    ? t('sched.noneAll')
                    : t('sched.noneFiltered', { frequency: frequencyWord(scheduleFilter) })}
                </h3>
                <p className="text-sm text-gray-500 mb-6">
                  {scheduleFilter === 'All'
                    ? t('sched.noneAllBody')
                    : t('sched.noneFilteredBody', { frequency: frequencyWord(scheduleFilter) })}
                </p>
                <button
                  onClick={onGoHome}
                  className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-bold py-3 px-6 rounded-2xl shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 mx-auto w-full"
                >
                  {t('sched.explore')} <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                <h3 className="font-black text-gray-400 text-xs uppercase tracking-widest pl-2 mb-2 mt-4">{t('sched.existing')}</h3>
                {filteredSchedules.map((schedule) => {
                  const freqStyle = getFrequencyStyle(schedule.frequency);
                  return (
                    <div key={schedule.id} className={`bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 transition-all relative overflow-hidden group animate-fade-in mb-4 ${schedule.status === 'paused' ? 'opacity-70' : ''}`}>
                      
                      {/* Frequency ribbon */}
                      <div className={`absolute -right-8 top-4 rotate-45 text-[10.5px] font-black uppercase tracking-wider py-1 px-10 text-white shadow-sm ${freqStyle.bg}`}>
                        {frequencyWord(
                          String(schedule.frequency).replace(/^./, (c) => c.toUpperCase())
                        )}
                      </div>
                      
                      {/* Header row */}
                      <div className="flex justify-between items-start mb-3 pr-12">
                        <div>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-xs font-black text-gray-900 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200 shadow-xs">
                              {schedule.id}
                            </span>
                            <span className={`text-[11.5px] font-extrabold px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                              schedule.status === 'active' 
                                ? 'bg-emerald-100 text-emerald-800 border-emerald-200' 
                                : 'bg-amber-100 text-amber-800 border-amber-200'
                            }`}>
                              <RotateCw className={`w-3 h-3 ${schedule.status === 'active' ? 'animate-spin' : ''}`} style={schedule.status === 'active' ? { animationDuration: '3s' } : {}} /> 
                              {t(schedule.status === 'active' ? 'sched.active' : 'sched.paused')}
                            </span>
                          </div>
                          
                          {/* Frequency label */}
                          <span className={`text-[11.5px] font-extrabold px-2 py-0.5 rounded-full border ${freqStyle.badge}`}>
                            {freqStyle.label}
                          </span>
                          
                          <div className="flex items-center gap-1 text-[12.5px] text-gray-500 font-bold mt-2">
                            <CalendarRange className="w-3.5 h-3.5 text-[#1B4D3E]" />
                            <span className="text-[#1B4D3E] font-extrabold">
                              {t('sched.nextDelivery', {
                                date: new Date(schedule.nextRunAt).toLocaleDateString(
                                  dateLocale(language),
                                  { weekday: 'short', day: 'numeric', month: 'short' }
                                ),
                              })}
                            </span>
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
                          <span className="text-[12.5px] font-black text-[#1B4D3E] block leading-tight">
                            {describeRecurrence(schedule, t, dateLocale(language))}
                          </span>
                          <span className="text-[10.5px] text-gray-400 font-bold uppercase">
                            {t('sched.pricedOnDay')}
                          </span>
                        </div>
                      </div>

                      {/* Items */}
                      <div className="bg-[#FAF7F2] rounded-xl p-3 border border-[#EAE3D2] shadow-inner mb-3">
                        <h4 className="text-[11.5px] font-black text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                          <Package className="w-3 h-3" /> {t('sched.subscribedItems')}
                        </h4>
                        <div className="space-y-1.5">
                          {/* Quantities and names, no line prices — the same
                              reason the card carries no total. */}
                          {schedule.items.map((item, idx) => (
                            <div key={idx} className="flex justify-between text-xs font-bold">
                              <span className="text-gray-700">
                                {item.quantity}x {item.name || t('sched.item')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Why nothing arrived, when that is the case. */}
                      {schedule.lastFailure && (
                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                          <p className="text-[12.5px] text-amber-900 leading-snug">
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
                            <><PauseCircle className="w-4 h-4" /> {t('sched.pause')}</>
                          ) : (
                            <><PlayCircle className="w-4 h-4" /> {t('sched.resume')}</>
                          )}
                        </button>
                        <button 
                          onClick={() => deleteSchedule(schedule.id)}
                          disabled={busyScheduleId === schedule.id}
                          className="p-2.5 rounded-xl text-rose-500 bg-rose-50 border border-rose-100 hover:bg-rose-100 transition-all shadow-sm active:scale-95"
                          title={t('sched.cancelSubscription')}
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
                <p className="font-black text-base">{t('orders.progressTitle')}</p>
                <p className="text-emerald-200 text-xs">
                  {t('orders.progressSub', {
                    id: trackingModalOrder.id,
                    name: trackingModalOrder.customerName,
                  })}
                </p>
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
                      className={`w-5 h-5 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-[11.5px] font-black ${
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
                        className={`text-[14.5px] font-bold ${
                          state === 'pending' ? 'text-gray-400' : 'text-gray-900'
                        }`}
                      >
                        {t(stage.labelKey)}
                      </p>
                      {state === 'current' && stage.hintKey && (
                        <p className="text-[13px] text-emerald-700">{t(stage.hintKey)}</p>
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
                <p className="text-[11.5px] text-gray-400 font-bold uppercase">{t('orders.deliveringTo')}</p>
                <p className="text-xs font-semibold text-gray-700">{trackingModalOrder.deliveryAddress || trackingModalOrder.address}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
