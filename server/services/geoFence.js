'use strict';

const config = require('../config/env');

/**
 * The geometry behind market boundaries and "are you actually standing here?".
 *
 * Two jobs, kept together because they share a definition of the ring:
 *
 *  1. Turn a walked list of GPS nodes into a GeoJSON Polygon that MongoDB will
 *     accept, or say precisely why it will not.
 *  2. Decide whether a reported position falls inside a market.
 *
 * WHY THE CONTAINMENT TEST IS COMPUTED HERE RATHER THAN BY MONGO
 *
 * `$geoIntersects` would answer question 2 correctly, but it costs a round trip
 * on a path that already holds a transaction open (the join request writes a
 * Stall), and it cannot tell the caller HOW FAR outside they were — which is
 * the difference between "you are across town" and "your phone is 40 m off and
 * you are probably at the gate". That distance is what makes the tolerance
 * below defensible instead of arbitrary, and what the shopkeeper is shown.
 *
 * COORDINATE ORDER
 *
 * GeoJSON is [longitude, latitude]. Everything crossing the wire from a browser
 * is {lat, lng} because that is what the Geolocation API hands out. The
 * conversion happens exactly once, in `ringFromNodes`, and every function below
 * takes GeoJSON order. Reversing it puts an Indian market in the Indian Ocean —
 * the same trap called out on `Market.location`.
 */

const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the equirectangular approximation: the approximation is
 * fine over a market and wrong over a city, and this same function is used for
 * both the node-spacing check and the "how far outside were you" report.
 */
function haversineMeters(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A local metre-based frame centred on the ring.
 *
 * Every planar test below (self-intersection, area, point-in-polygon, distance
 * to an edge) is done in this frame rather than in degrees. In degrees a metre
 * of longitude and a metre of latitude are different lengths everywhere except
 * the equator, so a polygon that is square on the ground is a rectangle in
 * degree space — which skews areas by ~15% at Indian latitudes and makes
 * "distance to the nearest edge" meaningless as a metre figure.
 *
 * Valid only over a small extent, which is exactly what a market is; the area
 * cap in `validateBoundary` is what keeps callers inside that assumption.
 */
function projector(originLat, originLng) {
  const metresPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metresPerDegLng = metresPerDegLat * Math.cos(toRad(originLat));
  return ([lng, lat]) => [(lng - originLng) * metresPerDegLng, (lat - originLat) * metresPerDegLat];
}

/** Do segments p1→p2 and p3→p4 cross? Endpoint touches do not count. */
function segmentsCross(p1, p2, p3, p4) {
  const orient = (a, b, c) => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    // A tolerance rather than an exact zero: these are floats derived from GPS,
    // and three nodes walked along a straight kerb are collinear in intent.
    if (Math.abs(v) < 1e-9) return 0;
    return v > 0 ? 1 : -1;
  };

  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);

  return d1 !== d2 && d3 !== d4;
}

/**
 * Does the ring cross itself?
 *
 * MongoDB refuses a self-intersecting polygon on a 2dsphere index, and it does
 * so with a driver-level error that would reach the shopkeeper as a 500. This
 * is here to turn a figure-of-eight walk — which is an easy mistake when you
 * are pacing a market and cut back through the middle — into a sentence that
 * says which two edges cross.
 *
 * O(n²) over at most `maxNodes` points. At 200 nodes that is 20k comparisons,
 * once, on a route a market owner hits a handful of times ever.
 */
function firstSelfIntersection(flat) {
  // `flat` is the open ring (no repeated closing point), projected to metres.
  const n = flat.length;

  for (let i = 0; i < n; i += 1) {
    const a1 = flat[i];
    const a2 = flat[(i + 1) % n];

    for (let j = i + 1; j < n; j += 1) {
      // Adjacent edges share an endpoint by construction, and the last edge is
      // adjacent to the first because the ring closes.
      const adjacent = j === i || (j + 1) % n === i || (i + 1) % n === j;
      if (adjacent) continue;

      if (segmentsCross(a1, a2, flat[j], flat[(j + 1) % n])) {
        return { a: i + 1, b: j + 1 };
      }
    }
  }

  return null;
}

/** Shoelace area of a projected ring, in square metres. Always positive. */
function ringAreaSqMeters(flat) {
  let twice = 0;
  for (let i = 0; i < flat.length; i += 1) {
    const [x1, y1] = flat[i];
    const [x2, y2] = flat[(i + 1) % flat.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/** Signed area — the sign is the winding direction. Negative is clockwise. */
function signedArea(flat) {
  let twice = 0;
  for (let i = 0; i < flat.length; i += 1) {
    const [x1, y1] = flat[i];
    const [x2, y2] = flat[(i + 1) % flat.length];
    twice += x1 * y2 - x2 * y1;
  }
  return twice / 2;
}

/** Ray casting. `point` and `flat` are both in the projected metre frame. */
function pointInFlatRing(point, flat) {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = flat.length - 1; i < flat.length; j = i, i += 1) {
    const [xi, yi] = flat[i];
    const [xj, yj] = flat[j];

    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/** Shortest distance from a projected point to a projected ring's edges. */
function distanceToFlatRing(point, flat) {
  let best = Infinity;

  for (let i = 0; i < flat.length; i += 1) {
    const [x1, y1] = flat[i];
    const [x2, y2] = flat[(i + 1) % flat.length];

    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    // A degenerate edge (two nodes dropped on the same spot) collapses to its
    // start rather than dividing by zero.
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - x1) * dx + (point[1] - y1) * dy) / lenSq));

    const px = x1 + t * dx;
    const py = y1 + t * dy;
    best = Math.min(best, Math.hypot(point[0] - px, point[1] - py));
  }

  return best;
}

/**
 * Walked nodes → a closed GeoJSON linear ring.
 *
 * Accepts the open ring the client collects (the owner walks a perimeter and
 * stops; they do not walk back onto their first footprint) and closes it here.
 * A client that DOES send the closing point is handled too — a duplicated final
 * node is dropped rather than producing a zero-length edge.
 */
function ringFromNodes(nodes) {
  const open = nodes.map((n) => [n.lng, n.lat]);

  if (open.length > 1) {
    const first = open[0];
    const last = open[open.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) open.pop();
  }

  return open;
}

/**
 * Is this walk a usable market boundary?
 *
 * Returns `{ ok: true, polygon, areaSqMeters, perimeterMeters }` or
 * `{ ok: false, code, message }`. Never throws for bad input — every rejection
 * here is a 400 the owner can act on, so each one names the fix.
 */
function validateBoundary(nodes) {
  const limits = config.marketBoundary;

  if (!Array.isArray(nodes) || nodes.length < limits.minNodes) {
    return {
      ok: false,
      code: 'BOUNDARY_TOO_FEW_NODES',
      message: `Walk at least ${limits.minNodes} corners before closing the boundary.`,
    };
  }

  if (nodes.length > limits.maxNodes) {
    return {
      ok: false,
      code: 'BOUNDARY_TOO_MANY_NODES',
      message: `A boundary can hold at most ${limits.maxNodes} points.`,
    };
  }

  const open = ringFromNodes(nodes);

  if (open.length < limits.minNodes) {
    return {
      ok: false,
      code: 'BOUNDARY_TOO_FEW_NODES',
      message: `Walk at least ${limits.minNodes} distinct corners before closing the boundary.`,
    };
  }

  const originLng = open.reduce((sum, p) => sum + p[0], 0) / open.length;
  const originLat = open.reduce((sum, p) => sum + p[1], 0) / open.length;
  const project = projector(originLat, originLng);
  const flat = open.map(project);

  /**
   * Two nodes on the same spot.
   *
   * Rejected rather than silently deduplicated: a repeated point almost always
   * means the owner tapped "drop a point" twice at one corner, and quietly
   * dropping one would leave them with a boundary of a different shape than the
   * one they think they walked.
   */
  for (let i = 0; i < flat.length; i += 1) {
    const next = flat[(i + 1) % flat.length];
    if (Math.hypot(flat[i][0] - next[0], flat[i][1] - next[1]) < 1) {
      return {
        ok: false,
        code: 'BOUNDARY_DUPLICATE_NODE',
        message: `Points ${i + 1} and ${((i + 1) % flat.length) + 1} are in the same place. Remove one.`,
      };
    }
  }

  const crossing = firstSelfIntersection(flat);
  if (crossing) {
    return {
      ok: false,
      code: 'BOUNDARY_SELF_INTERSECTS',
      message:
        `The boundary crosses itself between points ${crossing.a} and ${crossing.b}. ` +
        'Walk the outside edge in one direction without cutting back through the middle.',
    };
  }

  const areaSqMeters = ringAreaSqMeters(flat);

  if (areaSqMeters < limits.minAreaSqMeters) {
    return {
      ok: false,
      code: 'BOUNDARY_TOO_SMALL',
      message: `That encloses only ${Math.round(areaSqMeters)} m². Walk the full perimeter of the market.`,
    };
  }

  if (areaSqMeters > limits.maxAreaSqMeters) {
    return {
      ok: false,
      code: 'BOUNDARY_TOO_LARGE',
      message:
        `That encloses ${(areaSqMeters / 1e6).toFixed(2)} km², which is larger than a market. ` +
        'Check that every point was taken inside the market.',
    };
  }

  let perimeterMeters = 0;
  for (let i = 0; i < open.length; i += 1) {
    const [lng1, lat1] = open[i];
    const [lng2, lat2] = open[(i + 1) % open.length];
    perimeterMeters += haversineMeters({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
  }

  /**
   * Right-hand rule: GeoJSON wants an exterior ring wound counter-clockwise.
   *
   * MongoDB is famously lenient about this for small polygons and famously not
   * for large ones — a clockwise ring can be read as "everywhere on Earth
   * EXCEPT this market", which would make every containment test pass. Winding
   * it here costs nothing and removes the whole class of bug. The owner walked
   * whichever way the road goes; that is not a decision to push back to them.
   */
  const ordered = signedArea(flat) < 0 ? [...open].reverse() : open;

  return {
    ok: true,
    polygon: { type: 'Polygon', coordinates: [[...ordered, ordered[0]]] },
    areaSqMeters: Math.round(areaSqMeters),
    perimeterMeters: Math.round(perimeterMeters),
  };
}

/**
 * Where a reported position stands relative to a market.
 *
 * Prefers the walked boundary and falls back to a plain radius around the
 * market's centre point, because markets created before boundaries existed have
 * no polygon and must not become impossible to join.
 *
 * `toleranceMeters` is added OUTSIDE the polygon, never inside it. A consumer
 * phone in a covered market reports 20-60 m of error routinely, so demanding a
 * fix strictly inside the ring would reject the shopkeeper standing at their
 * own stall. The tolerance is what makes the test survive real GPS; the
 * accuracy ceiling in `checkPresence` is what stops it becoming meaningless.
 */
function locateAgainstMarket(market, point) {
  const boundary = market.boundary;

  if (boundary?.coordinates?.[0]?.length >= 4) {
    const ring = boundary.coordinates[0].slice(0, -1); // drop the repeated close
    const originLng = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
    const originLat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const project = projector(originLat, originLng);
    const flat = ring.map(project);
    const projected = project([point.lng, point.lat]);

    const inside = pointInFlatRing(projected, flat);
    const edgeDistance = distanceToFlatRing(projected, flat);

    return {
      basis: 'boundary',
      inside,
      // Signed: negative means "inside, this far from the nearest edge".
      metersOutside: inside ? -Math.round(edgeDistance) : Math.round(edgeDistance),
    };
  }

  const centre = {
    lat: market.location?.coordinates?.[1],
    lng: market.location?.coordinates?.[0],
  };

  if (typeof centre.lat !== 'number' || typeof centre.lng !== 'number') {
    return { basis: 'none', inside: false, metersOutside: null };
  }

  const distance = haversineMeters(centre, point);
  const radius = config.presence.fallbackRadiusMeters;

  return {
    basis: 'radius',
    inside: distance <= radius,
    metersOutside: Math.round(distance - radius),
  };
}

/**
 * Is this a fix we are willing to treat as evidence of being somewhere?
 *
 * WHAT THIS DOES AND DOES NOT PROVE, STATED PLAINLY
 *
 * Browser geolocation is self-reported. A determined person can hand us any
 * coordinates they like — a developer-tools override, a rooted phone, a mock
 * location provider. Nothing in this file changes that, and no amount of
 * checking here ever will.
 *
 * What it does do is close the accidental and the casual cases: a shopkeeper
 * applying from home, someone guessing at a market they have never visited,
 * and a stale cached fix from wherever the phone last had signal. That is worth
 * having, and it is the honest description of it. It is a filter, not a proof,
 * and the market owner's approval remains the thing that actually decides —
 * which is why a failed check is reported to the owner rather than being the
 * sole gate.
 *
 * Three independent conditions:
 *  - the fix is precise enough to be meaningful at market scale
 *  - the fix is recent, so a phone cannot replay one from this morning
 *  - the position lands inside the market, with the tolerance above
 */
function checkPresence(market, presence, { now = new Date() } = {}) {
  const limits = config.presence;

  const capturedAt = new Date(presence.capturedAt);
  const ageSeconds = (now.getTime() - capturedAt.getTime()) / 1000;

  /**
   * A fix stamped in the future is a clock problem, not a location problem.
   *
   * Allowed a small slack rather than rejected outright: phone clocks drift by
   * seconds routinely, and failing a genuine shopkeeper because their handset
   * is 30 seconds fast would be a support ticket nobody could diagnose.
   */
  if (ageSeconds < -limits.maxFixAgeSeconds) {
    return {
      ok: false,
      code: 'PRESENCE_CLOCK_SKEW',
      message: 'Your phone’s clock is out of step. Correct the time and try again.',
    };
  }

  if (ageSeconds > limits.maxFixAgeSeconds) {
    return {
      ok: false,
      code: 'PRESENCE_STALE',
      message: 'That location reading is too old. Take a fresh one where you are standing.',
    };
  }

  if (!Number.isFinite(presence.accuracyMeters) || presence.accuracyMeters > limits.maxAccuracyMeters) {
    return {
      ok: false,
      code: 'PRESENCE_INACCURATE',
      message:
        `Your phone reports its position to within ${Math.round(presence.accuracyMeters || 0)} m, ` +
        `which is too rough to confirm. Step outside or into the open and wait for the signal to settle.`,
    };
  }

  const located = locateAgainstMarket(market, presence);

  if (located.basis === 'none') {
    return {
      ok: false,
      code: 'MARKET_NOT_LOCATED',
      message: 'This market has no location set, so being here cannot be confirmed.',
    };
  }

  /**
   * The tolerance is widened by the fix's own reported error.
   *
   * A phone claiming ±8 m that lands 30 m out is somewhere it should not be. A
   * phone claiming ±60 m that lands 30 m out is consistent with standing on the
   * line. Treating those two identically would either reject honest applicants
   * or admit distant ones, depending on which fixed number was picked.
   */
  const allowance = limits.boundaryToleranceMeters + presence.accuracyMeters;

  if (!located.inside && located.metersOutside > allowance) {
    return {
      ok: false,
      code: 'PRESENCE_OUTSIDE',
      message:
        located.basis === 'boundary'
          ? `You are about ${located.metersOutside} m outside this market's boundary. Apply from inside the market.`
          : `You are about ${located.metersOutside} m beyond this market. Apply from inside the market.`,
      metersOutside: located.metersOutside,
    };
  }

  return {
    ok: true,
    basis: located.basis,
    inside: located.inside,
    metersOutside: located.metersOutside,
  };
}

module.exports = {
  haversineMeters,
  validateBoundary,
  locateAgainstMarket,
  checkPresence,
  // Exported for the tests, which assert on the geometry directly rather than
  // through a route — the arithmetic is the part worth pinning down.
  _internals: { projector, ringAreaSqMeters, pointInFlatRing, distanceToFlatRing, firstSelfIntersection },
};
