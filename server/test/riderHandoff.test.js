'use strict';

/**
 * What the rider is told, and when.
 *
 * The rider is the one role that legitimately needs the customer's name, phone
 * and door — but an offer cascades through up to four riders and can then sit in
 * an open pool every on-duty rider can see. Returning the full record on an
 * offer therefore handed a customer's home address and phone number to a queue
 * of people, most of whom decline. These pin the line: coarse until accepted,
 * complete afterwards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  createUser,
  authenticatedUser,
} = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');
const sourcing = require('../services/sourcing');
const dispatch = require('../services/dispatch');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedMarket({ lng = 78.4867, lat = 17.385 } = {}) {
  return Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Ring Road, Mehdipatnam, Hyderabad',
    location: { type: 'Point', coordinates: [lng, lat] },
  });
}

async function seedStall(market, stallNumber, { name, contactPhone } = {}) {
  const { user: owner } = await createUser({ role: 'shopkeeper' });
  return Stall.create({
    market: market._id,
    stallNumber,
    name: name || `Stall ${stallNumber}`,
    owner: owner._id,
    contactPhone: contactPhone || '',
    status: 'approved',
  });
}

/** A signed-in rider standing near the market, on duty and freshly pinged. */
async function seedRider(market, { metresEast = 200 } = {}) {
  const rider = await authenticatedUser('delivery');
  const [lng, lat] = market.location.coordinates;
  const offsetDeg = metresEast / (111320 * Math.cos((lat * Math.PI) / 180));

  await User.updateOne(
    { _id: rider.user._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: [lng + offsetDeg, lat] },
        'rider.lastLocationAt': new Date(),
      },
    }
  );

  return rider;
}

/** An order every stall has claimed, therefore sitting in `packing`. */
async function seedPackingOrder({ market, stall, address = '12 Banjara Hills, Hyderabad' }) {
  const { user: customer } = await createUser({ role: 'customer' });
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 500,
  });

  const items = [
    {
      product: product._id,
      name: product.name,
      unitPricePaise: 4000,
      quantity: 3,
      lineTotalPaise: 12000,
      lineId: new mongoose.Types.ObjectId(),
      sourcePricePaise: 4000,
      claim: sourcing.emptyClaim(),
    },
  ];

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address,
    // Pinned a few hundred metres from the market, so the dropoff distance is a
    // real measurement rather than a null the assertions could not tell from a
    // bug.
    deliveryLocation: {
      type: 'Point',
      coordinates: [market.location.coordinates[0] + 0.02, market.location.coordinates[1]],
    },
    items,
    subtotalPaise: 12000,
    totalAmountPaise: 12000,
    paymentMethod: 'cod',
    status: 'Pending',
    market: market._id,
    marketName: market.name,
    fulfillment: sourcing.initialFulfillment(market._id),
  });

  await sourcing.claimLines({
    orderId: order._id,
    stallId: stall._id,
    stallNumber: stall.stallNumber,
    lineIds: items.map((i) => i.lineId),
  });
  await sourcing.settlePending();

  return { order: await Order.findById(order._id), customer };
}

/** Every value that must never appear on an offer. */
function assertNoCustomerDetails(payload, customer) {
  const serialised = JSON.stringify(payload);

  assert.equal(payload.customerName, undefined, 'an offer must not name the customer');
  assert.equal(payload.phone, undefined, 'an offer must not carry the customer phone');
  assert.equal(payload.address, undefined, 'an offer must not carry the exact address');
  assert.equal(payload.deliveryLat, undefined, 'an offer must not carry the exact pin');
  assert.equal(payload.deliveryLng, undefined, 'an offer must not carry the exact pin');

  // Belt and braces: the values must not reach the wire under any other key.
  assert.ok(!serialised.includes(customer.phone), 'the phone leaked under another field');
  assert.ok(!serialised.includes(customer.name), 'the name leaked under another field');
}

// ---------------------------------------------------------------------------
// Before accepting
// ---------------------------------------------------------------------------

test('an offer carries no customer name, phone, address or pin', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { customer } = await seedPackingOrder({ market, stall });

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.offers.length, 1, 'the nearest rider should have been offered it');
  assertNoCustomerDetails(res.body.data.offers[0], customer);
});

test('an offer carries what the decision actually rests on', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  await seedPackingOrder({ market, stall });

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));
  const offer = res.body.data.offers[0];

  assert.equal(offer.marketName, 'Rythu Bazaar');
  assert.equal(offer.marketAddress, 'Ring Road, Mehdipatnam, Hyderabad');
  assert.equal(offer.marketLat, 17.385, 'lat and lng must not be swapped');
  assert.equal(offer.marketLng, 78.4867);
  assert.equal(offer.stallCount, 1);
  assert.equal(offer.itemCount, 3, 'how much there is to carry');
  assert.equal(offer.paymentMethod, 'cod');
  assert.equal(offer.totalAmountPaise, 12000, 'cash to collect is part of judging the job');
  assert.ok(offer.dropoffDistanceMeters > 0, 'how far the drop is from the market');
  assert.ok(offer.offerExpiresAt, 'how long there is to answer');
});

/**
 * "Banjara Hills, Hyderabad" tells a rider which side of the city they are
 * riding to; "12 Banjara Hills" tells them which door, which is not theirs to
 * know yet.
 *
 * The two spellings below are the reason the door is stripped token by token
 * rather than by dropping the first comma-separated component. In the second,
 * the number and the locality share a component, so dropping the component
 * would leave the bare city — technically private, and useless.
 */
test('the dropoff area names the locality but not the door', async () => {
  const market = await seedMarket();
  const rider = await seedRider(market);

  const cases = [
    ['12 Banjara Hills, Hyderabad', 'Banjara Hills, Hyderabad'],
    ['Flat 4B, Banjara Hills, Hyderabad', 'Banjara Hills, Hyderabad'],
    ['H.No 8-2-120, Road No 2, Jubilee Hills, Hyderabad', 'Jubilee Hills, Hyderabad'],
    ['Flat 4B Sunrise Apartments', 'Sunrise Apartments'],
  ];

  for (const [address, expected] of cases) {
    await resetDatabase();
    const freshMarket = await seedMarket();
    const stall = await seedStall(freshMarket, 'A-1');
    const freshRider = await seedRider(freshMarket);
    await seedPackingOrder({ market: freshMarket, stall, address });

    const res = await api().get('/api/rider/orders').set(auth(freshRider.accessToken));
    const offer = res.body.data.offers[0];

    assert.equal(offer.dropoffArea, expected, `for "${address}"`);
    assert.ok(!/\d/.test(offer.dropoffArea), `a number survived in "${offer.dropoffArea}"`);
  }

  // Silences the unused-binding lint on the outer fixtures; the loop reseeds.
  assert.ok(rider.accessToken);
});

test('an address that is nothing but a number yields no area at all', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  await seedPackingOrder({ market, stall, address: '12' });

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));

  assert.equal(
    res.body.data.offers[0].dropoffArea,
    null,
    'there is nothing safe to say about an address that is only a door number'
  );
});

/**
 * The open pool is the widest exposure in the system: every on-duty rider can
 * see it, not just the four the cascade asked.
 */
test('an order in the open pool still withholds the customer details', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order, customer } = await seedPackingOrder({ market, stall });

  await dispatch.openToPool(order._id);

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));

  assert.equal(res.body.data.offers.length, 1);
  assertNoCustomerDetails(res.body.data.offers[0], customer);
});

// ---------------------------------------------------------------------------
// After accepting
// ---------------------------------------------------------------------------

test('accepting hands over the full record', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order, customer } = await seedPackingOrder({ market, stall });

  const res = await api()
    .post(`/api/rider/orders/${order._id}/accept`)
    .set(auth(rider.accessToken));

  assert.equal(res.status, 200);
  const job = res.body.data;

  assert.equal(job.customerName, customer.name);
  assert.equal(job.phone, customer.phone);
  assert.equal(job.address, '12 Banjara Hills, Hyderabad');
  assert.equal(job.deliveryLat, 17.385, 'lat and lng must not be swapped on the way out');
  assert.ok(job.deliveryLng > 78, 'the exact pin is now theirs to navigate to');
  assert.equal(job.marketLat, 17.385);
});

test('the accepted job stays complete on the next poll', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order, customer } = await seedPackingOrder({ market, stall });

  await api().post(`/api/rider/orders/${order._id}/accept`).set(auth(rider.accessToken));

  const res = await api().get('/api/rider/orders').set(auth(rider.accessToken));

  assert.equal(res.body.data.offers.length, 0);
  assert.equal(res.body.data.assigned.length, 1);
  assert.equal(res.body.data.assigned[0].customerName, customer.name);
  assert.equal(res.body.data.assigned[0].phone, customer.phone);
});

/**
 * A rider standing in front of a shuttered pitch needs a way to reach the
 * trader. The number lives on Stall, not on the claim, so the round has to be
 * joined against it — and it must not appear before the job is theirs.
 */
test('the round names each stall and carries its phone, once accepted', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1', {
    name: 'Ramesh Vegetables',
    contactPhone: '9876500123',
  });
  const rider = await seedRider(market);
  const { order } = await seedPackingOrder({ market, stall });

  const offer = await api().get('/api/rider/orders').set(auth(rider.accessToken));
  assert.equal(offer.body.data.offers[0].pickups, undefined, 'the round is not part of a decision');

  const res = await api()
    .post(`/api/rider/orders/${order._id}/accept`)
    .set(auth(rider.accessToken));

  const pickup = res.body.data.pickups[0];
  assert.equal(pickup.stallNumber, 'A-1');
  assert.equal(pickup.stallName, 'Ramesh Vegetables');
  assert.equal(pickup.stallPhone, '9876500123');
});

/**
 * The number is what the round is ordered by, and it is denormalised onto the
 * claim precisely so it survives the stall record going away. Losing the stall
 * must cost the name and phone, not the walking order.
 */
test('a stall deleted after claiming still appears on the round by number', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);
  const { order } = await seedPackingOrder({ market, stall });

  await Stall.deleteOne({ _id: stall._id });

  const res = await api()
    .post(`/api/rider/orders/${order._id}/accept`)
    .set(auth(rider.accessToken));

  assert.equal(res.status, 200);
  const pickup = res.body.data.pickups[0];
  assert.equal(pickup.stallNumber, 'A-1');
  assert.equal(pickup.stallName, null);
  assert.equal(pickup.stallPhone, null);
});

/**
 * Requirement one, end to end: the shopkeeper accepting is what summons a rider.
 * Nothing else has to run, and no sweeper tick is waited for.
 */
test('a rider is offered the pickup the moment the stalls have claimed everything', async () => {
  const market = await seedMarket();
  const stall = await seedStall(market, 'A-1');
  const rider = await seedRider(market);

  // seedPackingOrder claims the lines and settles the fire-and-forget dispatch.
  const { order } = await seedPackingOrder({ market, stall });

  const fresh = await Order.findById(order._id).lean();
  assert.equal(fresh.fulfillment.status, 'packing');
  assert.equal(
    String(fresh.fulfillment.riderOffer.rider),
    String(rider.user._id),
    'claiming the last line should have called the nearest rider straight away'
  );
});
