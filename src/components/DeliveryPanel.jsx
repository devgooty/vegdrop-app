import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import {
  Truck, CheckCircle2, MapPin, Phone, PackageCheck, Bell,
  LogOut, User, Home, Map as MapIcon, Wallet, Info, Clock, AlertTriangle,
  Landmark, CreditCard, Lock, Loader2, Pencil, X, Camera,
} from 'lucide-react';
import MarketPickups from './MarketPickups';
import HandoverCodeEntry from './HandoverCodeEntry';
import LanguagePicker from './LanguagePicker';
import ProfileAvatar from './ProfileAvatar';
import VegDropMark from './VegDropMark';
import {
  startLocationReporting, setDutyStatus,
  fetchRiderBankDetails, saveRiderBankDetails,
  describeLegalNameProblem, describeBankNameProblem, describeIfscProblem, describeAccountProblem,
} from '../services/rider';
import { uploadDeliveryProof } from '../services/orders';
import { toUploadableJpeg } from '../services/imageCapture';
import { ApiRequestError, NetworkError } from '../services/apiClient';
import { useLanguage } from '../i18n/LanguageContext';
import useRiderJobs from '../hooks/useRiderJobs';

/** Leaflet only ships to a rider who actually has a route to look at. */
const DeliveryRouteMap = lazy(() => import('./DeliveryRouteMap'));

/**
 * The delivery agent's app.
 *
 * WHAT WAS REMOVED, AND WHY
 *
 * Most of this screen used to be a demonstration wearing the clothes of a
 * product. None of the following did what it appeared to do:
 *
 * - "Accept Order" pushed an id into local state and never called the server,
 *   so two agents could both accept the same order and neither was recorded.
 * - "Mark Picked Up" sent `Out for Delivery`, which `TRANSITION_PERMISSIONS` in
 *   routes/orders.js grants to shopkeeper/market_owner/developer and NOT to
 *   delivery — a guaranteed 403 for the only role that could press it.
 * - A four-digit OTP gated completion. There was no delivery OTP anywhere in
 *   the system; the endpoint took no code, and any four digits passed. A check
 *   that always succeeds is worse than none, because it is trusted. There IS a
 *   door code now (services/handover.js), and the difference is the whole
 *   point: the customer's app shows it, the server checks it, and this screen
 *   holds nothing to check it against.
 * - Earnings were `deliveries × 45`, and the weekly payout was that same number
 *   × 3. There is no rider payout model in this codebase at all — `User.rider`
 *   holds duty status and a position, nothing more.
 * - The rating was a hardcoded "4.9 ⭐ (124 trips)".
 *
 * Every one of those is gone rather than repaired, because there was nothing
 * underneath to repair them to. What remains is driven by real endpoints, and
 * where the data genuinely does not exist the screen says so.
 */
/**
 * `busy` is on duty too - it is what the server sets the moment a rider accepts
 * a job, and it refuses to take a busy rider off duty (DELIVERY_IN_PROGRESS).
 *
 * Reading only `online` meant that any reload mid-job - the OS killing a
 * backgrounded PWA, a dropped connection - showed "You are off duty" and hid
 * the job the rider was carrying, including the box to type the customer's
 * delivery code into. With that box gone the order could not be completed at
 * all, by anyone but a developer.
 */
function isOnDuty(dutyStatus) {
  return dutyStatus === 'online' || dutyStatus === 'busy';
}

export default function DeliveryPanel({ user, orders, onVerifyPickup, onVerifyDelivery, onAcceptShopOrder, onDeclineShopOrder, onLogout, notifications = [], onClearNotification }) {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState('home');

  /**
   * On duty or not — the SERVER's answer, not a local guess.
   *
   * This was `useState(false)` and the effect below pushed that value to the
   * server on mount. Two things followed, and both were observed on the demo
   * server with a rider the dispatcher had just offered a pickup to:
   *
   *  - The dashboard announced "You are currently offline" directly above a
   *    live NEW PICKUP card, because the panel had never asked.
   *  - Worse, opening the app CLOCKED THE RIDER OFF. `PATCH /rider/duty` fired
   *    with `offline` before the rider touched anything, so a reload, a network
   *    blip, or the OS killing a backgrounded PWA quietly ended their shift and
   *    the offers stopped arriving. `/auth/refresh` confirmed it: online before
   *    the app opened, offline after.
   *
   * `dutyStatus` has always been on the session user (`User.toPublicJSON`); it
   * was simply never read.
   */
  const [isOnline, setIsOnline] = useState(isOnDuty(user?.dutyStatus));
  const [isSavingDuty, setIsSavingDuty] = useState(false);
  const [dutyError, setDutyError] = useState(null);

  // Follow the server whenever the session is re-read — the rider may have gone
  // on or off duty on another device.
  useEffect(() => {
    if (user?.dutyStatus) setIsOnline(isOnDuty(user.dutyStatus));
  }, [user?.dutyStatus]);

  /**
   * Going on or off duty is an ACTION, so it is a handler rather than an effect.
   *
   * As an effect it could not tell the rider's own tap apart from the component
   * mounting, which is exactly how mounting came to clock people off. It also
   * means a refusal can be reconciled: the server declines to take a rider off
   * duty mid-delivery (409 DELIVERY_IN_PROGRESS), and that answer used to be
   * swallowed, leaving the switch showing "offline" for a rider the server still
   * considered on the job.
   */
  const handleSetOnline = useCallback(
    async (next) => {
      if (isSavingDuty || next === isOnline) return;

      const previous = isOnline;
      setIsOnline(next);
      setIsSavingDuty(true);
      setDutyError(null);
      try {
        await setDutyStatus(next ? 'online' : 'offline');
      } catch (err) {
        setIsOnline(previous);
        setDutyError(err?.message || 'Could not change your duty status. Try again.');
      } finally {
        setIsSavingDuty(false);
      }
    },
    [isOnline, isSavingDuty]
  );

  /**
   * The rider's real position, from the one GPS watch this panel runs.
   *
   * Handed down to the screens that render a map — they are the only ones with
   * an order in scope, and therefore the only ones that know which market and
   * which door the position should be measured against.
   */
  const [agentCoords, setAgentCoords] = useState(null);

  /**
   * One GPS subscription, two consumers.
   *
   * Tell the server where this rider is, and whether they are working. Market
   * dispatch picks whoever is nearest the market, so without the heartbeat the
   * rider is invisible to it — no offers, ever, however close they are standing.
   *
   * This panel used to run a SECOND `watchPosition` of its own alongside this
   * one, purely to keep `agentCoords`. Two subscriptions drain the same battery
   * to learn the same fact, so the reporter now hands each fix back through
   * `onPosition` and the maps downstream read it from there.
   */
  /**
   * Why this rider is not reachable by dispatch, when they are not.
   *
   * Being online is only half of what dispatch needs — it matches on
   * `rider.lastLocation` too, so a rider whose GPS is blocked is invisible no
   * matter what the toggle says. That failure used to be discarded, which made
   * "no pickups right now" indistinguishable from "you will never get one".
   */
  const [locationError, setLocationError] = useState(null);

  /**
   * The GPS watch, and nothing else.
   *
   * The duty write used to live here too, which is what made mounting
   * indistinguishable from the rider tapping the switch — see `handleSetOnline`
   * above. This effect now only follows the duty state, it never sets it.
   */
  useEffect(() => {
    let stopReporting = null;

    if (isOnline) {
      setLocationError(null);
      stopReporting = startLocationReporting({
        onPosition: (position) => {
          setAgentCoords(position);
          // A fix arrived, so whatever we were warning about is over.
          setLocationError(null);
        },
        onError: (err) => {
          // A dropped heartbeat is transient and the next one is seconds away;
          // only a missing position actually keeps offers from arriving.
          if (err?.kind === 'geolocation') setLocationError(err.message);
        },
      });
    } else {
      // A stale dot on a map is worse than no dot: it claims to know where the
      // rider is when nothing has been reported since they clocked off.
      setAgentCoords(null);
      setLocationError(null);
    }

    return () => {
      if (stopReporting) stopReporting();
    };
  }, [isOnline]);

  /**
   * Deliveries this agent has actually completed.
   *
   * Safe to count straight off the list: `visibilityFilter` scopes a delivery
   * role to their own assignments plus an unclaimed pool that only contains
   * Preparing and Out for Delivery, so a `Delivered` order reaching this client
   * is necessarily one this agent closed.
   */
  const delivered = orders.filter((o) => o.status === 'Delivered');
  const deliveredToday = delivered.filter((o) => isToday(o.timestamp));

  /**
   * Independent-shop and legacy marketless orders — everything outside the
   * market cascade `MarketPickups` renders.
   *
   * An order the dispatch cascade picked this rider for shows up here already
   * `assignedTo` them but with `riderAccepted: false` — that is the Accept /
   * Decline prompt below. Once accepted it carries a pickup code to show at
   * the shop; once `Out for Delivery` the only control left is `Delivered`.
   */
  const legacyJobs = orders.filter(
    (o) => !o.marketName && ['Preparing', 'Out for Delivery'].includes(o.status)
  );

  return (
    <div className="min-h-[100dvh] bg-[#FAF7F2] flex flex-col font-sans relative max-w-md mx-auto shadow-xl border-x border-[#DCD5C6]/60">
      <header className="vd-glass-header px-4 py-3 pt-safe-3 border-b border-[#DCD5C6] sticky top-0 z-40">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="vd-home-mark">
              <span className="vd-home-mark-shell" aria-hidden="true" />
              <VegDropMark className="vd-home-mark-glyph" />
            </span>
            <h1 className="font-black text-[1.15rem] text-[#1B4D3E] tracking-tight truncate">
              {activeTab === 'home' && t('header.dashboard')}
              {activeTab === 'orders' && t('header.activeTasks')}
              {activeTab === 'map' && t('header.liveRoute')}
              {activeTab === 'earnings' && t('header.deliveries')}
              {activeTab === 'profile' && t('header.myProfile')}
            </h1>
          </div>
          <div className="relative shrink-0 p-1.5">
            <Bell className="w-5 h-5 text-[#8A7E6B]" strokeWidth={2.25} />
            {notifications.length > 0 && (
              <span className="skeuo-badge-amber absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 text-white text-[11px] font-extrabold rounded-full flex items-center justify-center ring-2 ring-[#FAF7F2]">
                {notifications.length}
              </span>
            )}
          </div>
        </div>

        {notifications.map((notif) => (
          <button
            key={notif.id}
            type="button"
            className="mt-3 w-full skeuo-btn-emerald text-white px-3.5 py-2.5 rounded-2xl flex items-start gap-2 text-left active:scale-[0.99]"
            onClick={() => {
              if (onClearNotification) onClearNotification(notif.id);
              setActiveTab('orders');
            }}
          >
            <Bell className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="text-sm font-bold leading-snug">{notif.message || 'New delivery task'}</span>
          </button>
        ))}
      </header>

      <main className="flex-1 px-4 pt-4 overflow-y-auto pb-[calc(5.75rem+env(safe-area-inset-bottom,0px))]">
        {activeTab === 'home' && (
          <HomeTab
            user={user}
            isOnline={isOnline}
            onSetOnline={handleSetOnline}
            isSavingDuty={isSavingDuty}
            dutyError={dutyError}
            agentCoords={agentCoords}
            locationError={locationError}
            deliveredToday={deliveredToday.length}
            deliveredTotal={delivered.length}
            setActiveTab={setActiveTab}
          />
        )}

        {activeTab === 'orders' && (
          <OrdersTab
            isOnline={isOnline}
            agentCoords={agentCoords}
            legacyJobs={legacyJobs}
            onVerifyPickup={onVerifyPickup}
            onVerifyDelivery={onVerifyDelivery}
            onAcceptShopOrder={onAcceptShopOrder}
            onDeclineShopOrder={onDeclineShopOrder}
          />
        )}

        {activeTab === 'map' && (
          <RiderLiveMapTab
            riderPosition={agentCoords}
            onOpenOrders={() => setActiveTab('orders')}
          />
        )}

        {activeTab === 'earnings' && (
          <DeliveriesTab
            delivered={delivered}
            deliveredToday={deliveredToday.length}
          />
        )}

        {activeTab === 'profile' && (
          <ProfileTab user={user} deliveredTotal={delivered.length} onLogout={onLogout} />
        )}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-40 pointer-events-none">
        <div className="px-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          <div className="pointer-events-auto bg-[#FAF7F2]/95 backdrop-blur-md border border-[#DCD5C6] rounded-full flex items-center justify-around w-full py-1.5 px-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)]">
            <NavButton icon={Home} label={t('nav.home')} isActive={activeTab === 'home'} onClick={() => setActiveTab('home')} />
            <NavButton icon={PackageCheck} label={t('nav.orders')} isActive={activeTab === 'orders'} onClick={() => setActiveTab('orders')} />
            <NavButton icon={MapIcon} label={t('nav.map')} isActive={activeTab === 'map'} onClick={() => setActiveTab('map')} />
            <NavButton icon={Wallet} label={t('nav.trips')} isActive={activeTab === 'earnings'} onClick={() => setActiveTab('earnings')} />
            <NavButton icon={User} label={t('nav.profile')} isActive={activeTab === 'profile'} onClick={() => setActiveTab('profile')} />
          </div>
        </div>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function HomeTab({ user, isOnline, onSetOnline, isSavingDuty, dutyError, agentCoords, locationError, deliveredToday, deliveredTotal, setActiveTab }) {
  return (
    <div className="space-y-5 animate-fade-in">
      <section className="rounded-[1.75rem] bg-[#1B4D3E] text-white overflow-hidden shadow-[0_8px_24px_rgba(27,77,62,0.28)]">
        <div className="px-5 pt-5 pb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-14 h-14 rounded-2xl bg-[#FFFDF9] p-[3px] shrink-0 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)]">
                <ProfileAvatar
                  name={user?.name}
                  avatar={user?.avatar}
                  className="w-full h-full rounded-[0.85rem]"
                  emojiClassName="text-2xl"
                />
              </div>
              <div className="min-w-0">
                <p className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#A8D5B5]">
                  {isOnline ? 'On duty' : 'Off duty'}
                </p>
                <h2 className="text-[1.2rem] font-black truncate leading-tight mt-0.5">
                  {user ? user.name : 'Delivery Partner'}
                </h2>
                {/* A real count. The "4.9 ⭐ (124 trips)" this replaces was typed
                    into the source and identical for every agent. */}
                <p className="text-[13.5px] text-white/65 mt-0.5">
                  {deliveredTotal} {deliveredTotal === 1 ? 'delivery' : 'deliveries'} completed
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label={isOnline ? 'Go offline' : 'Go online'}
              onClick={() => onSetOnline(!isOnline)}
              disabled={isSavingDuty}
              className={`relative w-14 h-8 rounded-full shrink-0 transition-colors duration-300 disabled:opacity-60 ${
                isOnline ? 'bg-[#8FCB9B]' : 'bg-white/20'
              }`}
            >
              <div
                className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow-sm transition-transform duration-300 ${
                  isOnline ? 'translate-x-7' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          <p className="text-[13.5px] text-white/60 mt-4 leading-relaxed">
            {isOnline
              ? 'Nearby markets can see you. New pickups land here first.'
              : 'Go on duty so the nearest market can offer you a pickup. Your position is only shared while you are online.'}
          </p>
        </div>
      </section>

      {/*
        Being online but unlocatable is the one state that looks like working
        and is not: dispatch matches riders on their last reported position, so
        without one no offer can ever arrive. Say it above the pickups list,
        where "nothing right now" would otherwise be read as bad luck.
      */}
      {isOnline && locationError && (
        <div className="bg-[#FDF3E3] border border-[#E8D4A8] rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-[#8A6A1B] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h3 className="font-bold text-[#5C4A12] text-sm mb-0.5">No pickups can reach you</h3>
            <p className="text-xs text-[#7A6528] leading-relaxed">{locationError}</p>
          </div>
        </div>
      )}

      {/*
        The server refuses to take a rider off duty mid-delivery, which is a
        real answer and the one thing a rider tapping that switch most needs to
        hear. It used to be caught and dropped, so the tap simply did nothing.
      */}
      {dutyError && (
        <div className="bg-[#FCECEC] border border-[#E8C4C4] rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-[#9B3A3A] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h3 className="font-bold text-[#6B2424] text-sm mb-0.5">Still on duty</h3>
            <p className="text-xs text-[#8A3A3A] leading-relaxed">{dutyError}</p>
          </div>
        </div>
      )}

      {/*
        Market pickups sit above everything else on this screen.
        An offer is live for a few seconds before it moves to the next rider, so
        it has to be the first thing on the page — not something to scroll to.
        Renders nothing at all when there is neither an offer nor a job in hand.
      */}
      <div className="-mx-4">
        <MarketPickups isOnline={isOnline} riderPosition={agentCoords} />
      </div>

      {!isOnline ? (
        <div className="skeuo-card rounded-[1.5rem] p-6 text-center">
          <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1B4D3E]/10 text-[#1B4D3E]">
            <Truck className="w-7 h-7" />
          </span>
          <h3 className="font-black text-[#1B4D3E] mb-1">You are off duty</h3>
          <p className="text-[13.5px] text-[#8A7E6B] mb-4 leading-relaxed">
            Markets only offer pickups to riders they can see. Clock on when you are ready to ride.
          </p>
          <button
            type="button"
            onClick={() => onSetOnline(true)}
            disabled={isSavingDuty}
            className="skeuo-btn-emerald font-black px-6 py-3 rounded-2xl w-full active:scale-[0.98] transition-transform flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
            {isSavingDuty ? 'Going on duty…' : 'Go on duty'}
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Today" value={deliveredToday} hint="deliveries" />
            <Stat label="All time" value={deliveredTotal} hint="deliveries" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setActiveTab('orders')}
              className="skeuo-btn-emerald p-4 rounded-2xl flex items-center gap-3 text-left active:scale-[0.98] transition-transform"
            >
              <PackageCheck className="w-7 h-7 opacity-90 shrink-0" />
              <span className="font-bold text-sm leading-tight">Active<br />tasks</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('map')}
              className="skeuo-btn-light p-4 rounded-2xl flex items-center gap-3 text-left active:scale-[0.98] transition-transform"
            >
              <MapIcon className="w-7 h-7 text-[#1B4D3E] shrink-0" />
              <span className="font-bold text-sm leading-tight text-[#1B4D3E]">Live<br />route</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function OrdersTab({ isOnline, agentCoords, legacyJobs, onVerifyPickup, onVerifyDelivery, onAcceptShopOrder, onDeclineShopOrder }) {
  if (!isOnline) {
    return (
      <div className="skeuo-card rounded-[1.5rem] text-center py-16 px-5">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1B4D3E]/10 text-[#1B4D3E]">
          <Truck className="w-7 h-7" />
        </span>
        <h3 className="font-black text-[#1B4D3E] mb-2">You are off duty</h3>
        <p className="text-sm text-[#8A7E6B] leading-relaxed">
          Go on duty from Home to be offered pickups.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* The market flow, which is the real one: offers, the stall round, and
          the live route. MarketPickups renders nothing when there is neither. */}
      <div className="-mx-4">
        <MarketPickups isOnline={isOnline} riderPosition={agentCoords} hideIdleEmpty />
      </div>

      {legacyJobs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[11.5px] font-black text-[#8A7E6B] uppercase tracking-wider px-1">
            Direct orders
          </h2>
          {legacyJobs.map((order) => (
            <LegacyJobCard
              key={order.serverId || order.id}
              order={order}
              onVerifyPickup={(code) => onVerifyPickup(order.serverId || order.id, code)}
              onVerifyDelivery={(code) => onVerifyDelivery(order.serverId || order.id, code)}
              onAccept={() => onAcceptShopOrder(order.serverId || order.id)}
              onDecline={() => onDeclineShopOrder(order.serverId || order.id)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * An order from the independent-shop or pre-market flow.
 *
 * Three states, in order:
 *  1. `awaitingAccept` — dispatch picked this rider as nearest but they have
 *     not yet said yes. Accept/Decline are the only controls; nothing about
 *     the job is worth showing beyond what's already visible, because a
 *     candidate who has not agreed is not yet committed to it.
 *  2. `awaitingHandoff` — accepted, on the way to the counter. The shop's app
 *     is showing a pickup code; the rider types it here, and that is what
 *     sends the order out.
 *  3. `readyToDeliver` — out for delivery. The customer's app is showing a
 *     delivery code; the rider types it here to complete the order.
 *
 * The rider is shown NEITHER code, anywhere. They are the one who types both,
 * so a code on this screen would let them confirm a handover with nobody on
 * the other side of it.
 *
 * A true legacy order (no shop at all) skips 1 and 2 entirely: a status line
 * while `Preparing`, then the door code once staff have moved it out — there
 * is no shop to hold a pickup code for those, and no rider-side accept step.
 */
function LegacyJobCard({ order, onVerifyPickup, onVerifyDelivery, onAccept, onDecline }) {
  const { t } = useLanguage();
  const [acting, setActing] = useState(false);
  const [proofUrl, setProofUrl] = useState(order.deliveryProofUrl || null);
  const [proofError, setProofError] = useState('');
  const [uploadingProof, setUploadingProof] = useState(false);
  const isShopOrder = Boolean(order.shopName);
  const awaitingAccept = isShopOrder && order.status === 'Preparing' && order.assignedTo && !order.riderAccepted;
  const awaitingHandoff = isShopOrder && order.status === 'Preparing' && order.riderAccepted;
  const readyToDeliver = order.status === 'Out for Delivery';

  const runAction = async (action) => {
    setActing(true);
    try {
      await action();
    } finally {
      setActing(false);
    }
  };

  const handleProofPick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || uploadingProof) return;
    setProofError('');
    setUploadingProof(true);
    try {
      const dataUri = await toUploadableJpeg(file);
      const result = await uploadDeliveryProof(order.serverId || order.id, dataUri);
      setProofUrl(result.url);
    } catch (err) {
      setProofError(err?.message || 'Could not upload that photo.');
    } finally {
      setUploadingProof(false);
    }
  };

  return (
    <article className="skeuo-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#EAE3D2] flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-bold text-[#2D2A26] truncate">
            {awaitingAccept ? order.shopName : order.customerName}
          </p>
          <p className="text-[13px] text-[#8A7E6B]">{order.id}</p>
        </div>
        <span
          className={`text-[12px] font-bold px-2.5 py-1 rounded-full shrink-0 ${
            readyToDeliver
              ? 'bg-[#1B4D3E]/10 text-[#1B4D3E]'
              : 'bg-[#FDF3E3] text-[#8A6A1B]'
          }`}
        >
          {awaitingAccept ? 'New pickup' : order.status}
        </span>
      </div>

      {awaitingAccept ? (
        <>
          <div className="px-4 py-3 space-y-2">
            <p className="text-[14px] text-[#2D2A26] leading-snug">
              {order.shopName} wants a rider for {order.items?.length || 1} item
              {order.items?.length === 1 ? '' : 's'}.
            </p>
            {order.paymentMethod === 'cod' && (
              <p className="text-[13.5px] font-bold text-[#8A6A1B] bg-[#FDF3E3] border border-[#E8D4A8] rounded-xl px-2.5 py-1.5">
                Collect ₹{order.totalAmount} in cash on handover
              </p>
            )}
          </div>
          <div className="p-3 bg-[#F4F0E6] flex gap-2">
            <button
              type="button"
              onClick={() => runAction(onDecline)}
              disabled={acting}
              className="skeuo-btn-light px-4 py-3 rounded-xl flex items-center justify-center gap-1.5 text-[14px] font-bold disabled:opacity-50"
            >
              <X className="w-4 h-4" />
              Decline
            </button>
            <button
              type="button"
              onClick={() => runAction(onAccept)}
              disabled={acting}
              className="flex-1 skeuo-btn-emerald text-[15.5px] font-bold py-3 rounded-xl disabled:opacity-60"
            >
              <span className="flex items-center justify-center gap-2">
                {acting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Accept
              </span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-start gap-2.5">
              <MapPin className={`w-4 h-4 shrink-0 mt-0.5 ${awaitingHandoff ? 'text-[#1D4E6B]' : 'text-[#C45C26]'}`} />
              <div>
                {awaitingHandoff && (
                  <p className="text-[12px] font-bold text-[#1D4E6B] uppercase tracking-wide">
                    Pick up from {order.shopName}
                  </p>
                )}
                <p className="text-[14px] text-[#2D2A26] leading-snug">
                  {awaitingHandoff ? order.shopAddress || order.shopName : order.address}
                </p>
              </div>
            </div>
            {order.paymentMethod === 'cod' && (
              <p className="text-[13.5px] font-bold text-[#8A6A1B] bg-[#FDF3E3] border border-[#E8D4A8] rounded-xl px-2.5 py-1.5">
                Collect ₹{order.totalAmount} in cash on handover
              </p>
            )}
            {awaitingHandoff ? (
              <HandoverCodeEntry
                title={t('handover.pickupTitle')}
                hint={t('handover.askShop', { name: order.shopName || t('handover.theShop') })}
                submitLabel={t('handover.confirmPickup')}
                onSubmit={onVerifyPickup}
              />
            ) : (
              !readyToDeliver && (
                <p className="text-[13px] text-[#8A7E6B] flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  The shop has not handed this over yet.
                </p>
              )
            )}
            {readyToDeliver && (
              <div className="space-y-2">
                <HandoverCodeEntry
                  title={t('handover.deliveryTitle')}
                  hint={t('handover.askCustomer', { name: order.customerName || t('handover.theCustomer') })}
                  submitLabel={t('handover.confirmDelivery')}
                  onSubmit={onVerifyDelivery}
                />
                {proofUrl ? (
                  <img src={proofUrl} alt="" className="w-full h-28 object-cover rounded-xl border border-[#DCD5C6]" />
                ) : null}
                <label className="inline-flex items-center gap-2 text-[12px] font-bold text-[#1B4D3E] bg-[#1B4D3E]/8 border border-[#1B4D3E]/15 px-3 py-2 rounded-xl cursor-pointer">
                  {uploadingProof ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                  <span>{uploadingProof ? 'Uploading…' : proofUrl ? 'Retake delivery photo' : 'Photo of delivery (optional)'}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/*"
                    capture="environment"
                    className="hidden"
                    disabled={uploadingProof}
                    onChange={handleProofPick}
                  />
                </label>
                {proofError && <p className="text-[11px] font-bold text-[#9B3A3A]">{proofError}</p>}
              </div>
            )}
          </div>

          <div className="p-3 bg-[#F4F0E6] flex gap-2">
            {(awaitingHandoff ? order.shopPhone : order.phone) && (
              <a
                href={`tel:${awaitingHandoff ? order.shopPhone : order.phone}`}
                className="skeuo-btn-light px-4 py-3 rounded-xl flex items-center justify-center"
                aria-label={awaitingHandoff ? 'Call the shop' : 'Call the customer'}
              >
                <Phone className="w-4 h-4" />
              </a>
            )}
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
                awaitingHandoff
                  ? order.shopLat && order.shopLng
                    ? `${order.shopLat},${order.shopLng}`
                    : order.shopAddress || order.shopName
                  : order.address
              )}`}
              target="_blank"
              rel="noreferrer"
              className="flex-1 skeuo-btn-light px-4 py-3 rounded-xl flex items-center justify-center gap-1.5 text-[14px] font-bold"
            >
              <MapPin className="w-4 h-4" />
              {awaitingHandoff ? 'Navigate to shop' : 'Navigate'}
            </a>
          </div>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

/**
 * The Map tab: the rider's current job, full height.
 *
 * Reads the same rider-jobs source the pickup list does. Only one tab is mounted
 * at a time, so this does not add a second poll running alongside it.
 *
 * An empty state here is the honest answer: with no accepted job there is no
 * route, and the previous version filled that gap by tracking `orders[0]` —
 * whichever order happened to be first in a list scoped to the whole role.
 */
function RiderLiveMapTab({ riderPosition, onOpenOrders }) {
  const { activeJob, loaded } = useRiderJobs();

  if (!loaded) {
    return <div className="h-[calc(100dvh-200px)] rounded-2xl bg-[#EFECE4] animate-pulse" aria-hidden="true" />;
  }

  if (!activeJob) {
    return (
      <div className="skeuo-card rounded-[1.5rem] text-center py-14 px-5">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1B4D3E]/10 text-[#1B4D3E]">
          <MapIcon className="w-7 h-7" />
        </span>
        <p className="text-[#1B4D3E] font-black">Accept a pickup to see your route.</p>
        <p className="text-[#8A7E6B] text-[13.5px] mt-1.5 leading-relaxed">
          Offers arrive on Home as soon as a market has an order ready.
        </p>
        {onOpenOrders && (
          <button
            type="button"
            onClick={onOpenOrders}
            className="mt-5 skeuo-btn-emerald font-bold px-5 py-2.5 rounded-2xl text-sm"
          >
            See active tasks
          </button>
        )}
      </div>
    );
  }

  const heading = activeJob.status === 'dispatched' ? 'Heading to the customer' : 'Heading to the market';

  return (
    <div className="flex flex-col gap-3">
      <div className="skeuo-card rounded-2xl px-3.5 py-2.5 text-xs flex justify-between items-center gap-2">
        <div className="min-w-0">
          <p className="font-bold text-[#1B4D3E] truncate">{heading}</p>
          <p className="text-[#8A7E6B] truncate">
            {activeJob.status === 'dispatched'
              ? activeJob.address
              : `${activeJob.marketName} · ${activeJob.stallCount} stall${activeJob.stallCount === 1 ? '' : 's'}`}
          </p>
        </div>
        <span className="skeuo-badge-emerald text-white px-2 py-1 rounded-md text-[11.5px] font-black shrink-0">
          {activeJob.orderNumber}
        </span>
      </div>

      <Suspense fallback={<div className="h-[60dvh] rounded-2xl bg-[#EFECE4] animate-pulse" aria-hidden="true" />}>
        <DeliveryRouteMap
          rider={riderPosition}
          market={activeJob.marketLat != null ? { lat: activeJob.marketLat, lng: activeJob.marketLng } : null}
          customer={activeJob.deliveryLat != null ? { lat: activeJob.deliveryLat, lng: activeJob.deliveryLng } : null}
          status={activeJob.status}
          height="60dvh"
        />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

/**
 * What this agent has delivered.
 *
 * There is no money on this screen, and that is not an oversight. Nothing in
 * this codebase records what a rider is paid: `User.rider` carries a duty status
 * and a position, there is no rider payout model, and `Order.deliveryFeePaise`
 * is what the CUSTOMER paid for delivery, not what the agent receives — the two
 * differ by whatever the platform keeps.
 *
 * The screen this replaces showed `deliveries × 45` as earnings and that figure
 * × 3 as a weekly payout, beside a "Withdraw Money" button that did nothing and
 * three hardcoded "+₹45 · Today, 2:30 PM" rows. An agent plans around what a
 * delivery app tells them they have earned.
 */
function DeliveriesTab({ delivered, deliveredToday }) {
  return (
    <div className="space-y-5 animate-fade-in">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Today" value={deliveredToday} hint="deliveries" />
        <Stat label="All time" value={delivered.length} hint="deliveries" />
      </div>

      <div className="bg-[#EAF3F8] border border-[#C5D8E4] rounded-2xl p-4 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-[#1D4E6B] shrink-0 mt-0.5" />
        <p className="text-[14px] text-[#1D4E6B] leading-relaxed">
          <span className="font-bold block">Payouts are not tracked here yet.</span>
          This app records the deliveries you complete, but the platform has no rider payout
          ledger, so it cannot tell you what you have earned. Check with the market office for
          what you are owed.
        </p>
      </div>

      <section className="skeuo-card rounded-2xl p-5">
        <h3 className="font-black text-[#1B4D3E] mb-4 border-b border-[#EAE3D2] pb-2">Completed deliveries</h3>
        {delivered.length === 0 ? (
          <p className="text-sm text-[#8A7E6B] py-2">
            Nothing completed yet. Deliveries you finish appear here.
          </p>
        ) : (
          <ul className="space-y-3">
            {delivered.slice(0, 20).map((order) => (
              <li key={order.serverId || order.id} className="flex justify-between items-center gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 bg-[#1B4D3E]/10 rounded-full flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-5 h-5 text-[#1B4D3E]" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-[#2D2A26] text-sm truncate">
                      {order.marketName || order.customerName}
                    </p>
                    <p className="text-xs text-[#8A7E6B]">{order.time}</p>
                  </div>
                </div>
                <span className="text-xs font-bold text-[#8A7E6B] shrink-0">{order.id}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileTab({ user, deliveredTotal, onLogout }) {
  return (
    <div className="space-y-5 animate-fade-in">
      <div className="skeuo-card p-6 rounded-[1.75rem] text-center">
        <ProfileAvatar
          name={user?.name}
          avatar={user?.avatar}
          className="w-24 h-24 rounded-full mx-auto mb-4 ring-4 ring-white shadow-md"
          emojiClassName="text-4xl"
        />
        <h2 className="text-2xl font-black text-[#1B4D3E]">{user ? user.name : 'Delivery Partner'}</h2>
        <p className="text-[#8A7E6B] mb-4">{user?.phone || ''}</p>
        <div className="inline-flex bg-[#1B4D3E]/10 text-[#1B4D3E] px-4 py-1.5 rounded-full font-bold text-sm">
          {deliveredTotal} {deliveredTotal === 1 ? 'delivery' : 'deliveries'} completed
        </div>
      </div>

      <LanguagePicker />

      <BankDetailsCard />

      {onLogout && (
        <button
          type="button"
          onClick={onLogout}
          className="w-full bg-[#FCECEC] text-[#9B3A3A] font-black py-4 rounded-2xl border border-[#E8C4C4] active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
        >
          <LogOut className="w-5 h-5" /> Sign out
        </button>
      )}
    </div>
  );
}

/**
 * Where the market office should send this rider's payouts.
 *
 * There is no rider payout ledger in this codebase (see DeliveriesTab, above),
 * so saving these details unlocks nothing — it just keeps them on file instead
 * of collected ad hoc over phone calls. Unlike vendor KYC there is no penny
 * drop: nobody is proving control of the account here, only recording it.
 */
function BankDetailsCard() {
  const [details, setDetails] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const [legalName, setLegalName] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [ifsc, setIfsc] = useState('');

  const describeError = (err, fallback) => {
    if (err instanceof NetworkError) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    if (err instanceof ApiRequestError) return err.message;
    return fallback;
  };

  useEffect(() => {
    let cancelled = false;
    fetchRiderBankDetails()
      .then((data) => {
        if (cancelled) return;
        setDetails(data);
        if (!data) setIsEditing(true);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err, 'Could not load your bank details.'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startEditing = () => {
    setLegalName(details?.legalName || '');
    setBankName(details?.bankName || '');
    setBankAccount('');
    setIfsc(details?.ifsc || '');
    setError('');
    setIsEditing(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isBusy) return;

    // Advisory checks only; the server enforces the authoritative rules.
    const problem =
      describeLegalNameProblem(legalName) ||
      describeBankNameProblem(bankName) ||
      describeAccountProblem(bankAccount) ||
      describeIfscProblem(ifsc);

    if (problem) {
      setError(problem);
      return;
    }

    setError('');
    setIsBusy(true);
    try {
      const updated = await saveRiderBankDetails({
        legalName: legalName.trim(),
        bankName: bankName.trim(),
        bankAccount: bankAccount.trim(),
        ifsc: ifsc.trim().toUpperCase(),
      });
      setDetails(updated);
      setIsEditing(false);
    } catch (err) {
      setError(describeError(err, 'Could not save those details. Please try again.'));
    } finally {
      setIsBusy(false);
    }
  };

  if (isLoading) {
    return (
      <section className="skeuo-card rounded-2xl p-5">
        <div className="flex items-center justify-center gap-2 py-6 text-[#8A7E6B] text-xs font-bold">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Loading bank details…</span>
        </div>
      </section>
    );
  }

  return (
    <section className="skeuo-card rounded-2xl p-5">
      <div className="flex items-center justify-between border-b border-[#EAE3D2] pb-2 mb-4">
        <h3 className="font-black text-[#1B4D3E] flex items-center gap-2">
          <Landmark className="w-4 h-4" />
          Bank Details
        </h3>
        {!isEditing && (
          <button
            type="button"
            onClick={startEditing}
            className="text-[#1B4D3E] text-xs font-bold flex items-center gap-1 active:scale-95"
          >
            <Pencil className="w-3.5 h-3.5" />
            {details ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      {!isEditing && details && (
        <div className="space-y-1.5">
          {/* No PAN is collected anywhere in this system — see the KYC section
              in CLAUDE.md. What is stored is `legalName`, and what proves the
              account is the penny drop, not an identity document. Naming a card
              nobody asks for invited riders to go and find one. */}
          <Row label="Account holder" value={details.legalName} />
          <Row label="Bank" value={details.bankName} />
          <Row label="Account" value={details.bankAccount} />
          <Row label="IFSC" value={details.ifsc} />
        </div>
      )}

      {!isEditing && !details && (
        <p className="text-xs text-[#8A7E6B] leading-relaxed">
          Add your bank details so the market office knows where to send what you're owed.
        </p>
      )}

      {isEditing && (
        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          <div>
            <label className="block font-bold text-[#2D2A26] mb-1">Name on the bank account</label>
            <div className="relative">
              <input
                type="text"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value.slice(0, 120))}
                placeholder="e.g. Ramesh Kumar"
                maxLength={120}
                className="w-full skeuo-inset-input rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-[#2D2A26] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
                required
                disabled={isBusy}
              />
              <User className="w-4 h-4 text-[#8A7E6B] absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block font-bold text-[#2D2A26] mb-1">Bank Name</label>
            <div className="relative">
              <input
                type="text"
                value={bankName}
                onChange={(e) => setBankName(e.target.value.slice(0, 120))}
                placeholder="e.g. HDFC Bank"
                maxLength={120}
                className="w-full skeuo-inset-input rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-[#2D2A26] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
                required
                disabled={isBusy}
              />
              <CreditCard className="w-4 h-4 text-[#8A7E6B] absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block font-bold text-[#2D2A26] mb-1">Bank Account Number</label>
            <div className="relative">
              <input
                type="text"
                inputMode="numeric"
                value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, '').slice(0, 18))}
                placeholder={details ? `Currently ${details.bankAccount}` : '9 to 18 digits'}
                className="w-full skeuo-inset-input rounded-2xl py-2.5 pl-10 pr-3 text-xs font-mono font-semibold tracking-wider text-[#2D2A26] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
                required
                disabled={isBusy}
              />
              <Landmark className="w-4 h-4 text-[#8A7E6B] absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block font-bold text-[#2D2A26] mb-1">IFSC Code</label>
            <div className="relative">
              <input
                type="text"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase().slice(0, 11))}
                placeholder="HDFC0001234"
                maxLength={11}
                className="w-full skeuo-inset-input rounded-2xl py-2.5 pl-10 pr-3 text-xs font-mono font-semibold tracking-wider text-[#2D2A26] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
                required
                disabled={isBusy}
              />
              <Landmark className="w-4 h-4 text-[#8A7E6B] absolute left-3.5 top-3" />
            </div>
          </div>

          <div className="bg-[#F4F0E6] p-3 rounded-2xl border border-[#DCD5C6] flex gap-2">
            <Lock className="w-3.5 h-3.5 text-[#8A7E6B] shrink-0 mt-0.5" />
            <p className="text-[11.5px] text-[#8A7E6B] font-semibold leading-relaxed">
              Your account number is encrypted and never shown in full again — only the last four
              digits.
            </p>
          </div>

          {error && <p className="text-[12.5px] font-bold text-[#9B3A3A]">{error}</p>}

          <div className="flex gap-2">
            {details && (
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setError('');
                }}
                disabled={isBusy}
                className="flex-1 skeuo-btn-light font-bold py-3 rounded-2xl text-xs active:scale-95 disabled:opacity-60"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={isBusy}
              className="flex-1 skeuo-btn-emerald font-extrabold py-3 rounded-2xl flex items-center justify-center gap-2 text-xs active:scale-98 disabled:opacity-70"
            >
              {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isBusy ? 'Saving…' : 'Save'}</span>
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11.5px] text-[#8A7E6B] uppercase font-bold tracking-wide">{label}</span>
      <span className="text-[12.5px] font-mono font-bold text-[#2D2A26] truncate">{value || '—'}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Stat({ label, value, hint }) {
  return (
    <div className="skeuo-card p-5 rounded-2xl flex flex-col items-center">
      <span className="text-[11.5px] font-bold text-[#8A7E6B] uppercase tracking-wider mb-1">{label}</span>
      <span className="text-3xl font-black text-[#1B4D3E] tabular-nums">{value}</span>
      <span className="text-[12.5px] text-[#8A7E6B] font-semibold">{hint}</span>
    </div>
  );
}

const NavButton = ({ icon: Icon, label, isActive, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex flex-col items-center py-1.5 px-1.5 sm:px-2 rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-90 cursor-pointer ${
      isActive
        ? 'text-[#1B4D3E] font-bold bg-[#1B4D3E]/10 shadow-[inset_0_2px_4px_rgba(27,77,62,0.1)]'
        : 'text-[#8A7E6B] hover:text-[#1B4D3E] hover:bg-black/5'
    }`}
  >
    <Icon className={`w-5 h-5 transition-transform duration-300 ${isActive ? 'scale-110' : ''}`} strokeWidth={isActive ? 2.5 : 2} />
    <span className="text-[10.5px] sm:text-[11.5px] font-semibold mt-0.5 whitespace-nowrap">{label}</span>
  </button>
);

function isToday(timestamp) {
  if (!timestamp) return false;
  const then = new Date(timestamp);
  const now = new Date();
  return (
    then.getDate() === now.getDate() &&
    then.getMonth() === now.getMonth() &&
    then.getFullYear() === now.getFullYear()
  );
}
