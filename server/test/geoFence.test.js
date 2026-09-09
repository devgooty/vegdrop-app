'use strict';

/**
 * The geometry behind market boundaries and on-site checks.
 *
 * Tested directly rather than through a route, because the arithmetic is the
 * part that can be quietly wrong. A route test would confirm that a walk is
 * accepted and rejected in the obvious cases; it would not notice that the area
 * is out by 15% because longitude was treated as the same length as latitude,
 * or that a clockwise ring reads as "everywhere on Earth except this market".
 *
 * No database, so no test server — this file is pure functions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const geoFence = require('../services/geoFence');
const config = require('../config/env');

/** Hyderabad. Far enough from the equator that a bad projection shows up. */
const LAT = 17.385;
const LNG = 78.4867;

/** Metres to degrees at this latitude, so the fixtures are stated in metres. */
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

/** A square of `side` metres with its south-west corner at the origin above. */
function square(side, { accuracyMeters = 8 } = {}) {
  const dLat = side / M_PER_DEG_LAT;
  const dLng = side / M_PER_DEG_LNG;
  return [
    { lat: LAT, lng: LNG, accuracyMeters },
    { lat: LAT, lng: LNG + dLng, accuracyMeters },
    { lat: LAT + dLat, lng: LNG + dLng, accuracyMeters },
    { lat: LAT + dLat, lng: LNG, accuracyMeters },
  ];
}

const centreOf = (side) => ({
  lat: LAT + side / 2 / M_PER_DEG_LAT,
  lng: LNG + side / 2 / M_PER_DEG_LNG,
});

test('a walked square measures its real area, not its area in degrees', () => {
  const result = geoFence.validateBoundary(square(100));

  assert.equal(result.ok, true);

  /**
   * The tolerance is 1%, and it is the point of the assertion.
   *
   * Plotting these same points in raw degrees and taking the shoelace area
   * gives a figure ~9% adrift at this latitude, because a degree of longitude
   * here is about 0.954 of a degree of latitude. A loose tolerance would let
   * that through; this one does not.
   */
  assert.ok(
    Math.abs(result.areaSqMeters - 10000) < 100,
    `expected ~10000 m², got ${result.areaSqMeters}`
  );
  assert.ok(Math.abs(result.perimeterMeters - 400) < 4);
});

test('the stored ring is closed and wound counter-clockwise', () => {
  // Walked clockwise. GeoJSON wants the exterior ring the other way, and a
  // clockwise ring can be read by MongoDB as the whole planet MINUS the
  // market — which would make every containment test pass.
  const clockwise = [...square(100)].reverse();
  const result = geoFence.validateBoundary(clockwise);

  assert.equal(result.ok, true);

  const ring = result.polygon.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'ring must repeat its first point last');

  let twice = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    twice += x1 * y2 - x2 * y1;
  }
  assert.ok(twice > 0, 'signed area must be positive, i.e. counter-clockwise');
});

test('a walk that crosses itself is refused, naming the two points', () => {
  const s = square(100);
  const bowtie = [s[0], s[1], s[3], s[2]];

  const result = geoFence.validateBoundary(bowtie);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BOUNDARY_SELF_INTERSECTS');
  assert.match(result.message, /\d+ and \d+/, 'message should name the crossing points');
});

test('two points in the same place are refused rather than deduplicated', () => {
  const s = square(100);
  const result = geoFence.validateBoundary([s[0], s[0], s[1], s[2]]);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BOUNDARY_DUPLICATE_NODE');
});

test('fewer than three corners encloses nothing', () => {
  const result = geoFence.validateBoundary(square(100).slice(0, 2));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BOUNDARY_TOO_FEW_NODES');
});

test('an area outside the configured bounds is refused at both ends', () => {
  const tiny = geoFence.validateBoundary(square(3));
  assert.equal(tiny.ok, false);
  assert.equal(tiny.code, 'BOUNDARY_TOO_SMALL');

  // 2 km on a side is 4 km², over the 2 km² ceiling.
  const huge = geoFence.validateBoundary(square(2000));
  assert.equal(huge.ok, false);
  assert.equal(huge.code, 'BOUNDARY_TOO_LARGE');
});

test('containment reports the signed distance to the nearest edge', () => {
  const market = { boundary: geoFence.validateBoundary(square(100)).polygon };

  const middle = geoFence.locateAgainstMarket(market, centreOf(100));
  assert.equal(middle.basis, 'boundary');
  assert.equal(middle.inside, true);
  // Dead centre of a 100 m square is 50 m from every edge, and inside is negative.
  assert.ok(Math.abs(middle.metersOutside + 50) <= 1, `got ${middle.metersOutside}`);

  const away = geoFence.locateAgainstMarket(market, { lat: LAT - 200 / M_PER_DEG_LAT, lng: LNG });
  assert.equal(away.inside, false);
  assert.ok(Math.abs(away.metersOutside - 200) <= 2, `got ${away.metersOutside}`);
});

test('a market with no boundary falls back to a radius around its pin', () => {
  const bare = { boundary: null, location: { coordinates: [LNG, LAT] } };

  const near = geoFence.locateAgainstMarket(bare, { lat: LAT, lng: LNG });
  assert.equal(near.basis, 'radius');
  assert.equal(near.inside, true);

  const far = geoFence.locateAgainstMarket(bare, { lat: LAT + 0.05, lng: LNG });
  assert.equal(far.inside, false);
});

// --- checkPresence ----------------------------------------------------------

const NOW = new Date('2026-09-09T06:00:00.000Z');

function fixture(overrides = {}) {
  return {
    ...centreOf(100),
    accuracyMeters: 10,
    capturedAt: new Date(NOW.getTime() - 5000),
    ...overrides,
  };
}

const fenced = () => ({
  boundary: geoFence.validateBoundary(square(100)).polygon,
  location: { coordinates: [LNG, LAT] },
});

test('a fresh, precise fix inside the market passes', () => {
  const result = geoFence.checkPresence(fenced(), fixture(), { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.inside, true);
});

test('an old fix is refused however good it otherwise looks', () => {
  const stale = fixture({
    capturedAt: new Date(NOW.getTime() - (config.presence.maxFixAgeSeconds + 60) * 1000),
  });

  const result = geoFence.checkPresence(fenced(), stale, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRESENCE_STALE');
});

test('a fix stamped in the future is a clock problem, not a location one', () => {
  const skewed = fixture({
    capturedAt: new Date(NOW.getTime() + (config.presence.maxFixAgeSeconds + 60) * 1000),
  });

  const result = geoFence.checkPresence(fenced(), skewed, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRESENCE_CLOCK_SKEW');
});

test('a fix too imprecise to distinguish the market from the street is refused', () => {
  const vague = fixture({ accuracyMeters: config.presence.maxAccuracyMeters + 1 });

  const result = geoFence.checkPresence(fenced(), vague, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRESENCE_INACCURATE');
});

test('a position well outside the boundary is refused, and says how far', () => {
  const elsewhere = fixture({ lat: LAT + 0.02 });

  const result = geoFence.checkPresence(fenced(), elsewhere, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRESENCE_OUTSIDE');
  assert.ok(result.metersOutside > 1000);
});

/**
 * The tolerance is what makes this survive real GPS, and it widens with the
 * fix's own reported error rather than being one fixed number.
 *
 * A phone claiming ±8 m that lands 60 m out is somewhere it should not be. A
 * phone claiming ±60 m that lands 60 m out is consistent with standing on the
 * line. Treating those identically would either reject honest applicants or
 * admit distant ones, and this is the case that pins the difference.
 */
test('the allowance grows with the reported accuracy of the fix', () => {
  const market = fenced();
  // 130 m south of the southern edge: beyond the 75 m base tolerance alone.
  const justOutside = { lat: LAT - 130 / M_PER_DEG_LAT, lng: LNG + 50 / M_PER_DEG_LNG };

  const precise = geoFence.checkPresence(
    market,
    fixture({ ...justOutside, accuracyMeters: 8 }),
    { now: NOW }
  );
  assert.equal(precise.ok, false, 'a precise fix that far out is genuinely elsewhere');

  const rough = geoFence.checkPresence(
    market,
    fixture({ ...justOutside, accuracyMeters: 90 }),
    { now: NOW }
  );
  assert.equal(rough.ok, true, 'the same position with an honestly rough fix is consistent');
});
