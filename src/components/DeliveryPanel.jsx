import React, { useState, useEffect, lazy, Suspense } from 'react';
import {
  Truck, CheckCircle2, MapPin, Phone, PackageCheck, Bell,
  LogOut, User, Home, Map as MapIcon, Wallet, Info, Clock, AlertTriangle, Lock,
} from 'lucide-react';
import MarketPickups from './MarketPickups';
import { useToast } from './Toast';
import { claimOrder, confirmPickup } from '../services/orders';
import { startLocationReporting, setDutyStatus } from '../services/rider';
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
 * - A four-digit OTP gated completion, compared in the browser against nothing:
 *   the endpoint took no code and any four digits passed. A check that always
 *   succeeds is worse than none, because it is trusted.
 *
 *   There IS a four-digit code here now, and it is worth being clear about what
 *   changed, because the screen looks similar. It is derived server-side from
 *   the order and seller ids, shown only on the shopkeeper's screen, never sent
 *   to this app, verified by the server, and attempt-capped. The old one was
 *   theatre; this one is the reason the customer's address is on the card at
 *   all.
 * - Earnings were `deliveries × 45`, and the weekly payout was that same number
 *   × 3. There is no rider payout model in this codebase at all — `User.rider`
 *   holds duty status and a position, nothing more.
 * - The rating was a hardcoded "4.9 ⭐ (124 trips)".
 *
 * Every one of those is gone rather than repaired, because there was nothing
 * underneath to repair them to. What remains is driven by real endpoints, and
 * where the data genuinely does not exist the screen says so.
 */
export default function DeliveryPanel({ user, orders, onUpdateOrderStatus, onSyncOrders, onLogout, notifications = [], onClearNotification }) {
  const [activeTab, setActiveTab] = useState('home');
  /**
   * Duty status comes from the server, not from an assumption.
   *
   * This used to be `useState(false)`, which was a claim rather than a reading:
   * the panel asserted the rider was off duty every time it mounted, then
   * pushed that assertion to `PATCH /api/rider/duty`. Two things went wrong.
   *
   * A rider holding a live order got a 409 back — the server refuses to take
   * someone off duty mid-delivery, correctly — and the failure was swallowed,
   * so the screen sat there reading "You are currently offline / GO ONLINE"
   * directly beneath a card showing their in-progress round. Both statements
   * were on screen at once and the loud one was false.
   *
   * A rider without an active order was worse off, because there the PATCH
   * SUCCEEDED: simply opening the app clocked them out, and they would sit
   * waiting for offers that dispatch was never going to send.
   *
   * `dutyStatus` is already on `toPublicJSON()`, so nothing new is exposed here.
   */
  const [isOnline, setIsOnline] = useState(user?.dutyStatus === 'online');

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

  /** Set when the server refuses to change duty, so the screen can say why. */
  const [dutyError, setDutyError] = useState(null);
  const [dutyBusy, setDutyBusy] = useState(false);

  /**
   * Going on or off duty, as a request rather than an announcement.
   *
   * The server is the authority on this — it refuses to clock a rider off with
   * an order in hand — so local state moves only after the server agrees. The
   * previous arrangement flipped the toggle first and fired the PATCH from an
   * effect, which meant a refusal left the UI showing a state the server had
   * explicitly rejected.
   */
  const toggleDuty = async () => {
    const next = isOnline ? 'offline' : 'online';
    setDutyBusy(true);
    setDutyError(null);
    try {
      await setDutyStatus(next);
      setIsOnline(next === 'online');
    } catch (err) {
      setDutyError(
        err?.code === 'DELIVERY_IN_PROGRESS'
          ? 'Finish your current delivery before going offline.'
          : err?.message || 'Could not change your duty status.'
      );
    } finally {
      setDutyBusy(false);
    }
  };

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
   * Orders with no market — the pre-market flow and independent shops.
   *
   * `marketId` is optional at checkout, so these still exist, and they reach a
   * rider through the unclaimed pool rather than the dispatch cascade (an
   * independent shop has no market, so there is no origin to measure "nearest"
   * from).
   *
   * A delivery role now drives three transitions on one of these rather than
   * one: claim it, prove the pickup with the shop's code — which is what moves
   * it to Out for Delivery — and mark it delivered. The middle step used not to
   * exist, and its absence is why every agent on duty could read the customer's
   * address off every order sitting in the pool.
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
            onToggleDuty={toggleDuty}
            dutyBusy={dutyBusy}
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
            onUpdateOrderStatus={onUpdateOrderStatus}
            onSyncOrders={onSyncOrders}
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

function HomeTab({ user, isOnline, onToggleDuty, dutyBusy, dutyError, agentCoords, locationError, deliveredToday, deliveredTotal, setActiveTab }) {
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
          aria-busy={dutyBusy}
          disabled={dutyBusy}
          onClick={onToggleDuty}
          className={`relative w-14 h-8 rounded-full shrink-0 transition-colors duration-300 disabled:opacity-60 ${isOnline ? 'bg-emerald-500' : 'bg-gray-300'}`}
        >
          <div className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform duration-300 ${isOnline ? 'translate-x-7' : 'translate-x-1'}`} />
        </button>
      </div>

      {/*
        The server said no. Shown rather than swallowed: the commonest reason is
        that the rider still has an order in hand, which is worth telling them
        plainly instead of leaving a toggle that appears not to respond.
      */}
      {dutyError && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex items-start gap-3 shadow-sm">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[13px] text-amber-900 font-semibold leading-snug">{dutyError}</p>
        </div>
      )}

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
            onClick={onToggleDuty}
            disabled={dutyBusy}
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

function OrdersTab({ isOnline, agentCoords, legacyJobs, onUpdateOrderStatus, onSyncOrders }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);

  /**
   * @returns {Promise<boolean>} whether it worked, so a caller holding an open
   *   code input knows whether to clear it or leave it up for another try.
   */
  const run = async (id, action, successMessage) => {
    setBusy(id);
    try {
      await action();
      if (successMessage) toast.success(successMessage);
      await onSyncOrders?.();
      return true;
    } catch (err) {
      toast.error(
        err?.code === 'ALREADY_CLAIMED'
          ? 'Another agent took that one.'
          : err?.message || 'That did not work.'
      );
      await onSyncOrders?.();
      return false;
    } finally {
      setBusy(null);
    }
  };

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
              busy={busy === (order.serverId || order.id)}
              onClaim={() =>
                run(
                  order.serverId || order.id,
                  () => claimOrder(order.serverId || order.id),
                  'Delivery claimed'
                )
              }
              onPickup={(code) =>
                run(
                  order.serverId || order.id,
                  () => confirmPickup(order.serverId || order.id, code),
                  'Collected — the address is now on the card'
                )
              }
              onDeliver={() => onUpdateOrderStatus(order.serverId || order.id, 'Delivered')}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * An order from the pre-market flow, or from an independent shop.
 *
 * Three states, in the order the rider actually moves through them: claim it,
 * prove you collected it, deliver it.
 *
 * The middle step is new and is the point of the card. It used to go straight
 * from "in the pool" to "mark delivered", with the customer's name, phone and
 * door printed on every card in the pool — including the ones this agent was
 * never going to carry. Now the shop reads out a four-digit code, and entering
 * it is what reveals the customer and enables delivery.
 */
function LegacyJobCard({ order, onClaim, onPickup, onDeliver, busy }) {
  const mine = Boolean(order.assignedTo);
  const pickedUp = Boolean(order.pickedUpAt) || !order.customerLocked;
  const [code, setCode] = useState('');

  const submit = async () => {
    const ok = await onPickup(code);
    setCode('');
    return ok;
  };

  return (
    <article className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold text-gray-900 truncate">
            {pickedUp ? order.customerName : order.shopName || 'Direct order'}
          </p>
          <p className="text-[11.5px] text-gray-500">{order.id}</p>
        </div>
        <span
          className={`text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0 ${
            pickedUp ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
          }`}
        >
          {order.status}
        </span>
      </div>

      <div className="px-4 py-3 space-y-2">
        {pickedUp ? (
          <div className="flex items-start gap-2.5">
            <MapPin className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
            <p className="text-[12.5px] text-gray-700 leading-snug">
              {order.address || 'No address recorded for this order.'}
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2.5">
            <Lock className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
            <p className="text-[12.5px] text-gray-600 leading-snug">
              {mine
                ? 'Enter the shop’s handover code and the address, phone and route appear here.'
                : 'Claim this delivery to start. The address stays hidden until you collect from the shop.'}
            </p>
          </div>
        )}

        {order.paymentMethod === 'cod' && (
          <p className="text-[12px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            Collect ₹{order.totalAmount} in cash on handover
          </p>
        )}

        {/*
          The code entry, shown only once the order is actually this agent's.
          Offering it on an unclaimed card would invite five wasted guesses
          against a pickup somebody else is about to take.
        */}
        {mine && !pickedUp && (
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-3">
            <label
              htmlFor={`pickup-${order.serverId || order.id}`}
              className="block text-[12px] font-bold text-gray-700"
            >
              Ask the shop for the 4-digit code
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id={`pickup-${order.serverId || order.id}`}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={4}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.length === 4) submit();
                }}
                placeholder="0000"
                className="flex-1 min-w-0 h-11 px-3 text-[18px] font-black tabular-nums tracking-[0.35em] text-center text-gray-900 bg-white border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/30"
              />
              <button
                type="button"
                onClick={submit}
                disabled={code.length !== 4 || busy}
                className="px-4 rounded-lg bg-emerald-600 text-white text-[13px] font-bold shrink-0 disabled:bg-gray-200 disabled:text-gray-400"
              >
                {busy ? '…' : 'Collect'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 bg-gray-50 flex gap-2">
        {pickedUp && order.phone && (
          <a
            href={`tel:${order.phone}`}
            className="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 flex items-center justify-center"
            aria-label="Call the customer"
          >
            <Phone className="w-4 h-4" />
          </a>
        )}
        {pickedUp && order.address && (
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(order.address)}`}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 flex items-center justify-center gap-1.5 text-[12.5px] font-bold"
          >
            <MapPin className="w-4 h-4" />
            Navigate
          </a>
        )}

        {!mine ? (
          <button
            type="button"
            onClick={onClaim}
            disabled={busy}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[14px] font-bold py-3 rounded-xl transition active:translate-y-px disabled:bg-gray-200 disabled:text-gray-400"
          >
            {busy ? 'Claiming…' : 'Claim this delivery'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onDeliver}
            disabled={!pickedUp || busy}
            className="flex-1 bg-gray-900 hover:bg-black text-white text-[14px] font-bold py-3 rounded-xl transition active:translate-y-px disabled:bg-gray-200 disabled:text-gray-400"
          >
            <span className="flex items-center justify-center gap-2">
              <PackageCheck className="w-4 h-4" />
              {pickedUp ? 'Mark delivered' : 'Collect from the shop first'}
            </span>
          </button>
        )}
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
