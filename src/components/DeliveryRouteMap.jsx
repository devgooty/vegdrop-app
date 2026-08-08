import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * The rider's live route.
 *
 * This replaces a map that never drew anything. The previous one was gated on a
 * global `window.L`, which does not exist — Leaflet is imported from npm and
 * deliberately absent from index.html — so every one of its effects returned on
 * the first line. Underneath that, the "rider" was a point interpolated between
 * two hardcoded Bangalore coordinates by a timer, so even had it rendered it
 * would have shown a fictional journey between two places the order had nothing
 * to do with.
 *
 * ONE LEG AT A TIME
 *
 * A delivery is two journeys, not one: ride to the market, walk the stalls, then
 * ride to the customer. Drawing both at once gives the rider a picture of a trip
 * nobody makes. `leg` follows the order's own fulfilment status, so the map
 * always answers "where am I going next" rather than "what is the shape of this
 * job".
 *
 * THE ROAD LINE IS BEST EFFORT
 *
 * Road geometry comes from OSRM's public demo server, which has no SLA and can
 * simply not answer. That must never be load-bearing: a rider with bags on the
 * bike needs the map now, so a failed or slow route degrades to a straight line
 * between the two points and the screen carries on. The straight line is drawn
 * dashed precisely so it does not read as a road.
 */

/** Where the rider is actually headed, given how far the order has got. */
export function activeLeg(status) {
  // dispatched means the bags are on the bike and the market is behind them.
  return status === 'dispatched' ? 'dropoff' : 'pickup';
}

const RIDER_ICON = L.divIcon({
  className: '',
  html: `<div style="
      width:22px;height:22px;border-radius:50%;
      background:#1B4D3E;border:3px solid #fff;
      box-shadow:0 0 0 2px rgba(27,77,62,.35), 0 2px 6px rgba(0,0,0,.3);
    "></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/** A labelled pin, so the two ends of the trip are never confused. */
function pinIcon(emoji, tint) {
  return L.divIcon({
    className: '',
    html: `<div style="
        display:flex;align-items:center;justify-content:center;
        width:32px;height:32px;border-radius:50% 50% 50% 8px;
        transform:rotate(-45deg);
        background:${tint};border:2px solid #fff;
        box-shadow:0 2px 6px rgba(0,0,0,.35);
      "><span style="transform:rotate(45deg);font-size:15px;line-height:1">${emoji}</span></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 30],
  });
}

const MARKET_ICON = pinIcon('🏪', '#B45309');
const CUSTOMER_ICON = pinIcon('🏠', '#EA580C');

/** Straight-line metres — used for the readout and the fallback line. */
export function metresBetween(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export function formatDistance(metres) {
  if (metres == null) return null;
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

/**
 * Keep both ends of the current leg on screen.
 *
 * Refits only when the destination changes, not on every GPS tick — a map that
 * re-zooms every few seconds while the rider is reading it is unusable. The
 * rider's own movement is followed by panning, which does not fight the zoom
 * level they may have set themselves.
 */
function FitLeg({ from, to, legKey }) {
  const map = useMap();
  const fittedFor = useRef(null);

  useEffect(() => {
    if (!from || !to) return;
    if (fittedFor.current === legKey) return;
    fittedFor.current = legKey;
    map.fitBounds(
      [
        [from.lat, from.lng],
        [to.lat, to.lng],
      ],
      { padding: [48, 48], maxZoom: 16 }
    );
  }, [map, from, to, legKey]);

  return null;
}

/**
 * Road geometry for one leg, or null while it is unknown.
 *
 * Refetched only when either end moves a meaningful distance. Without that the
 * GPS jitter of a stationary phone would fire a request every few seconds, which
 * is both pointless and a good way to get rate-limited off a shared demo server.
 */
function useRoadRoute(from, to) {
  const [route, setRoute] = useState(null);

  /**
   * A scalar key at ~100 m granularity, and the effect depends on THAT.
   *
   * Depending on `from` and `to` directly does not work, and fails in a way that
   * looks like an outage. Both are fresh objects on every render — the rider is
   * a new fix each GPS tick, the destination a new literal each poll — so React
   * tears the effect down roughly once a second, and the cleanup aborts the
   * request that is still in flight. The retry guard then sees the same
   * coordinates and returns early, so the route is never fetched again. The
   * road line only ever appeared when OSRM happened to answer faster than the
   * next re-render, which is why one leg drew properly and the next silently
   * stayed on the fallback.
   *
   * Rounding also does the throttling this needs on its own: a stationary phone
   * jitters well inside 100 m, so the key does not change and no request is
   * made.
   */
  const key =
    from && to
      ? [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(3)).join(',')
      : null;

  // Read through a ref so the request uses exact coordinates rather than the
  // rounded ones the key is built from.
  const latest = useRef({ from, to });
  latest.current = { from, to };

  useEffect(() => {
    if (!key) {
      setRoute(null);
      return undefined;
    }

    const { from: origin, to: destination } = latest.current;
    let cancelled = false;

    const controller = new AbortController();
    // A rider must not wait on a demo server; the straight line is already drawn.
    const timer = setTimeout(() => controller.abort(), 6000);

    (async () => {
      try {
        const url =
          'https://router.project-osrm.org/route/v1/driving/' +
          `${origin.lng},${origin.lat};${destination.lng},${destination.lat}` +
          '?overview=full&geometries=geojson';
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`OSRM ${res.status}`);

        const body = await res.json();
        if (cancelled) return;
        const leg = body?.routes?.[0];
        if (!leg?.geometry?.coordinates?.length) throw new Error('no geometry');

        setRoute({
          // GeoJSON is [lng, lat]; Leaflet wants [lat, lng]. Swapping these is
          // the classic way to end up drawing a route through the Indian Ocean.
          points: leg.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
          distanceMeters: Math.round(leg.distance),
          durationSeconds: Math.round(leg.duration),
        });
      } catch {
        // Deliberately silent. The straight-line fallback is already on screen
        // and there is nothing the rider could do about a routing outage. An
        // abort lands here too, and must not wipe a route the next leg is
        // already drawing.
        if (!cancelled) setRoute(null);
      } finally {
        clearTimeout(timer);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [from, to]);

  return route;
}

/**
 * @param {object} props
 * @param {{lat:number,lng:number}|null} props.rider   live GPS, null until the first fix
 * @param {{lat:number,lng:number}|null} props.market  pickup
 * @param {{lat:number,lng:number}|null} props.customer dropoff, null if never pinned
 * @param {string} props.status  the order's fulfilment status; picks the leg
 */
export default function DeliveryRouteMap({ rider, market, customer, status, height = 220 }) {
  const leg = activeLeg(status);
  const destination = leg === 'dropoff' ? customer : market;

  // Before the first GPS fix the map still has something worth showing: where
  // the order is going. Falling back to the destination beats an empty frame.
  const origin = rider || destination;
  const road = useRoadRoute(rider, destination);

  const straightLine = useMemo(() => {
    if (!rider || !destination) return null;
    return [
      [rider.lat, rider.lng],
      [destination.lat, destination.lng],
    ];
  }, [rider, destination]);

  const remainingMeters = road?.distanceMeters ?? metresBetween(rider, destination);

  if (!destination) {
    return (
      <div
        style={{ height }}
        className="rounded-2xl bg-gray-100 border border-gray-200 flex items-center justify-center px-6"
      >
        <p className="text-[12px] text-gray-500 text-center leading-snug">
          {leg === 'dropoff'
            ? 'This customer never pinned their address on the map, so there is nothing to route to. Use the written address and call them if you need to.'
            : 'This market has no location on file.'}
        </p>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl overflow-hidden border border-gray-200">
      <MapContainer
        center={[origin.lat, origin.lng]}
        zoom={14}
        scrollWheelZoom={false}
        attributionControl={false}
        style={{ height, width: '100%' }}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        <FitLeg from={rider || destination} to={destination} legKey={leg} />
        <FollowRider rider={rider} />

        {market && <Marker position={[market.lat, market.lng]} icon={MARKET_ICON} />}
        {customer && leg === 'dropoff' && (
          <Marker position={[customer.lat, customer.lng]} icon={CUSTOMER_ICON} />
        )}
        {rider && <Marker position={[rider.lat, rider.lng]} icon={RIDER_ICON} />}

        {road ? (
          <Polyline positions={road.points} pathOptions={{ color: '#1B4D3E', weight: 5, opacity: 0.85 }} />
        ) : (
          straightLine && (
            // Dashed on purpose: this is not a road, and it must not be read as one.
            <Polyline
              positions={straightLine}
              pathOptions={{ color: '#1B4D3E', weight: 3, opacity: 0.5, dashArray: '6 8' }}
            />
          )
        )}
      </MapContainer>

      <div className="absolute bottom-2 left-2 right-2 z-[400] flex items-center gap-2 pointer-events-none">
        <span className="bg-white/95 backdrop-blur px-2.5 py-1 rounded-lg text-[11.5px] font-bold text-gray-900 shadow">
          {leg === 'dropoff' ? '→ Customer' : '→ Market'}
          {remainingMeters != null && ` · ${formatDistance(remainingMeters)}`}
          {road?.durationSeconds != null && ` · ${Math.max(1, Math.round(road.durationSeconds / 60))} min`}
        </span>
        {!road && straightLine && (
          <span className="bg-amber-50/95 text-amber-800 px-2 py-1 rounded-lg text-[10.5px] font-semibold shadow">
            direct line
          </span>
        )}
        {!rider && (
          <span className="bg-amber-50/95 text-amber-800 px-2 py-1 rounded-lg text-[10.5px] font-semibold shadow">
            waiting for GPS
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Pan to keep the rider in frame without touching the zoom.
 *
 * Separate from FitLeg because the two answer different questions: the fit runs
 * once so both ends are visible, and this keeps up as the rider moves. Combining
 * them would re-zoom on every position update.
 */
function FollowRider({ rider }) {
  const map = useMap();

  useEffect(() => {
    if (!rider) return;
    if (map.getBounds().contains([rider.lat, rider.lng])) return;
    map.panTo([rider.lat, rider.lng], { animate: true });
  }, [map, rider]);

  return null;
}
