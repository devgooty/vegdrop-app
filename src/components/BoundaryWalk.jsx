import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crosshair,
  Footprints,
  Loader2,
  Satellite,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';

import { watchFixes, metersBetween, accuracyGrade } from '../services/geo';

/**
 * Walking a market's perimeter, corner by corner.
 *
 * The market owner stands at each corner of their market, waits for the signal
 * to settle, and drops a point. When they close the shape it becomes the
 * market's boundary — the fence a shopkeeper has to be inside to apply for a
 * stall.
 *
 * WHY A LIVE WATCH RATHER THAN A READING PER TAP
 *
 * A GPS receiver converges. The first fix after the radio wakes is routinely
 * ±100 m and tightens to ±5 m over the next several seconds as more satellites
 * lock. Asking for a fresh reading on each tap would take a cold one every
 * time, so the accuracy gate below would reject corner after corner and the
 * owner would have no idea why — the fix never gets the chance to settle. The
 * watch runs for the whole walk, the number on screen is live, and the gate is
 * something the user can watch themselves satisfy.
 *
 * WHY THE PREVIEW IS SVG AND NOT A MAP
 *
 * A basemap would cost the Leaflet chunk on a route that does not otherwise
 * load it, and it would not answer the question the owner actually has. They
 * are standing in the place; they do not need to be shown where it is. What
 * they need to see is whether the SHAPE they have walked is the shape they
 * meant — whether they missed a corner, doubled back, or crossed their own
 * path. A plain outline of their own points shows exactly that and nothing
 * else, at no bundle cost.
 */

/** Refuse a corner worse than this. Mirrors config.marketBoundary.maxNodeAccuracyMeters. */
const MAX_NODE_ACCURACY_M = 40;

/** Below this, two taps are the same corner — the server rejects it, so warn first. */
const MIN_NODE_SPACING_M = 1;

export default function BoundaryWalk({ title = 'Walk your market', initialNodes, onCancel, onDone }) {
  /**
   * Only nodes carrying a real accuracy may be resumed.
   *
   * A boundary read back from the server is a bare list of {lat, lng}: the
   * polygon is stored, the per-node precision that produced it is not. Seeding
   * the walk with those would show "±NaN m" against each corner, and — the part
   * that actually breaks — the server requires `accuracyMeters` on every node,
   * so closing the boundary would come back 400 from a screen that looked
   * finished. Resuming is therefore limited to a walk still in progress in this
   * session, where the readings are genuinely known.
   *
   * A re-walk consequently starts empty, which is also the honest shape for it:
   * the corners are being taken again. The outline being replaced stays visible
   * on the card behind this dialog.
   */
  const [nodes, setNodes] = useState(() =>
    (initialNodes || []).filter((n) => Number.isFinite(n?.accuracyMeters))
  );
  const [fix, setFix] = useState(null);
  const [error, setError] = useState(null);

  /**
   * The live watch, started once and stopped on unmount.
   *
   * The cleanup is not housekeeping — a `watchPosition` left running holds the
   * GPS radio awake, and this screen is used by someone walking around a market
   * on their own phone. Leaking it would flatten their battery over a shift.
   */
  useEffect(() => {
    const stop = watchFixes({
      onFix: (next) => {
        setFix(next);
        // Clearing on success matters: a transient timeout while walking under
        // a roof should not leave a red banner up once the signal returns.
        setError(null);
      },
      onError: (err) => setError(err.message),
    });
    return stop;
  }, []);

  const grade = accuracyGrade(fix?.accuracyMeters, { good: 15, usable: MAX_NODE_ACCURACY_M });
  const precise = Boolean(fix) && fix.accuracyMeters <= MAX_NODE_ACCURACY_M;

  const last = nodes[nodes.length - 1] || null;
  const sinceLast = fix && last ? metersBetween(last, fix) : null;

  /**
   * Too close to the previous corner to be a different one.
   *
   * Caught here as well as on the server because the server's rejection arrives
   * after the whole walk is submitted — at which point the owner has left the
   * market and cannot re-take the point.
   */
  const tooClose = sinceLast !== null && sinceLast < MIN_NODE_SPACING_M;

  const drop = useCallback(() => {
    if (!fix || !precise || tooClose) return;
    setNodes((prev) => [
      ...prev,
      { lat: fix.lat, lng: fix.lng, accuracyMeters: fix.accuracyMeters },
    ]);
  }, [fix, precise, tooClose]);

  const undo = useCallback(() => setNodes((prev) => prev.slice(0, -1)), []);

  const geometry = useMemo(() => describe(nodes), [nodes]);
  const enough = nodes.length >= 3;

  return (
    <div className="fixed inset-0 z-50 bg-[#1B1206]/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md sm:rounded-3xl rounded-t-3xl max-h-[95vh] overflow-y-auto">
        <header className="sticky top-0 bg-white/95 backdrop-blur px-4 pt-4 pb-3 border-b border-gray-100 flex items-center gap-2 z-10">
          <Footprints className="w-5 h-5 text-amber-700 shrink-0" />
          <h2 className="font-extrabold text-gray-900 flex-1 truncate">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel the walk"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 space-y-3">
          <p className="text-[12.5px] text-gray-500 leading-relaxed">
            Stand at a corner of your market, wait for the signal to settle, then drop a point.
            Walk the outside edge in one direction — do not cut back through the middle. Three
            corners is the minimum; more corners means a closer fit.
          </p>

          <SignalPanel fix={fix} grade={grade} error={error} />

          <ShapePreview nodes={nodes} live={fix} geometry={geometry} />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={drop}
              disabled={!precise || tooClose}
              className="flex-1 bg-amber-900 text-white text-sm font-bold py-3.5 rounded-2xl flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.99] transition"
            >
              <Crosshair className="w-4 h-4" />
              Drop point {nodes.length + 1}
            </button>

            <button
              type="button"
              onClick={undo}
              disabled={nodes.length === 0}
              aria-label="Remove the last point"
              className="w-12 h-12 rounded-2xl border border-gray-300 text-gray-600 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              <Undo2 className="w-4 h-4" />
            </button>
          </div>

          {/* Stated only when it would block the tap, so it reads as a reason
              rather than as constant nagging about signal quality. */}
          {!precise && fix && (
            <Note tone="warn">
              Signal is {grade.label}. Points need to be inside ±{MAX_NODE_ACCURACY_M} m — step away
              from roofs and walls and wait a few seconds.
            </Note>
          )}
          {tooClose && (
            <Note tone="warn">
              You are less than a metre from point {nodes.length}. Walk to the next corner before
              dropping another.
            </Note>
          )}

          <NodeList nodes={nodes} onUndo={undo} />

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-3 rounded-2xl text-sm font-bold text-gray-500 hover:bg-gray-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onDone(nodes)}
              disabled={!enough}
              className="flex-1 bg-[#1B4D3E] text-white text-sm font-bold py-3.5 rounded-2xl flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Check className="w-4 h-4" />
              {enough
                ? `Close the boundary (${nodes.length} points)`
                : `${3 - nodes.length} more point${3 - nodes.length === 1 ? '' : 's'} needed`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The live readout. The number is the thing the owner is waiting on, so it leads. */
function SignalPanel({ fix, grade, error }) {
  const tone = {
    good: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    ok: 'bg-amber-50 border-amber-200 text-amber-900',
    bad: 'bg-red-50 border-red-200 text-red-800',
  }[grade.tone];

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-3 flex items-start gap-2">
        <TriangleAlert className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
        <p className="text-[12.5px] text-red-800 font-semibold">{error}</p>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border p-3 flex items-center gap-3 ${tone}`}>
      {fix ? (
        <Satellite className="w-5 h-5 shrink-0" />
      ) : (
        <Loader2 className="w-5 h-5 shrink-0 animate-spin" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-extrabold text-lg tabular-nums">{fix ? grade.label : '—'}</span>
          <span className="text-[11.5px] font-bold uppercase tracking-wide opacity-70">
            accuracy
          </span>
        </div>
        <p className="text-[12px] opacity-80 leading-snug">{grade.hint}</p>
      </div>
    </div>
  );
}

/**
 * The walked shape, drawn from the points themselves.
 *
 * Projected to metres before drawing. Plotting raw degrees would stretch the
 * outline east-west by about 5% at Indian latitudes — enough that a square
 * market renders as a rectangle, and the owner corrects a shape that was never
 * wrong.
 */
function ShapePreview({ nodes, live, geometry }) {
  const W = 300;
  const H = 190;
  const PAD = 18;

  const points = useMemo(() => {
    if (nodes.length === 0) return null;

    const all = live ? [...nodes, live] : nodes;
    const originLat = all.reduce((s, n) => s + n.lat, 0) / all.length;
    const originLng = all.reduce((s, n) => s + n.lng, 0) / all.length;
    const mPerDegLat = 111320;
    const mPerDegLng = mPerDegLat * Math.cos((originLat * Math.PI) / 180);

    const project = (n) => ({
      x: (n.lng - originLng) * mPerDegLng,
      y: -(n.lat - originLat) * mPerDegLat, // SVG y grows downward
    });

    const projected = nodes.map(project);
    const livePoint = live ? project(live) : null;
    const every = livePoint ? [...projected, livePoint] : projected;

    const xs = every.map((p) => p.x);
    const ys = every.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // One scale for both axes, or the projection above is undone by the fit.
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const scale = Math.min(W - PAD * 2, H - PAD * 2) / span;

    const place = (p) => ({
      x: W / 2 + (p.x - (minX + maxX) / 2) * scale,
      y: H / 2 + (p.y - (minY + maxY) / 2) * scale,
    });

    return { corners: projected.map(place), live: livePoint ? place(livePoint) : null };
  }, [nodes, live]);

  return (
    <div className="rounded-2xl border border-gray-200 bg-[#FAF7F1] overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" role="img" aria-label="The shape you have walked so far">
        <defs>
          <pattern id="vd-walk-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0 L0 0 0 20" fill="none" stroke="#E7DFD1" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#vd-walk-grid)" />

        {!points ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-gray-400" fontSize="12" fontWeight="600">
            Your outline appears here
          </text>
        ) : (
          <>
            {points.corners.length >= 3 && (
              <polygon
                points={points.corners.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="rgba(11,122,55,0.13)"
                stroke="#0B7A37"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            )}

            {points.corners.length === 2 && (
              <line
                x1={points.corners[0].x}
                y1={points.corners[0].y}
                x2={points.corners[1].x}
                y2={points.corners[1].y}
                stroke="#0B7A37"
                strokeWidth="2"
              />
            )}

            {/* Where the walker is now, relative to what they have walked. */}
            {points.live && (
              <circle cx={points.live.x} cy={points.live.y} r="4" fill="#B45309" opacity="0.9" />
            )}

            {points.corners.map((p, i) => (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r="7" fill="#FFFFFF" stroke="#0B7A37" strokeWidth="2" />
                <text
                  x={p.x}
                  y={p.y + 3.5}
                  textAnchor="middle"
                  fontSize="9"
                  fontWeight="800"
                  fill="#0B7A37"
                >
                  {i + 1}
                </text>
              </g>
            ))}
          </>
        )}
      </svg>

      {geometry && (
        <div className="px-3 py-2 border-t border-gray-200 bg-white flex items-center gap-3 text-[11.5px] font-bold text-gray-600">
          <span>{geometry.areaLabel}</span>
          <span className="text-gray-300">·</span>
          <span>{geometry.perimeterLabel} walked</span>
        </div>
      )}
    </div>
  );
}

function NodeList({ nodes, onUndo }) {
  if (nodes.length === 0) return null;

  return (
    <ol className="space-y-1">
      {nodes.map((n, i) => {
        const step = i > 0 ? metersBetween(nodes[i - 1], n) : null;
        const isLast = i === nodes.length - 1;

        return (
          <li
            key={`${n.lat}-${n.lng}-${i}`}
            className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-gray-50 border border-gray-100"
          >
            <span className="w-5 h-5 rounded-full bg-[#0B7A37] text-white text-[10px] font-extrabold flex items-center justify-center shrink-0">
              {i + 1}
            </span>
            <span className="text-[12px] font-semibold text-gray-700 flex-1 tabular-nums truncate">
              {n.lat.toFixed(5)}, {n.lng.toFixed(5)}
            </span>
            <span className="text-[11px] text-gray-400 tabular-nums shrink-0">
              ±{Math.round(n.accuracyMeters)} m
              {step !== null && ` · ${Math.round(step)} m`}
            </span>
            {isLast && (
              <button
                type="button"
                onClick={onUndo}
                aria-label={`Remove point ${i + 1}`}
                className="text-gray-400 hover:text-red-600 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Note({ tone, children }) {
  const cls =
    tone === 'warn'
      ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-gray-50 border-gray-200 text-gray-600';
  return (
    <div className={`rounded-xl border px-3 py-2 text-[12px] font-semibold ${cls}`}>{children}</div>
  );
}

/**
 * Area and perimeter of the walk so far, for the strip under the preview.
 *
 * Approximate and clearly so — the server recomputes both and its numbers are
 * the ones stored. This exists to catch the gross mistake while the owner is
 * still standing in the market: an area reading of "0.4 km²" for a vegetable
 * market means a point was taken somewhere it should not have been.
 */
function describe(nodes) {
  if (nodes.length < 2) return null;

  const originLat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
  const mPerDegLat = 111320;
  const mPerDegLng = mPerDegLat * Math.cos((originLat * Math.PI) / 180);
  const flat = nodes.map((n) => [n.lng * mPerDegLng, n.lat * mPerDegLat]);

  let perimeter = 0;
  for (let i = 0; i < nodes.length - 1; i += 1) perimeter += metersBetween(nodes[i], nodes[i + 1]);
  // Closing leg, drawn as soon as the shape is a shape.
  if (nodes.length >= 3) perimeter += metersBetween(nodes[nodes.length - 1], nodes[0]);

  let twice = 0;
  for (let i = 0; i < flat.length; i += 1) {
    const [x1, y1] = flat[i];
    const [x2, y2] = flat[(i + 1) % flat.length];
    twice += x1 * y2 - x2 * y1;
  }
  const area = nodes.length >= 3 ? Math.abs(twice) / 2 : 0;

  return {
    areaLabel:
      nodes.length < 3
        ? 'Not a shape yet'
        : area >= 100000
          ? `~${(area / 1e6).toFixed(2)} km²`
          : `~${Math.round(area).toLocaleString('en-IN')} m²`,
    perimeterLabel: perimeter >= 1000 ? `${(perimeter / 1000).toFixed(2)} km` : `${Math.round(perimeter)} m`,
  };
}
