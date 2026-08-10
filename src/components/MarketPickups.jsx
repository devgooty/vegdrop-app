import React, { useState, useEffect, lazy, Suspense } from 'react';
import {
  Store, MapPin, Navigation, Check, Package, Clock, X, PackageCheck, Phone,
  Banknote, Boxes, User, ChevronDown, ChevronUp, Lock,
} from 'lucide-react';
import { useToast } from './Toast';
import { acceptPickup, declinePickup, collectFromStall, markDelivered } from '../services/rider';
import useRiderJobs from '../hooks/useRiderJobs';

/**
 * Leaflet is heavy and only the rider with a live job ever sees a map, so it is
 * split out rather than shipped with the delivery bundle. An offer card renders
 * no map at all.
 */
const DeliveryRouteMap = lazy(() => import('./DeliveryRouteMap'));

/**
 * Market pickups.
 *
 * A market order is not one address — it is a market, and several numbered
 * stalls inside it. This shows the round in walking order and lets the rider
 * tick each stall off; ticking the last one is what sends the order out for
 * delivery, so there is no separate "I'm leaving" step to forget.
 *
 * Offers arrive here one at a time, nearest rider first. Declining passes it
 * straight to the next rider rather than letting it sit.
 *
 * WHY AN OFFER SHOWS LESS THAN A JOB
 *
 * An offer cascades through up to four riders and can then sit in an open pool
 * that every on-duty rider can see. The server therefore sends only what the
 * decision rests on — which market, how many stalls, how far the drop is, what
 * there is to carry and whether there is cash — and withholds the customer's
 * name, phone and door until somebody actually accepts. This screen is built
 * around that split rather than working around it: there is no field here that
 * an offer is expected to fill and does not.
 */
export default function MarketPickups({ isOnline, riderPosition }) {
  const toast = useToast();

  const { offers, assigned, loaded, refresh } = useRiderJobs();
  const [busy, setBusy] = useState(null);

  /**
   * @returns {Promise<boolean>} whether it worked, so a caller holding an open
   *   input (the handover code) knows whether to clear it or leave it up for
   *   another try. Everything else ignores the result, as before.
   */
  const run = async (id, action, successMessage) => {
    setBusy(id);
    try {
      await action();
      if (successMessage) toast.success(successMessage);
      await refresh();
      return true;
    } catch (err) {
      toast.error(
        err.code === 'OFFER_GONE'
          ? 'Another rider took that one.'
          : err.message || 'That did not work.'
      );
      await refresh();
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Nothing to show and nothing pending: stay out of the way entirely.
  if (loaded && offers.length === 0 && assigned.length === 0) {
    if (!isOnline) return null;
    return (
      <div className="mx-4 mb-4 rounded-2xl border border-dashed border-gray-300 bg-white px-5 py-6 text-center">
        <Store className="w-6 h-6 text-gray-400 mx-auto mb-2" />
        <p className="text-[13.5px] font-bold text-gray-900">No market pickups right now</p>
        <p className="text-[12px] text-gray-500 mt-1">
          You will be offered the nearest one as soon as a market has an order ready.
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 mb-4 space-y-3">
      {offers.map((order) => (
        <OfferCard
          key={order.id}
          order={order}
          riderPosition={riderPosition}
          busy={busy === order.id}
          onAccept={() => run(order.id, () => acceptPickup(order.id), 'Pickup accepted 🚴')}
          onDecline={() =>
            run(order.id, () => declinePickup(order.id), 'Passed to the next rider')
          }
        />
      ))}

      {assigned.map((order) => (
        <AssignedCard
          key={order.id}
          order={order}
          riderPosition={riderPosition}
          busy={busy === order.id}
          onCollect={(pickup, code) =>
            run(
              order.id,
              () => collectFromStall(order.id, pickup.stall, code),
              `Collected from stall ${pickup.stallNumber}`
            )
          }
          onDeliver={() => run(order.id, () => markDelivered(order.id), 'Delivered ✅')}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// An offer: enough to decide, and no more
// ---------------------------------------------------------------------------

function OfferCard({ order, riderPosition, busy, onAccept, onDecline }) {
  const toMarket = distanceBetween(riderPosition, {
    lat: order.marketLat,
    lng: order.marketLng,
  });

  return (
    <article className="rounded-2xl border-2 border-emerald-500 bg-white shadow-lg overflow-hidden">
      <div className="bg-emerald-500 px-4 py-2 flex items-center justify-between">
        <span className="text-[12px] font-extrabold text-white uppercase tracking-wide">
          New pickup
        </span>
        <div className="flex items-center gap-2">
          {order.offerExpiresAt && <OfferCountdown expiresAt={order.offerExpiresAt} />}
          <span className="text-[12px] font-bold text-white">{order.orderNumber}</span>
        </div>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <Store className="w-4.5 h-4.5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold text-gray-900">{order.marketName}</p>
            <p className="text-[12px] text-gray-500">{order.marketAddress}</p>
          </div>
          {toMarket != null && (
            <span className="text-[12px] font-extrabold text-emerald-700 shrink-0">
              {formatDistance(toMarket)}
            </span>
          )}
        </div>

        {/* What the job is made of. Three facts a rider weighs before saying yes. */}
        <div className="grid grid-cols-3 gap-2">
          <Fact icon={<Store className="w-3.5 h-3.5" />} label="Stalls" value={order.stallCount} />
          <Fact icon={<Boxes className="w-3.5 h-3.5" />} label="Items" value={order.itemCount} />
          <Fact
            icon={<Banknote className="w-3.5 h-3.5" />}
            label={order.paymentMethod === 'cod' ? 'Collect' : 'Paid'}
            value={order.paymentMethod === 'cod' ? formatPaise(order.totalAmountPaise) : '—'}
          />
        </div>

        {/* Where it is going, roughly. The exact door arrives on accept. */}
        <div className="flex items-start gap-2.5 pt-1 border-t border-gray-100">
          <MapPin className="w-4.5 h-4.5 text-orange-500 shrink-0 mt-1.5" />
          <p className="text-[12.5px] text-gray-700 pt-1 leading-snug">
            {order.dropoffArea || 'Dropoff address shown once you accept'}
            {order.dropoffDistanceMeters != null && (
              <span className="text-gray-500">
                {' '}
                · {formatDistance(order.dropoffDistanceMeters)} from the market
              </span>
            )}
          </p>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={onDecline}
            disabled={busy}
            aria-label="Pass this pickup to the next rider"
            className="px-4 py-3 rounded-xl border border-gray-300 text-gray-600 text-[13.5px] font-bold disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
          <button
            onClick={onAccept}
            disabled={busy}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[14px] font-bold py-3 rounded-xl transition active:translate-y-px disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Accept pickup'}
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * How long is left to answer.
 *
 * The offer moves to the next rider on a timer whether or not this screen says
 * so; showing it turns a card that silently vanishes into one that explains
 * itself.
 */
function OfferCountdown({ expiresAt }) {
  const [secondsLeft, setSecondsLeft] = useState(() => remainingSeconds(expiresAt));

  useEffect(() => {
    setSecondsLeft(remainingSeconds(expiresAt));
    const timer = setInterval(() => setSecondsLeft(remainingSeconds(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (secondsLeft <= 0) return null;

  return (
    <span className="text-[11px] font-extrabold text-white bg-black/25 px-2 py-0.5 rounded-full tabular-nums">
      {secondsLeft}s
    </span>
  );
}

// ---------------------------------------------------------------------------
// An accepted job: the whole picture
// ---------------------------------------------------------------------------

function AssignedCard({ order, riderPosition, busy, onCollect, onDeliver }) {
  const remaining = order.pickups.filter((p) => !p.collected);
  const readyToLeave = order.status === 'dispatched';
  const [showRound, setShowRound] = useState(true);

  /**
   * Which stall's code is being typed, and what has been typed so far.
   *
   * One at a time: a rider is standing at one counter, and four open inputs
   * would be four chances to enter the right code against the wrong stall.
   */
  const [entering, setEntering] = useState(null);
  const [code, setCode] = useState('');

  /**
   * The input clears and stays open on a rejection rather than closing.
   *
   * A wrong code usually means the number was misheard across a noisy market,
   * and the fix is to ask again — which is a worse experience if the panel has
   * shut and the rider has to find the button a second time. The server's
   * message already carries how many attempts are left, and `run` has toasted
   * it by the time this resolves.
   */
  const submitCode = async (pickup) => {
    const ok = await onCollect(pickup, code);
    setCode('');
    if (ok) setEntering(null);
  };

  const market =
    order.marketLat != null ? { lat: order.marketLat, lng: order.marketLng } : null;
  const customer =
    order.deliveryLat != null ? { lat: order.deliveryLat, lng: order.deliveryLng } : null;

  // Which end the rider is heading for right now — the same rule the map uses.
  const destination = readyToLeave ? customer : market;

  return (
    <article className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold text-gray-900 truncate">{order.marketName}</p>
          <p className="text-[11.5px] text-gray-500">{order.orderNumber}</p>
        </div>
        <span
          className={`text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0 ${
            readyToLeave ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'
          }`}
        >
          {readyToLeave ? 'On the way' : `${remaining.length} stall${remaining.length === 1 ? '' : 's'} left`}
        </span>
      </div>

      {/* The live route for whichever leg is current. */}
      <Suspense
        fallback={<div className="h-[220px] bg-gray-100 animate-pulse" aria-hidden="true" />}
      >
        <DeliveryRouteMap
          rider={riderPosition}
          market={market}
          customer={customer}
          status={order.status}
        />
      </Suspense>

      {/*
        WHO IT IS FOR.

        Withheld until the first stall's handover code has been entered, so this
        block has two states and says which one it is in. "No address" and
        "address not yet earned" are the same blank otherwise, and a rider
        staring at an empty line reasonably concludes the app is broken.
      */}
      <div className="px-4 py-3 border-b border-gray-100 space-y-2">
        {order.customerUnlocked ? (
          <div className="flex items-start gap-2.5">
            <User className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-bold text-gray-900 truncate">
                {order.customerName || 'Customer'}
              </p>
              <p className="text-[12.5px] text-gray-600 leading-snug">
                {order.address || 'No address recorded for this order.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2.5">
            <Lock className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-bold text-gray-900">Delivery address locked</p>
              <p className="text-[12.5px] text-gray-600 leading-snug">
                Enter the handover code from your first stall and the address, phone and route
                appear here.
              </p>
            </div>
          </div>
        )}

        {order.paymentMethod === 'cod' && (
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            <Banknote className="w-3.5 h-3.5 shrink-0" />
            Collect {formatPaise(order.totalAmountPaise)} in cash on handover
          </p>
        )}
      </div>

      {!readyToLeave && (
        <div className="border-b border-gray-100">
          <button
            type="button"
            onClick={() => setShowRound((v) => !v)}
            className="w-full px-4 py-2 flex items-center justify-between text-[12px] font-bold text-gray-600"
          >
            <span>Your round — {order.pickups.length} stall{order.pickups.length === 1 ? '' : 's'}</span>
            {showRound ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showRound && (
            <ul className="divide-y divide-gray-100">
              {order.pickups.map((pickup) => {
                const packed = pickup.lines.every((l) => l.packedAt);
                return (
                  <li key={pickup.stall} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                    <span
                      className={`w-9 h-9 rounded-xl flex items-center justify-center text-[12px] font-extrabold shrink-0 ${
                        pickup.collected
                          ? 'bg-emerald-100 text-emerald-700'
                          : packed
                            ? 'bg-gray-900 text-white'
                            : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {pickup.stallNumber}
                    </span>

                    <div className="flex-1 min-w-0">
                      {/* The trader's name, so the rider is looking for a shop
                          sign rather than counting pitches. */}
                      {pickup.stallName && (
                        <p className="text-[12.5px] font-bold text-gray-900 truncate">
                          {pickup.stallName}
                        </p>
                      )}
                      <p className="text-[12.5px] text-gray-600 truncate">
                        {pickup.lines.map((l) => `${l.name} ×${l.quantity}`).join(', ')}
                      </p>
                      {!packed && !pickup.collected && (
                        <p className="text-[11.5px] text-amber-600 flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3" /> still packing
                        </p>
                      )}
                    </div>

                    {/* Calling the stall is the fix for "I am here and it is
                        shuttered", which is why the number is on the round. */}
                    {pickup.stallPhone && !pickup.collected && (
                      <a
                        href={`tel:${pickup.stallPhone}`}
                        aria-label={`Call stall ${pickup.stallNumber}`}
                        className="px-2.5 py-2 rounded-lg border border-gray-300 text-gray-600 shrink-0"
                      >
                        <Phone className="w-3.5 h-3.5" />
                      </a>
                    )}

                    {pickup.collected ? (
                      <Check className="w-5 h-5 text-emerald-600 shrink-0" strokeWidth={3} />
                    ) : (
                      <button
                        onClick={() => setEntering(entering === pickup.stall ? null : pickup.stall)}
                        disabled={!packed || busy}
                        aria-label={`Enter the handover code for stall ${pickup.stallNumber}`}
                        aria-expanded={entering === pickup.stall}
                        className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-[12px] font-bold shrink-0 disabled:bg-gray-200 disabled:text-gray-400"
                      >
                        <Package className="w-4 h-4" />
                      </button>
                    )}
                    </div>

                    {/*
                      The handover code, entered where the stall it belongs to
                      is still on screen. A modal would cover the stall number
                      and the item list at exactly the moment the rider is
                      checking the bags against them.
                    */}
                    {entering === pickup.stall && !pickup.collected && (
                      <div className="mt-3 rounded-xl bg-gray-50 border border-gray-200 p-3">
                        <label
                          htmlFor={`code-${pickup.stall}`}
                          className="block text-[12px] font-bold text-gray-700"
                        >
                          Ask stall {pickup.stallNumber} for the 4-digit code
                        </label>
                        <div className="mt-2 flex gap-2">
                          <input
                            id={`code-${pickup.stall}`}
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={4}
                            autoFocus
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && code.length === 4) submitCode(pickup);
                            }}
                            placeholder="0000"
                            className="flex-1 min-w-0 h-11 px-3 text-[18px] font-black tabular-nums tracking-[0.35em] text-center text-gray-900 bg-white border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/30"
                          />
                          <button
                            onClick={() => submitCode(pickup)}
                            disabled={code.length !== 4 || busy}
                            className="px-4 rounded-lg bg-emerald-600 text-white text-[13px] font-bold shrink-0 disabled:bg-gray-200 disabled:text-gray-400"
                          >
                            {busy ? '…' : 'Collect'}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

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

        {/* Turn-by-turn is handed to the phone's own maps app, which has voice
            guidance and lane hints the in-app map deliberately does not try to
            reproduce. It follows the same leg the map is showing. */}
        {destination && (
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}&travelmode=driving`}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 flex items-center justify-center gap-1.5 text-[12.5px] font-bold"
          >
            <Navigation className="w-4 h-4" />
            {readyToLeave ? 'To customer' : 'To market'}
          </a>
        )}

        <button
          onClick={onDeliver}
          disabled={!readyToLeave || busy}
          className="flex-1 bg-gray-900 hover:bg-black text-white text-[14px] font-bold py-3 rounded-xl transition active:translate-y-px disabled:bg-gray-200 disabled:text-gray-400"
        >
          <span className="flex items-center justify-center gap-2">
            <PackageCheck className="w-4 h-4" />
            {readyToLeave ? 'Mark delivered' : 'Collect everything first'}
          </span>
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function Fact({ icon, label, value }) {
  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl px-2 py-1.5">
      <div className="flex items-center gap-1 text-gray-400 text-[10px] font-bold uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-[13px] font-extrabold text-gray-900 truncate">{value}</div>
    </div>
  );
}

function remainingSeconds(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}

/** Straight-line metres between the rider and a point, or null without a fix. */
function distanceBetween(from, to) {
  if (!from || to?.lat == null || to?.lng == null) return null;

  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function formatDistance(metres) {
  if (metres == null) return null;
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

function formatPaise(paise) {
  const rupees = (paise || 0) / 100;
  const fractionDigits = Number.isInteger(rupees) ? 0 : 2;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}
