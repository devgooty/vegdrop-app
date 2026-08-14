import React, { useState, useEffect, lazy, Suspense } from 'react';
import {
  Truck, CheckCircle2, MapPin, Phone, PackageCheck, Bell,
  LogOut, User, Home, Map as MapIcon, Wallet, Info, Clock, AlertTriangle,
  Landmark, CreditCard, Lock, Loader2, Pencil,
} from 'lucide-react';
import MarketPickups from './MarketPickups';
import {
  startLocationReporting, setDutyStatus,
  fetchRiderBankDetails, saveRiderBankDetails,
  describeLegalNameProblem, describeBankNameProblem, describeIfscProblem, describeAccountProblem,
} from '../services/rider';
import { ApiRequestError, NetworkError } from '../services/apiClient';
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
 * - A four-digit OTP gated completion. There is no delivery OTP anywhere in the
 *   system; the endpoint takes no code, and any four digits passed. A check
 *   that always succeeds is worse than none, because it is trusted.
 * - Earnings were `deliveries × 45`, and the weekly payout was that same number
 *   × 3. There is no rider payout model in this codebase at all — `User.rider`
 *   holds duty status and a position, nothing more.
 * - The rating was a hardcoded "4.9 ⭐ (124 trips)".
 *
 * Every one of those is gone rather than repaired, because there was nothing
 * underneath to repair them to. What remains is driven by real endpoints, and
 * where the data genuinely does not exist the screen says so.
 */
export default function DeliveryPanel({ user, orders, onUpdateOrderStatus, onLogout, notifications = [], onClearNotification }) {
  const [activeTab, setActiveTab] = useState('home');
  const [isOnline, setIsOnline] = useState(false);

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

  useEffect(() => {
    let stopReporting = null;

    setDutyStatus(isOnline ? 'online' : 'offline').catch(() => {
      // Refusing to go offline mid-delivery is a legitimate answer from the
      // server, and the panel's own toggle already reflects the rider's intent.
    });

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
   * Legacy marketless orders.
   *
   * The pre-market flow still exists — `marketId` is optional at checkout — and
   * its orders reach a rider through the unclaimed pool. The one transition a
   * delivery role may perform on them is `Delivered`; the shop is the one that
   * moves an order to Out for Delivery. So that is the only control offered.
   */
  const legacyJobs = orders.filter(
    (o) => !o.marketName && ['Preparing', 'Out for Delivery'].includes(o.status)
  );

  return (
    <div className="min-h-[100dvh] bg-gray-50 flex flex-col font-sans relative max-w-md mx-auto shadow-2xl overflow-hidden border-x border-gray-200">
      <header className="bg-white px-5 py-4 border-b border-gray-100 shadow-sm sticky top-0 z-40">
        <div className="flex items-center justify-between">
          <h1 className="font-black text-xl text-gray-900 tracking-tight">
            {activeTab === 'home' && 'Dashboard'}
            {activeTab === 'orders' && 'Active Tasks'}
            {activeTab === 'map' && '🗺 Live Route'}
            {activeTab === 'earnings' && 'Deliveries'}
            {activeTab === 'profile' && 'My Profile'}
          </h1>
          <div className="relative">
            <Bell className="w-6 h-6 text-gray-500" />
            {notifications.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-rose-500 text-white text-[10px] font-black rounded-full flex items-center justify-center animate-bounce">
                {notifications.length}
              </span>
            )}
          </div>
        </div>

        {notifications.map((notif) => (
          <button
            key={notif.id}
            type="button"
            className="mt-3 w-full bg-emerald-600 text-white px-3 py-2.5 rounded-xl flex items-start gap-2 shadow-md text-left"
            onClick={() => {
              if (onClearNotification) onClearNotification(notif.id);
              setActiveTab('orders');
            }}
          >
            <Bell className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="text-sm font-bold">{notif.message || 'New delivery task'}</span>
          </button>
        ))}
      </header>

      <main className="flex-1 p-5 overflow-y-auto pb-28">
        {activeTab === 'home' && (
          <HomeTab
            user={user}
            isOnline={isOnline}
            setIsOnline={setIsOnline}
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
            onUpdateOrderStatus={onUpdateOrderStatus}
          />
        )}

        {activeTab === 'map' && <RiderLiveMapTab riderPosition={agentCoords} />}

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

      <nav className="fixed bottom-0 left-0 right-0 mx-auto w-full max-w-md bg-white border-t border-gray-200 pb-safe pt-2 px-6 flex justify-between items-center shadow-[0_-10px_20px_rgba(0,0,0,0.03)] z-40 rounded-t-3xl">
        <NavButton icon={Home} label="Home" isActive={activeTab === 'home'} onClick={() => setActiveTab('home')} />
        <NavButton icon={PackageCheck} label="Orders" isActive={activeTab === 'orders'} onClick={() => setActiveTab('orders')} />
        <NavButton icon={MapIcon} label="Map" isActive={activeTab === 'map'} onClick={() => setActiveTab('map')} />
        <NavButton icon={Wallet} label="Trips" isActive={activeTab === 'earnings'} onClick={() => setActiveTab('earnings')} />
        <NavButton icon={User} label="Profile" isActive={activeTab === 'profile'} onClick={() => setActiveTab('profile')} />
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function HomeTab({ user, isOnline, setIsOnline, agentCoords, locationError, deliveredToday, deliveredTotal, setActiveTab }) {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center border-2 border-emerald-500 shrink-0">
            <User className="w-8 h-8 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-black text-gray-900 truncate">
              {user ? user.name : 'Delivery Partner'}
            </h2>
            {/* A real count. The "4.9 ⭐ (124 trips)" this replaces was typed
                into the source and identical for every agent. */}
            <p className="text-sm font-bold text-gray-500">
              {deliveredTotal} {deliveredTotal === 1 ? 'delivery' : 'deliveries'} completed
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label={isOnline ? 'Go offline' : 'Go online'}
          onClick={() => setIsOnline(!isOnline)}
          className={`relative w-14 h-8 rounded-full shrink-0 transition-colors duration-300 ${isOnline ? 'bg-emerald-500' : 'bg-gray-300'}`}
        >
          <div className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform duration-300 ${isOnline ? 'translate-x-7' : 'translate-x-1'}`} />
        </button>
      </div>

      {/*
        Being online but unlocatable is the one state that looks like working
        and is not: dispatch matches riders on their last reported position, so
        without one no offer can ever arrive. Say it above the pickups list,
        where "nothing right now" would otherwise be read as bad luck.
      */}
      {isOnline && locationError && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex items-start gap-3 shadow-sm">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h3 className="font-bold text-amber-900 text-sm mb-0.5">No pickups can reach you</h3>
            <p className="text-xs text-amber-800 leading-relaxed">{locationError}</p>
          </div>
        </div>
      )}

      {/*
        Market pickups sit above everything else on this screen.
        An offer is live for a few seconds before it moves to the next rider, so
        it has to be the first thing on the page — not something to scroll to.
        Renders nothing at all when there is neither an offer nor a job in hand.
      */}
      <div className="-mx-5">
        <MarketPickups isOnline={isOnline} riderPosition={agentCoords} />
      </div>

      {!isOnline ? (
        <div className="bg-rose-50 border border-rose-100 rounded-2xl p-5 text-center shadow-sm">
          <Truck className="w-12 h-12 text-rose-300 mx-auto mb-2" />
          <h3 className="font-bold text-rose-900 mb-1">You are currently offline</h3>
          <p className="text-xs text-rose-600 mb-4">
            Go online to start receiving pickups. Your position is shared while you are online —
            that is how the nearest market finds you.
          </p>
          <button
            type="button"
            onClick={() => setIsOnline(true)}
            className="bg-emerald-600 text-white font-black px-6 py-3 rounded-xl w-full shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2"
          >
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
            GO ONLINE
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Today" value={deliveredToday} hint="deliveries" />
            <Stat label="All time" value={deliveredTotal} hint="deliveries" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setActiveTab('orders')}
              className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white p-4 rounded-2xl shadow-md flex items-center gap-3 transition-colors text-left"
            >
              <PackageCheck className="w-8 h-8 opacity-80 shrink-0" />
              <span className="font-bold text-sm leading-tight">Active<br />tasks</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('map')}
              className="bg-white border border-gray-200 text-gray-800 p-4 rounded-2xl shadow-sm flex items-center gap-3 transition-colors text-left"
            >
              <MapIcon className="w-8 h-8 text-emerald-600 opacity-80 shrink-0" />
              <span className="font-bold text-sm leading-tight">Live<br />route</span>
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

function OrdersTab({ isOnline, agentCoords, legacyJobs, onUpdateOrderStatus }) {
  if (!isOnline) {
    return (
      <div className="text-center py-20 px-4">
        <Truck className="w-14 h-14 text-gray-300 mx-auto mb-4" />
        <h3 className="font-bold text-gray-900 mb-2">You are offline</h3>
        <p className="text-sm text-gray-500">
          Go online from the Home tab to be offered pickups.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* The market flow, which is the real one: offers, the stall round, and
          the live route. MarketPickups renders nothing when there is neither. */}
      <div className="-mx-5">
        <MarketPickups isOnline={isOnline} riderPosition={agentCoords} />
      </div>

      {legacyJobs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-black text-gray-400 uppercase tracking-wider px-1">
            Direct orders
          </h2>
          {legacyJobs.map((order) => (
            <LegacyJobCard
              key={order.serverId || order.id}
              order={order}
              onDeliver={() => onUpdateOrderStatus(order.serverId || order.id, 'Delivered')}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * An order from the pre-market flow.
 *
 * Deliberately spare. A delivery role may only move one of these to
 * `Delivered`; the shop is what moves it to Out for Delivery, so an order still
 * in Preparing gets a status line rather than a button that would 403.
 */
function LegacyJobCard({ order, onDeliver }) {
  const readyToDeliver = order.status === 'Out for Delivery';

  return (
    <article className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold text-gray-900 truncate">{order.customerName}</p>
          <p className="text-[11.5px] text-gray-500">{order.id}</p>
        </div>
        <span
          className={`text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0 ${
            readyToDeliver ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
          }`}
        >
          {order.status}
        </span>
      </div>

      <div className="px-4 py-3 space-y-2">
        <div className="flex items-start gap-2.5">
          <MapPin className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-gray-700 leading-snug">{order.address}</p>
        </div>
        {order.paymentMethod === 'cod' && (
          <p className="text-[12px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            Collect ₹{order.totalAmount} in cash on handover
          </p>
        )}
        {!readyToDeliver && (
          <p className="text-[11.5px] text-gray-500 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            The shop has not handed this over yet.
          </p>
        )}
      </div>

      <div className="p-3 bg-gray-50 flex gap-2">
        {order.phone && (
          <a
            href={`tel:${order.phone}`}
            className="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 flex items-center justify-center"
            aria-label="Call the customer"
          >
            <Phone className="w-4 h-4" />
          </a>
        )}
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(order.address)}`}
          target="_blank"
          rel="noreferrer"
          className="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 flex items-center justify-center gap-1.5 text-[12.5px] font-bold"
        >
          <MapPin className="w-4 h-4" />
          Navigate
        </a>
        <button
          type="button"
          onClick={onDeliver}
          disabled={!readyToDeliver}
          className="flex-1 bg-gray-900 hover:bg-black text-white text-[14px] font-bold py-3 rounded-xl transition active:translate-y-px disabled:bg-gray-200 disabled:text-gray-400"
        >
          <span className="flex items-center justify-center gap-2">
            <PackageCheck className="w-4 h-4" />
            Mark delivered
          </span>
        </button>
      </div>
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
function RiderLiveMapTab({ riderPosition }) {
  const { activeJob, loaded } = useRiderJobs();

  if (!loaded) {
    return <div className="h-[calc(100dvh-200px)] rounded-2xl bg-gray-100 animate-pulse" aria-hidden="true" />;
  }

  if (!activeJob) {
    return (
      <div className="text-center py-20">
        <MapIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500 font-bold">Accept a pickup to see your route.</p>
        <p className="text-gray-400 text-xs mt-1">
          Offers arrive on the Home tab as soon as a market has an order ready.
        </p>
      </div>
    );
  }

  const heading = activeJob.status === 'dispatched' ? 'Heading to the customer' : 'Heading to the market';

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 text-xs flex justify-between items-center gap-2">
        <div className="min-w-0">
          <p className="font-bold text-emerald-800 truncate">{heading}</p>
          <p className="text-emerald-600 truncate">
            {activeJob.status === 'dispatched'
              ? activeJob.address
              : `${activeJob.marketName} · ${activeJob.stallCount} stall${activeJob.stallCount === 1 ? '' : 's'}`}
          </p>
        </div>
        <span className="bg-emerald-600 text-white px-2 py-1 rounded-md text-[10px] font-black shrink-0">
          {activeJob.orderNumber}
        </span>
      </div>

      <Suspense fallback={<div className="h-[60dvh] rounded-2xl bg-gray-100 animate-pulse" aria-hidden="true" />}>
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
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Today" value={deliveredToday} hint="deliveries" />
        <Stat label="All time" value={delivered.length} hint="deliveries" />
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <p className="text-[12.5px] text-blue-900 leading-relaxed">
          <span className="font-bold block">Payouts are not tracked here yet.</span>
          This app records the deliveries you complete, but the platform has no rider payout
          ledger, so it cannot tell you what you have earned. Check with the market office for
          what you are owed.
        </p>
      </div>

      <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <h3 className="font-black text-gray-900 mb-4 border-b pb-2">Completed deliveries</h3>
        {delivered.length === 0 ? (
          <p className="text-sm text-gray-500 py-2">
            Nothing completed yet. Deliveries you finish appear here.
          </p>
        ) : (
          <ul className="space-y-4">
            {delivered.slice(0, 20).map((order) => (
              <li key={order.serverId || order.id} className="flex justify-between items-center gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 bg-emerald-50 rounded-full flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-gray-800 text-sm truncate">
                      {order.marketName || order.customerName}
                    </p>
                    <p className="text-xs text-gray-400">{order.time}</p>
                  </div>
                </div>
                <span className="text-xs font-bold text-gray-400 shrink-0">{order.id}</span>
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
    <div className="space-y-6 animate-fade-in">
      <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100 text-center">
        <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center border-4 border-white shadow-lg mx-auto mb-4">
          <User className="w-12 h-12 text-emerald-600" />
        </div>
        <h2 className="text-2xl font-black text-gray-900">{user ? user.name : 'Delivery Partner'}</h2>
        <p className="text-gray-500 mb-4">{user?.phone || ''}</p>
        <div className="inline-flex bg-emerald-50 text-emerald-700 px-4 py-1.5 rounded-full font-bold text-sm border border-emerald-200">
          {deliveredTotal} {deliveredTotal === 1 ? 'delivery' : 'deliveries'} completed
        </div>
      </div>

      <BankDetailsCard />

      {onLogout && (
        <button
          type="button"
          onClick={onLogout}
          className="w-full bg-rose-50 text-rose-600 font-black py-4 rounded-2xl border border-rose-100 active:scale-95 transition-transform flex items-center justify-center gap-2"
        >
          <LogOut className="w-5 h-5" /> SIGN OUT
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
      <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <div className="flex items-center justify-center gap-2 py-6 text-gray-500 text-xs font-bold">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Loading bank details…</span>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between border-b pb-2 mb-4">
        <h3 className="font-black text-gray-900 flex items-center gap-2">
          <Landmark className="w-4 h-4 text-emerald-700" />
          Bank Details
        </h3>
        {!isEditing && (
          <button
            type="button"
            onClick={startEditing}
            className="text-emerald-700 text-xs font-bold flex items-center gap-1 active:scale-95"
          >
            <Pencil className="w-3.5 h-3.5" />
            {details ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      {!isEditing && details && (
        <div className="space-y-1.5">
          <Row label="Name (PAN)" value={details.legalName} />
          <Row label="Bank" value={details.bankName} />
          <Row label="Account" value={details.bankAccount} />
          <Row label="IFSC" value={details.ifsc} />
        </div>
      )}

      {!isEditing && !details && (
        <p className="text-xs text-gray-500 leading-relaxed">
          Add your bank details so the market office knows where to send what you're owed.
        </p>
      )}

      {isEditing && (
        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          <div>
            <label className="block font-bold text-gray-800 mb-1">Name (as per PAN card)</label>
            <div className="relative">
              <input
                type="text"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value.slice(0, 120))}
                placeholder="e.g. Ramesh Kumar"
                maxLength={120}
                className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                required
                disabled={isBusy}
              />
              <User className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block font-bold text-gray-800 mb-1">Bank Name</label>
            <div className="relative">
              <input
                type="text"
                value={bankName}
                onChange={(e) => setBankName(e.target.value.slice(0, 120))}
                placeholder="e.g. HDFC Bank"
                maxLength={120}
                className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                required
                disabled={isBusy}
              />
              <CreditCard className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block font-bold text-gray-800 mb-1">Bank Account Number</label>
            <div className="relative">
              <input
                type="text"
                inputMode="numeric"
                value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, '').slice(0, 18))}
                placeholder={details ? `Currently ${details.bankAccount}` : '9 to 18 digits'}
                className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-mono font-semibold tracking-wider text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                required
                disabled={isBusy}
              />
              <Landmark className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block font-bold text-gray-800 mb-1">IFSC Code</label>
            <div className="relative">
              <input
                type="text"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase().slice(0, 11))}
                placeholder="HDFC0001234"
                maxLength={11}
                className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-mono font-semibold tracking-wider text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                required
                disabled={isBusy}
              />
              <Landmark className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
            </div>
          </div>

          <div className="bg-gray-50 p-3 rounded-2xl border border-gray-200 flex gap-2">
            <Lock className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5" />
            <p className="text-[10px] text-gray-600 font-semibold leading-relaxed">
              Your account number is encrypted and never shown in full again — only the last four
              digits.
            </p>
          </div>

          {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

          <div className="flex gap-2">
            {details && (
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setError('');
                }}
                disabled={isBusy}
                className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 rounded-2xl text-xs transition-colors active:scale-95 disabled:opacity-60"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={isBusy}
              className="flex-1 bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold py-3 rounded-2xl transition-all shadow-md flex items-center justify-center gap-2 text-xs active:scale-98 disabled:opacity-70"
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
      <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wide">{label}</span>
      <span className="text-[11px] font-mono font-bold text-gray-900 truncate">{value || '—'}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Stat({ label, value, hint }) {
  return (
    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center">
      <span className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">{label}</span>
      <span className="text-3xl font-black text-gray-900">{value}</span>
      <span className="text-[11px] text-gray-400 font-semibold">{hint}</span>
    </div>
  );
}

const NavButton = ({ icon: Icon, label, isActive, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex flex-col items-center gap-1 p-2 active:scale-90 transition-transform"
  >
    <div className={`p-1.5 rounded-xl transition-colors ${isActive ? 'bg-emerald-100 text-emerald-700' : 'text-gray-400'}`}>
      <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
    </div>
    <span className={`text-[10px] font-bold ${isActive ? 'text-emerald-700' : 'text-gray-400'}`}>{label}</span>
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
