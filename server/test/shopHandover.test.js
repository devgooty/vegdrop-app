'use strict';

/**
 * The handover code for orders with no market — independent shops, and the
 * legacy marketless pool.
 *
 * The market side of this lives in pickupHandover.test.js and works stall by
 * stall. This side has one seller and one handover, and it closes a wider hole
 * than the market one did: `visibilityFilter` shows a delivery agent the whole
 * unclaimed pool, and the order document went back with the customer's name,
 * phone and door on it. Every agent on duty could read the addresses of orders
 * they had not claimed and were never going to carry.
 *
 * So there are two things to hold here. The code does what it says — one
 * seller, attempt-capped, resettable only by the shop. And the customer's
 * details are unreachable without it, including by the routes that look like
 * they might be a way round.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

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
const pickupCode = require('../services/pickupCode');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/**
 * A marketless order sitting in `Preparing`, i.e. bagged and waiting for a
 * rider. `shop` null makes it one of the legacy pool orders that every
 * shopkeeper can see — the widest case, and the one worth testing.
 */
async function seedShopOrder({ shop = null } = {}) {
  const { user: customer } = await createUser({ role: 'customer' });
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 500,
  });

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Banjara Hills, Hyderabad',
    deliveryLocation: { type: 'Point', coordinates: [78.45, 17.41] },
    items: [
      {
        product: product._id,
        name: product.name,
        unitPricePaise: 4000,
        quantity: 2,
        lineTotalPaise: 8000,
      },
    ],
    subtotalPaise: 8000,
    totalAmountPaise: 8000,
    paymentMethod: 'cod',
    status: 'Preparing',
    shop: shop ? shop.user._id : null,
    shopName: shop ? 'Ravi Vegetables' : null,
  });

  return { order, customer };
}

/** The order as this rider's `GET /api/orders` returns it. */
async function riderView(rider, orderId) {
  const res = await api().get('/api/orders?limit=100').set(auth(rider.accessToken));
  assert.equal(res.status, 200);
  return res.body.data.find((o) => o.id === orderId.toHexString());
}

// ---------------------------------------------------------------------------
// The leak this closes
// ---------------------------------------------------------------------------

test('an unclaimed order in the pool carries no customer name, phone or door', async () => {
  const rider = await authenticatedUser('delivery');
  const { order, customer } = await seedShopOrder();

  const seen = await riderView(rider, order._id);

  assert.ok(seen, 'the pool order should still be visible — it is claimable');
  assert.equal(seen.customerLocked, true);
  assert.equal(seen.customerName, undefined);
  assert.equal(seen.phone, undefined);
  assert.equal(seen.address, undefined);
  assert.equal(seen.deliveryLocation, undefined);

  const serialised = JSON.stringify(seen);
  assert.ok(!serialised.includes(customer.phone), 'the phone leaked under another key');
  assert.ok(!serialised.includes('12 Banjara Hills'), 'the door leaked under another key');
});

test('claiming alone does not reveal the customer', async () => {
  const rider = await authenticatedUser('delivery');
  const { order, customer } = await seedShopOrder();

  const claimed = await api()
    .post(`/api/orders/${order._id}/claim`)
    .set(auth(rider.accessToken));

  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.data.customerLocked, true);
  assert.equal(claimed.body.data.address, undefined);
  assert.ok(
    !JSON.stringify(claimed.body.data).includes(customer.phone),
    'a tap is not evidence of turning up'
  );
});

// ---------------------------------------------------------------------------
// Who can see the code
// ---------------------------------------------------------------------------

test('the shopkeeper sees a four-digit code on an order waiting for a rider', async () => {
  const shopkeeper = await authenticatedUser('shopkeeper');
  const { order } = await seedShopOrder();

  const res = await api().get('/api/orders?limit=100').set(auth(shopkeeper.accessToken));
  const seen = res.body.data.find((o) => o.id === order._id.toHexString());

  assert.ok(seen, 'a legacy pool order is visible to every shopkeeper');
  assert.match(seen.pickupCode, /^\d{4}$/);
  assert.equal(seen.pickupAttemptsRemaining, pickupCode.MAX_ATTEMPTS);
  // The shopkeeper redaction still applies — a shop never sees the customer.
  assert.equal(seen.address, undefined);
});

test('the rider is never sent the code', async () => {
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const seen = await riderView(rider, order._id);
  const expected = pickupCode.codeFor(order._id, 'legacy');

  assert.equal(seen.pickupCode, undefined);
  assert.ok(
    !JSON.stringify(seen).includes(expected),
    'shipping the answer to the person being asked would make the check theatre'
  );
});

// ---------------------------------------------------------------------------
// Picking up
// ---------------------------------------------------------------------------

test('the right code unlocks the customer and sends the order out', async () => {
  const rider = await authenticatedUser('delivery');
  const { order, customer } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const res = await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code: pickupCode.codeFor(order._id, 'legacy') });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.customerName, customer.name);
  assert.equal(res.body.data.phone, customer.phone);
  assert.equal(res.body.data.address, '12 Banjara Hills, Hyderabad');
  assert.equal(res.body.data.status, 'Out for Delivery', 'the rider leaving is what moves it');

  const fresh = await Order.findById(order._id);
  assert.ok(fresh.handover.pickedUpAt, 'the pickup is recorded');
  assert.equal(fresh.status, 'Out for Delivery');
});

test('a wrong code reveals nothing and counts down', async () => {
  const rider = await authenticatedUser('delivery');
  const { order, customer } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const right = pickupCode.codeFor(order._id, 'legacy');
  const wrong = String((Number(right) + 1) % 10000).padStart(4, '0');

  const res = await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code: wrong });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PICKUP_CODE_INVALID');
  assert.match(res.body.error.message, /4 attempts remaining/);

  const seen = await riderView(rider, order._id);
  assert.equal(seen.customerLocked, true);
  assert.ok(!JSON.stringify(seen).includes(customer.phone));
  assert.equal((await Order.findById(order._id)).status, 'Preparing', 'nothing moved');
});

test('the handover locks after enough wrong codes, and the right one is then refused', async () => {
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const right = pickupCode.codeFor(order._id, 'legacy');
  const wrong = String((Number(right) + 1) % 10000).padStart(4, '0');

  for (let i = 0; i < pickupCode.MAX_ATTEMPTS; i += 1) {
    await api()
      .post(`/api/orders/${order._id}/pickup`)
      .set(auth(rider.accessToken))
      .send({ code: wrong });
  }

  const res = await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code: right });

  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'PICKUP_ATTEMPTS_EXCEEDED');
});

test('a rider cannot pick up an order they have not claimed', async () => {
  const mine = await authenticatedUser('delivery');
  const other = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(mine.accessToken));

  const res = await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(other.accessToken))
    .send({ code: pickupCode.codeFor(order._id, 'legacy') });

  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_YOURS');
  assert.equal(
    (await Order.findById(order._id)).handover.attempts,
    0,
    'a stranger must not be able to burn the assigned rider’s attempts'
  );
});

test('a malformed code is rejected without costing an attempt', async () => {
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  for (const code of ['12', 'abcd', '123456', '']) {
    const res = await api()
      .post(`/api/orders/${order._id}/pickup`)
      .set(auth(rider.accessToken))
      .send({ code });
    assert.equal(res.status, 400, `"${code}" should not reach the comparison`);
  }

  assert.equal((await Order.findById(order._id)).handover.attempts, 0, 'a typo is not a guess');
});

test('a second pickup with the same code is a no-op rather than an error', async () => {
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const code = pickupCode.codeFor(order._id, 'legacy');
  const first = await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code });
  const second = await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'a double tap on a flaky connection must not read as failure');
  assert.equal(second.body.data.status, 'Out for Delivery');
});

// ---------------------------------------------------------------------------
// The ways round it, which must not work
// ---------------------------------------------------------------------------

/**
 * The Delivered branch of PATCH /:id/status claims an unassigned order for
 * whoever closes it, and `redactForViewer` used to treat a delivered order as
 * unlocked. Together that was a door: mark it delivered, then read the address.
 */
test('marking an order delivered is not a way to unlock the address', async () => {
  const rider = await authenticatedUser('delivery');
  const { order, customer } = await seedShopOrder();

  await api()
    .patch(`/api/orders/${order._id}/status`)
    .set(auth(rider.accessToken))
    .send({ status: 'Out for Delivery' })
    .catch(() => {});

  const closed = await api()
    .patch(`/api/orders/${order._id}/status`)
    .set(auth(rider.accessToken))
    .send({ status: 'Delivered' });

  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'PICKUP_NOT_VERIFIED');

  const seen = await riderView(rider, order._id);
  if (seen) {
    assert.ok(
      !JSON.stringify(seen).includes(customer.phone),
      'the address must not be reachable by closing the order'
    );
  }
});

test('delivering works normally once the pickup is proved', async () => {
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));
  await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code: pickupCode.codeFor(order._id, 'legacy') });

  const res = await api()
    .patch(`/api/orders/${order._id}/status`)
    .set(auth(rider.accessToken))
    .send({ status: 'Delivered' });

  assert.equal(res.status, 200);
  assert.equal((await Order.findById(order._id)).status, 'Delivered');
});

// ---------------------------------------------------------------------------
// Clearing a lock
// ---------------------------------------------------------------------------

test('the shopkeeper can clear a lock, and the code then works', async () => {
  const shopkeeper = await authenticatedUser('shopkeeper');
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const right = pickupCode.codeFor(order._id, 'legacy');
  const wrong = String((Number(right) + 1) % 10000).padStart(4, '0');
  for (let i = 0; i < pickupCode.MAX_ATTEMPTS; i += 1) {
    await api()
      .post(`/api/orders/${order._id}/pickup`)
      .set(auth(rider.accessToken))
      .send({ code: wrong });
  }

  const reset = await api()
    .post(`/api/orders/${order._id}/handover/reset`)
    .set(auth(shopkeeper.accessToken));

  assert.equal(reset.status, 200);
  assert.equal(reset.body.data.attemptsRemaining, pickupCode.MAX_ATTEMPTS);
  assert.equal(reset.body.data.pickupCode, right);

  const retried = await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code: right });

  assert.equal(retried.status, 200);
});

test('a rider cannot clear their own lock', async () => {
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const res = await api()
    .post(`/api/orders/${order._id}/handover/reset`)
    .set(auth(rider.accessToken));

  assert.equal(
    res.status,
    403,
    'self-service resets would hand the guesser unlimited attempts and delete the mechanism'
  );
});

test('a customer cannot clear a lock on their own order', async () => {
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();
  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));

  const customer = await authenticatedUser('customer');
  const res = await api()
    .post(`/api/orders/${order._id}/handover/reset`)
    .set(auth(customer.accessToken));

  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

test('a shop order keys its code on the shop, so two shops never share one', async () => {
  const shopA = await authenticatedUser('shopkeeper');
  const shopB = await authenticatedUser('shopkeeper');
  const { order } = await seedShopOrder({ shop: shopA });

  assert.equal(
    pickupCode.sellerKeyFor({ shop: shopA.user._id }),
    shopA.user._id.toHexString()
  );
  assert.notEqual(
    pickupCode.codeFor(order._id, pickupCode.sellerKeyFor({ shop: shopA.user._id })),
    pickupCode.codeFor(order._id, pickupCode.sellerKeyFor({ shop: shopB.user._id }))
  );
  assert.equal(pickupCode.sellerKeyFor({ shop: null }), 'legacy');
});

test('the code is dropped from the shop screen once the pickup is done', async () => {
  const shopkeeper = await authenticatedUser('shopkeeper');
  const rider = await authenticatedUser('delivery');
  const { order } = await seedShopOrder();

  await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));
  await api()
    .post(`/api/orders/${order._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ code: pickupCode.codeFor(order._id, 'legacy') });

  const res = await api().get('/api/orders?limit=100').set(auth(shopkeeper.accessToken));
  const seen = res.body.data.find((o) => o.id === order._id.toHexString());

  assert.equal(
    seen?.pickupCode,
    undefined,
    'a spent code on screen is a number waiting to be overheard'
  );
});
