'use strict';

/**
 * Walking a market's boundary, and being checked against it.
 *
 * Covers the three routes the feature adds — creating a market with a walked
 * perimeter, redrawing one, and applying to trade inside it — plus the stall
 * number lookup that stops an applicant proposing a pitch that is already let.
 *
 * The invariant these are really guarding is that a market with NO boundary
 * goes on working exactly as before. Every market in an existing database has a
 * null boundary, and a check that treated absence as "refuse everyone" would
 * lock every shopkeeper out of every market on the day it deployed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
} = require('./helpers');

const Market = require('../models/Market');
const Stall = require('../models/Stall');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

const LAT = 17.385;
const LNG = 78.4867;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

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

const inside = () => ({
  lat: LAT + 50 / M_PER_DEG_LAT,
  lng: LNG + 50 / M_PER_DEG_LNG,
  accuracyMeters: 10,
  capturedAt: new Date().toISOString(),
});

async function ownedMarket({ withBoundary = false } = {}) {
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [LNG, LAT] },
    owner: owner.user._id,
    ...(withBoundary
      ? {
          boundary: require('../services/geoFence').validateBoundary(square(100)).polygon,
          boundaryCapturedAt: new Date(),
          boundaryNodeCount: 4,
          boundaryAreaSqMeters: 10000,
        }
      : {}),
  });
  return { owner, market };
}

// --- Creating and redrawing -------------------------------------------------

test('a market owner creates a market by walking its perimeter', async () => {
  const owner = await authenticatedUser('market_owner');

  const created = await api()
    .post('/api/markets')
    .set(auth(owner.accessToken))
    .send({
      name: 'Mehdipatnam Rythu Bazaar',
      slug: `mkt-${uniq()}`,
      address: 'Mehdipatnam, Hyderabad',
      lat: LAT,
      lng: LNG,
      boundary: square(120),
    })
    .expect(201);

  assert.equal(created.body.data.boundary.nodeCount, 4);
  assert.ok(Math.abs(created.body.data.boundary.areaSqMeters - 14400) < 200);

  const stored = await Market.findById(created.body.data.id).lean();
  assert.equal(stored.boundary.type, 'Polygon');
  // Stored closed: five positions for four corners.
  assert.equal(stored.boundary.coordinates[0].length, 5);
  assert.equal(String(stored.owner), String(owner.user._id));
});

test('a market can still be created without walking anything', async () => {
  const owner = await authenticatedUser('market_owner');

  const created = await api()
    .post('/api/markets')
    .set(auth(owner.accessToken))
    .send({
      name: 'Desk Market',
      slug: `mkt-${uniq()}`,
      address: 'Somewhere',
      lat: LAT,
      lng: LNG,
    })
    .expect(201);

  assert.equal(created.body.data.boundary, null);
});

test('a self-crossing walk is refused with a message naming the points', async () => {
  const owner = await authenticatedUser('market_owner');
  const s = square(100);

  const refused = await api()
    .post('/api/markets')
    .set(auth(owner.accessToken))
    .send({
      name: 'Bowtie',
      slug: `mkt-${uniq()}`,
      address: 'Hyderabad',
      lat: LAT,
      lng: LNG,
      boundary: [s[0], s[1], s[3], s[2]],
    })
    .expect(400);

  assert.equal(refused.body.error.code, 'BOUNDARY_SELF_INTERSECTS');
});

test('a corner taken with poor precision is refused by index', async () => {
  const owner = await authenticatedUser('market_owner');
  const s = square(100);
  s[2].accuracyMeters = 250;

  const refused = await api()
    .post('/api/markets')
    .set(auth(owner.accessToken))
    .send({
      name: 'Sloppy',
      slug: `mkt-${uniq()}`,
      address: 'Hyderabad',
      lat: LAT,
      lng: LNG,
      boundary: s,
    })
    .expect(400);

  assert.equal(refused.body.error.code, 'BOUNDARY_NODE_INACCURATE');
  assert.match(refused.body.error.message, /Point 3/);
});

test('an owner redraws their own boundary and nobody else can', async () => {
  const { owner, market } = await ownedMarket();
  const stranger = await authenticatedUser('market_owner');

  const saved = await api()
    .put(`/api/markets/${market._id}/boundary`)
    .set(auth(owner.accessToken))
    .send({ nodes: square(200) })
    .expect(200);

  assert.equal(saved.body.data.boundary.nodeCount, 4);
  assert.ok(Math.abs(saved.body.data.areaSqMeters - 40000) < 500);

  await api()
    .put(`/api/markets/${market._id}/boundary`)
    .set(auth(stranger.accessToken))
    .send({ nodes: square(150) })
    .expect(403);
});

// --- The stall number lookup ------------------------------------------------

test('a stall number lookup reports free and taken, case-insensitively', async () => {
  const { market } = await ownedMarket();
  const trader = await authenticatedUser('shopkeeper');
  const applicant = await authenticatedUser('shopkeeper');

  await Stall.create({
    market: market._id,
    stallNumber: 'A-12',
    name: 'Ramesh Vegetables',
    owner: trader.user._id,
    status: 'approved',
    isActive: true,
  });

  const free = await api()
    .get(`/api/markets/${market._id}/stall-number-check?stallNumber=B-4`)
    .set(auth(applicant.accessToken))
    .expect(200);
  assert.equal(free.body.data.available, true);

  // A stall number is read off a painted sign; nobody types it the way the
  // sign painter did, so "a-12" must not report free.
  const taken = await api()
    .get(`/api/markets/${market._id}/stall-number-check?stallNumber=a-12`)
    .set(auth(applicant.accessToken))
    .expect(200);
  assert.equal(taken.body.data.available, false);
});

test('a pending application does not reserve a stall number', async () => {
  const { market } = await ownedMarket();
  const waiting = await authenticatedUser('shopkeeper');
  const applicant = await authenticatedUser('shopkeeper');

  await Stall.create({
    market: market._id,
    stallNumber: 'C-7',
    name: 'Hopeful Traders',
    owner: waiting.user._id,
    status: 'pending',
    isActive: false,
  });

  const check = await api()
    .get(`/api/markets/${market._id}/stall-number-check?stallNumber=C-7`)
    .set(auth(applicant.accessToken))
    .expect(200);

  // Uniqueness binds approved stalls only — two applicants guessing the same
  // wrong number must not collide before a human has looked at either.
  assert.equal(check.body.data.available, true);
});

test('a stall number containing regex characters is matched literally', async () => {
  const { market } = await ownedMarket();
  const trader = await authenticatedUser('shopkeeper');
  const applicant = await authenticatedUser('shopkeeper');

  await Stall.create({
    market: market._id,
    stallNumber: 'Shed 3/4',
    name: 'Corner Stall',
    owner: trader.user._id,
    status: 'approved',
    isActive: true,
  });

  // Unescaped, `.` would match any character and report this as taken.
  const other = await api()
    .get(`/api/markets/${market._id}/stall-number-check?stallNumber=${encodeURIComponent('Shed 3.4')}`)
    .set(auth(applicant.accessToken))
    .expect(200);
  assert.equal(other.body.data.available, true);
});

// --- Applying, with and without a fence -------------------------------------

test('a fenced market refuses an application with no location reading', async () => {
  const { market } = await ownedMarket({ withBoundary: true });
  const applicant = await authenticatedUser('shopkeeper');

  const refused = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(applicant.accessToken))
    .send({ stallNumber: 'D-2' })
    .expect(400);

  assert.equal(refused.body.error.code, 'PRESENCE_REQUIRED');
  assert.equal(await Stall.countDocuments({ owner: applicant.user._id }), 0);
});

test('a fenced market refuses an application from outside it', async () => {
  const { market } = await ownedMarket({ withBoundary: true });
  const applicant = await authenticatedUser('shopkeeper');

  const refused = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(applicant.accessToken))
    .send({
      stallNumber: 'D-2',
      presence: { ...inside(), lat: LAT + 0.02 },
    })
    .expect(403);

  assert.equal(refused.body.error.code, 'PRESENCE_OUTSIDE');
  assert.equal(await Stall.countDocuments({ owner: applicant.user._id }), 0);
});

test('an application from inside the market is accepted and the proof recorded', async () => {
  const { owner, market } = await ownedMarket({ withBoundary: true });
  const applicant = await authenticatedUser('shopkeeper');

  const applied = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(applicant.accessToken))
    .send({ stallNumber: 'D-2', presence: inside() })
    .expect(201);

  assert.equal(applied.body.data.presence.basis, 'boundary');
  assert.equal(applied.body.data.presence.inside, true);

  const stored = await Stall.findOne({ owner: applicant.user._id }).lean();
  assert.equal(stored.joinProof.basis, 'boundary');
  assert.ok(stored.joinProof.metersOutside <= 0, 'inside is recorded as a negative distance');

  // The evidence is the reason it is collected: it has to reach the owner's
  // queue, which is where the decision is actually made.
  const queue = await api()
    .get(`/api/markets/${market._id}/stall-requests`)
    .set(auth(owner.accessToken))
    .expect(200);

  assert.equal(queue.body.data[0].presence.inside, true);
});

/**
 * The compatibility case, and the most important test here.
 *
 * Every market in an existing database has a null boundary. If absence were
 * treated as "refuse", deploying this would lock every shopkeeper out of every
 * market at once.
 */
test('a market with no boundary still accepts an application with no reading', async () => {
  const { market } = await ownedMarket();
  const applicant = await authenticatedUser('shopkeeper');

  const applied = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(applicant.accessToken))
    .send({ stallNumber: 'E-1' })
    .expect(201);

  assert.equal(applied.body.data.presence, null);
});

/**
 * A reading offered to an unfenced market is judged and recorded either way —
 * including when it fails. It is not grounds to refuse, because the market
 * never declared a footprint to be outside of, but the owner should see it.
 */
test('a failed reading against an unfenced market is recorded, not refused', async () => {
  const { market } = await ownedMarket();
  const applicant = await authenticatedUser('shopkeeper');

  const applied = await api()
    .post(`/api/markets/${market._id}/join`)
    .set(auth(applicant.accessToken))
    .send({ stallNumber: 'E-9', presence: { ...inside(), lat: LAT + 0.05 } })
    .expect(201);

  assert.equal(applied.body.data.presence.basis, 'radius');
  assert.equal(applied.body.data.presence.inside, false);
  assert.ok(applied.body.data.presence.metersOutside > 0);
});

test('the presence pre-check answers without creating anything', async () => {
  const { market } = await ownedMarket({ withBoundary: true });
  const applicant = await authenticatedUser('shopkeeper');

  const good = await api()
    .post(`/api/markets/${market._id}/presence-check`)
    .set(auth(applicant.accessToken))
    .send({ presence: inside() })
    .expect(200);
  assert.equal(good.body.data.ok, true);

  // A failed check is a 200 with ok:false — the request was well formed and
  // "you are outside" is the answer, not an error.
  const bad = await api()
    .post(`/api/markets/${market._id}/presence-check`)
    .set(auth(applicant.accessToken))
    .send({ presence: { ...inside(), lat: LAT + 0.02 } })
    .expect(200);
  assert.equal(bad.body.data.ok, false);
  assert.equal(bad.body.data.code, 'PRESENCE_OUTSIDE');

  assert.equal(await Stall.countDocuments({}), 0);
});

/**
 * The public single-market read must not publish the footprint.
 *
 * `GET /:id` is `optionalAuth`, so whatever it returns is world-readable. A
 * fence is only useful while its exact line is not handed to anyone who might
 * want to stand just inside it, and `toJSON()` would have included the raw
 * polygon — the same disclosure `publicMarket` already declines to make.
 */
test('the public market read exposes that a boundary exists, never its shape', async () => {
  const { market } = await ownedMarket({ withBoundary: true });

  const anonymous = await api().get(`/api/markets/${market._id}`).expect(200);

  assert.equal(anonymous.body.data.hasBoundary, true);
  assert.equal(anonymous.body.data.boundary, undefined);
});

test('an owner reading their own market list gets the outline back', async () => {
  const { owner } = await ownedMarket({ withBoundary: true });

  const mine = await api().get('/api/markets/mine').set(auth(owner.accessToken)).expect(200);

  assert.equal(mine.body.data[0].boundary.nodeCount, 4);
  assert.equal(mine.body.data[0].boundary.nodes.length, 4, 'the closing point is not repeated');
});

test('a settings patch does not blank the boundary', async () => {
  const { owner, market } = await ownedMarket({ withBoundary: true });

  const patched = await api()
    .patch(`/api/markets/${market._id}`)
    .set(auth(owner.accessToken))
    .send({ contactPhone: '9000000099' })
    .expect(200);

  // Same shape as every other market response on this router, so a client
  // merging it cannot silently replace a good fence with a different shape.
  assert.equal(patched.body.data.boundary.nodeCount, 4);
  assert.ok(Array.isArray(patched.body.data.boundary.nodes));
});

test('the joinable market list says which markets check you are on site', async () => {
  await ownedMarket({ withBoundary: true });
  const applicant = await authenticatedUser('shopkeeper');

  const list = await api().get('/api/markets').set(auth(applicant.accessToken)).expect(200);

  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].hasBoundary, true);
  // The outline itself is not handed out — only the fact that there is one.
  assert.equal(list.body.data[0].boundary, undefined);
});
