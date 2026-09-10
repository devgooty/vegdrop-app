'use strict';

/**
 * Clearing a rider to carry real orders.
 *
 * Delivery is self-registerable, so `role: 'delivery'` means only that somebody
 * proved a phone number. An offer carries the customer's name, phone, home
 * address and — on a COD order — their cash, so the gate between those two
 * facts is the point of this feature.
 *
 * The gate is in two places on purpose, and both are tested: the dispatch query
 * (what actually decides who is offered work) and the duty-status write (what
 * stops a rider waiting out a shift for offers that were never coming).
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

const User = require('../models/User');
const Market = require('../models/Market');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { findNearestRider } = require('../services/dispatch');
const { migrateRiderApproval } = require('../db/migrations');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

const LAT = 17.385;
const LNG = 78.4867;
const MARKET_POINT = { type: 'Point', coordinates: [LNG, LAT] };

/**
 * A rider standing at the market, on duty, with a fresh fix — i.e. everything
 * dispatch wants EXCEPT whatever the test is varying.
 */
async function seedRider({ approvalStatus = 'approved', dutyStatus = 'online' } = {}) {
  const session = await authenticatedUser('delivery');
  await User.updateOne(
    { _id: session.user._id },
    {
      $set: {
        'rider.approvalStatus': approvalStatus,
        'rider.dutyStatus': dutyStatus,
        'rider.lastLocation': { type: 'Point', coordinates: [LNG, LAT] },
        'rider.lastLocationAt': new Date(),
      },
    }
  );
  return session;
}

// --- The dispatch gate ------------------------------------------------------

test('an approved rider on duty is dispatchable', async () => {
  const rider = await seedRider();

  const found = await findNearestRider({ marketLocation: MARKET_POINT, excludeIds: [] });

  assert.ok(found, 'expected the rider to be offered work');
  assert.equal(String(found._id), String(rider.user._id));
});

/**
 * The finding this whole change exists to close: before the gate, this rider —
 * a stranger who proved one phone number minutes ago — would have been handed
 * the next pickup and with it a customer's home address.
 */
test('a pending rider is invisible to dispatch even when perfectly placed', async () => {
  await seedRider({ approvalStatus: 'pending' });

  const found = await findNearestRider({ marketLocation: MARKET_POINT, excludeIds: [] });

  assert.equal(found, null);
});

test('a rejected rider is invisible to dispatch', async () => {
  await seedRider({ approvalStatus: 'rejected' });

  const found = await findNearestRider({ marketLocation: MARKET_POINT, excludeIds: [] });

  assert.equal(found, null);
});

/**
 * Approval is re-read by dispatch on every round rather than trusted from
 * whenever the rider went on duty. Without this, withdrawing approval would not
 * take effect until the rider happened to toggle their own switch.
 */
test('withdrawing approval stops offers immediately, without the rider touching anything', async () => {
  const rider = await seedRider();
  assert.ok(await findNearestRider({ marketLocation: MARKET_POINT, excludeIds: [] }));

  await User.updateOne({ _id: rider.user._id }, { $set: { 'rider.approvalStatus': 'rejected' } });

  const after = await findNearestRider({ marketLocation: MARKET_POINT, excludeIds: [] });
  assert.equal(after, null, 'the rider is still marked online, and must still be skipped');
});

// --- The duty-status gate ---------------------------------------------------

test('a pending rider cannot go on duty, and is told why', async () => {
  const rider = await seedRider({ approvalStatus: 'pending', dutyStatus: 'offline' });

  const refused = await api()
    .patch('/api/rider/duty')
    .set(auth(rider.accessToken))
    .send({ dutyStatus: 'online' })
    .expect(403);

  assert.equal(refused.body.error.code, 'RIDER_NOT_APPROVED');

  const after = await User.findById(rider.user._id).lean();
  assert.equal(after.rider.dutyStatus, 'offline');
});

test('a rejected rider is told they were refused, not that they are waiting', async () => {
  const rider = await seedRider({ approvalStatus: 'rejected', dutyStatus: 'offline' });

  const refused = await api()
    .patch('/api/rider/duty')
    .set(auth(rider.accessToken))
    .send({ dutyStatus: 'online' })
    .expect(403);

  assert.equal(refused.body.error.code, 'RIDER_REJECTED');
});

test('an approved rider goes on duty normally', async () => {
  const rider = await seedRider({ dutyStatus: 'offline' });

  await api()
    .patch('/api/rider/duty')
    .set(auth(rider.accessToken))
    .send({ dutyStatus: 'online' })
    .expect(200);

  const after = await User.findById(rider.user._id).lean();
  assert.equal(after.rider.dutyStatus, 'online');
});

/**
 * Going OFF duty is never gated. An unapproved rider has nothing to switch off,
 * but refusing the call would be a needless error on the safe direction.
 */
test('going offline is not gated on approval', async () => {
  const rider = await seedRider({ approvalStatus: 'pending', dutyStatus: 'online' });

  await api()
    .patch('/api/rider/duty')
    .set(auth(rider.accessToken))
    .send({ dutyStatus: 'offline' })
    .expect(200);
});

// --- The open pool, which routes around dispatch entirely -------------------

/**
 * The hole that gating dispatch and the duty switch does NOT close.
 *
 * `findNearestRider` offers a job to one rider at a time. An order nobody
 * accepted falls into an open pool that any rider can claim outright, through
 * `POST /orders/:id/accept` — no offer, no dispatch query, no duty check. So
 * an unapproved account could become `assignedTo` on a real order and the next
 * `GET /orders` would hand it the customer's name, phone, exact address and,
 * on a COD order, the cash.
 */
async function openPoolOrder() {
  const customer = await authenticatedUser('customer');
  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: MARKET_POINT,
  });

  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 50,
  });

  return Order.create({
    orderNumber: `VD-${uniq()}`,
    customer: customer.user._id,
    market: market._id,
    marketName: market.name,
    customerName: 'Priya Sharma',
    phone: '9876543210',
    address: '12 Banjara Hills, Hyderabad',
    deliveryLocation: { type: 'Point', coordinates: [LNG, LAT] },
    items: [
      {
        product: product._id,
        name: 'Tomato',
        unitPricePaise: 4000,
        quantity: 2,
        lineTotalPaise: 8000,
      },
    ],
    subtotalPaise: 8000,
    deliveryFeePaise: 0,
    totalAmountPaise: 8000,
    // Cash on delivery, which is the version of this that carries money as well
    // as an address.
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    status: 'Preparing',
    assignedTo: null,
    fulfillment: { status: 'awaiting_rider', riderOffer: { openPool: true } },
  });
}

test('an unapproved rider cannot claim an open-pool order', async () => {
  const rider = await seedRider({ approvalStatus: 'pending' });
  const order = await openPoolOrder();

  const refused = await api()
    .post(`/api/rider/orders/${order._id}/accept`)
    .set(auth(rider.accessToken))
    .expect(403);

  assert.equal(refused.body.error.code, 'RIDER_NOT_APPROVED');

  const after = await Order.findById(order._id).lean();
  assert.equal(after.assignedTo, null, 'the order must not have been taken');
});

test('an unapproved rider is not shown the open pool at all', async () => {
  const rider = await seedRider({ approvalStatus: 'pending' });
  await openPoolOrder();

  const list = await api().get('/api/rider/orders').set(auth(rider.accessToken)).expect(200);

  assert.equal(list.body.data.offers.length, 0, 'advertising work it cannot take');
  assert.equal(list.body.data.assigned.length, 0);
});

test('an approved rider still sees and can claim the open pool', async () => {
  const rider = await seedRider();
  const order = await openPoolOrder();

  const list = await api().get('/api/rider/orders').set(auth(rider.accessToken)).expect(200);
  assert.equal(list.body.data.offers.length, 1);

  // The offer shape withholds the customer's details until the job is theirs.
  assert.equal(list.body.data.offers[0].phone, undefined);
  assert.equal(list.body.data.offers[0].address, undefined);
});

/**
 * Withdrawing approval must not strand an order already in someone's bag. A
 * rider keeps sight of what they hold so they can finish or hand it back.
 */
test('a rider whose approval is withdrawn mid-delivery still sees their own order', async () => {
  const rider = await seedRider();
  const order = await openPoolOrder();
  await Order.updateOne(
    { _id: order._id },
    { $set: { assignedTo: rider.user._id, 'fulfillment.status': 'collecting' } }
  );

  await User.updateOne({ _id: rider.user._id }, { $set: { 'rider.approvalStatus': 'rejected' } });

  const list = await api().get('/api/rider/orders').set(auth(rider.accessToken)).expect(200);

  assert.equal(list.body.data.assigned.length, 1);
  assert.equal(list.body.data.assigned[0].id, String(order._id));
});

// --- The developer's decision ----------------------------------------------

test('a developer approves a rider, and the rider can then work', async () => {
  const dev = await authenticatedUser('developer');
  const rider = await seedRider({ approvalStatus: 'pending', dutyStatus: 'offline' });

  const decided = await api()
    .post(`/api/developer/riders/${rider.user._id}/approval`)
    .set(auth(dev.accessToken))
    .send({ decision: 'approved' })
    .expect(200);

  assert.equal(decided.body.data.approvalStatus, 'approved');

  const after = await User.findById(rider.user._id).lean();
  assert.equal(String(after.rider.approvedBy), String(dev.user._id));
  assert.ok(after.rider.approvedAt);
});

test('rejecting takes the rider off duty and invalidates their session', async () => {
  const dev = await authenticatedUser('developer');
  const rider = await seedRider();
  const before = await User.findById(rider.user._id).lean();

  await api()
    .post(`/api/developer/riders/${rider.user._id}/approval`)
    .set(auth(dev.accessToken))
    .send({ decision: 'rejected', reason: 'Could not verify identity.' })
    .expect(200);

  const after = await User.findById(rider.user._id).lean();
  assert.equal(after.rider.approvalStatus, 'rejected');
  assert.equal(after.rider.rejectionReason, 'Could not verify identity.');
  // Left online, the app would go on telling them they are working.
  assert.equal(after.rider.dutyStatus, 'offline');
  // Forces the delivery app to re-establish and see the new state at once.
  assert.equal(after.tokenVersion, before.tokenVersion + 1);
});

test('only a developer decides — a market owner and the rider themselves cannot', async () => {
  const owner = await authenticatedUser('market_owner');
  const rider = await seedRider({ approvalStatus: 'pending' });

  /**
   * A rider is not scoped to a market, so a market owner clearing one would be
   * clearing them to work a competitor's market too.
   */
  await api()
    .post(`/api/developer/riders/${rider.user._id}/approval`)
    .set(auth(owner.accessToken))
    .send({ decision: 'approved' })
    .expect(403);

  // The obvious escalation: approve yourself.
  await api()
    .post(`/api/developer/riders/${rider.user._id}/approval`)
    .set(auth(rider.accessToken))
    .send({ decision: 'approved' })
    .expect(403);

  const after = await User.findById(rider.user._id).lean();
  assert.equal(after.rider.approvalStatus, 'pending');
});

test('the approval route only ever moves a delivery account', async () => {
  const dev = await authenticatedUser('developer');
  const customer = await authenticatedUser('customer');

  await api()
    .post(`/api/developer/riders/${customer.user._id}/approval`)
    .set(auth(dev.accessToken))
    .send({ decision: 'approved' })
    .expect(404);
});

test('a decision that is neither approved nor rejected is refused', async () => {
  const dev = await authenticatedUser('developer');
  const rider = await seedRider({ approvalStatus: 'pending' });

  await api()
    .post(`/api/developer/riders/${rider.user._id}/approval`)
    .set(auth(dev.accessToken))
    .send({ decision: 'developer' })
    .expect(400);
});

// --- Self-registration still works, and lands in the queue ------------------

test('a self-registered rider starts pending rather than being refused an account', async () => {
  /**
   * Asserted against the SCHEMA DEFAULT rather than through the test helper,
   * because the helper deliberately creates approved riders — a fixture stands
   * for somebody already working. What this test is actually about is the
   * account the registration route mints, and that account gets the default.
   *
   * The product decision this feature preserves: the account is real and the
   * app is usable from the first minute. What is gated is the one capability
   * that reaches a customer, not the sign-up.
   */
  const fresh = new User({ name: 'New Rider', phone: '9812345670', role: 'delivery' });

  assert.equal(fresh.rider.approvalStatus, 'pending');
  assert.equal(fresh.status, 'active');
});

test('the session tells a rider where they stand', async () => {
  const rider = await seedRider({ approvalStatus: 'rejected' });
  await User.updateOne(
    { _id: rider.user._id },
    { $set: { 'rider.rejectionReason': 'Documents did not match.' } }
  );

  const me = await api().get('/api/auth/me').set(auth(rider.accessToken)).expect(200);

  // `/auth/me` returns `{ user }` at the top level, not wrapped in `data`.
  assert.equal(me.body.user.riderApproval.status, 'rejected');
  assert.equal(me.body.user.riderApproval.reason, 'Documents did not match.');
});

test('a customer payload carries no rider approval field at all', async () => {
  const customer = await authenticatedUser('customer');

  const me = await api().get('/api/auth/me').set(auth(customer.accessToken)).expect(200);

  assert.equal(me.body.user.riderApproval, undefined);
});

// --- The migration ----------------------------------------------------------

/**
 * The compatibility case, and the one that would have caused a real incident.
 *
 * Every delivery account predating this field belongs to somebody already
 * working. Shipping a `pending` default without this would take a market's
 * whole delivery capacity offline at once, mid-shift.
 */
test('existing riders are grandfathered rather than locked out', async () => {
  const users = User.collection;

  await users.insertOne({
    name: 'Veteran Rider',
    phone: `9${uniq().slice(-9).padStart(9, '1')}`,
    role: 'delivery',
    status: 'active',
    tokenVersion: 0,
    // No `rider` key at all — exactly the shape a pre-feature document has.
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const { grandfathered } = await migrateRiderApproval();
  assert.equal(grandfathered, 1);

  const after = await users.findOne({ name: 'Veteran Rider' });
  assert.equal(after.rider.approvalStatus, 'approved');
  assert.ok(after.rider.approvedAt);
  // Nobody actually looked at this account, so naming an approver would be a
  // false audit trail.
  assert.equal(after.rider.approvedBy, undefined);
});

test('the migration never re-approves someone a developer has rejected', async () => {
  const rider = await seedRider({ approvalStatus: 'rejected' });

  const { grandfathered } = await migrateRiderApproval();
  assert.equal(grandfathered, 0, 'matched on the field being absent, not on its value');

  const after = await User.findById(rider.user._id).lean();
  assert.equal(after.rider.approvalStatus, 'rejected');
});

test('the migration is idempotent across repeated boots', async () => {
  const users = User.collection;
  await users.insertOne({
    name: 'Another Veteran',
    phone: `9${uniq().slice(-9).padStart(9, '2')}`,
    role: 'delivery',
    status: 'active',
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  assert.equal((await migrateRiderApproval()).grandfathered, 1);
  assert.equal((await migrateRiderApproval()).grandfathered, 0);
});

// --- Self-modification guards, which compare ids ----------------------------

/**
 * `fields.objectId` accepts uppercase hex — a legitimate spelling of the same
 * id — while `toHexString()` always returns lowercase. Mongoose casts both to
 * the same document, so before the schema normalised its output, an admin
 * spelling their own id with one uppercase digit walked straight past every
 * `targetId === req.user._id.toHexString()` refusal and reached the write.
 *
 * Lives in this file because it surfaced from the same audit; the guard itself
 * is in routes/users.js.
 */
test('an admin cannot dodge the self-modification guard by uppercasing their id', async () => {
  const dev = await authenticatedUser('developer');
  const upper = String(dev.user._id).toUpperCase();

  assert.notEqual(upper, String(dev.user._id), 'the fixture must actually differ in case');

  const refused = await api()
    .patch(`/api/users/${upper}/role`)
    .set(auth(dev.accessToken))
    .send({ role: 'customer' })
    .expect(403);

  assert.match(refused.body.error.message, /your own role/i);

  const after = await User.findById(dev.user._id).lean();
  assert.equal(after.role, 'developer', 'the role must be untouched');
});

test('the same dodge is closed on status and delete', async () => {
  const dev = await authenticatedUser('developer');
  const upper = String(dev.user._id).toUpperCase();

  await api()
    .patch(`/api/users/${upper}/status`)
    .set(auth(dev.accessToken))
    .send({ status: 'suspended' })
    .expect(403);

  await api().delete(`/api/users/${upper}`).set(auth(dev.accessToken)).expect(403);

  const after = await User.findById(dev.user._id).lean();
  assert.equal(after.status, 'active');
});
