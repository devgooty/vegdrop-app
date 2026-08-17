'use strict';

/**
 * Which FIELDS each role sees on an order, as distinct from which orders.
 *
 * `visibilityFilter` had the second half right and the first half missing: a
 * shopkeeper who passed the filter then received the whole document, including
 * the customer's name, phone, delivery address and delivery coordinates.
 *
 * The market stall side never had the problem, because routes/stalls.js builds
 * a narrow projection by hand and deliberately omits the customer. An
 * independent shop reached its orders through /api/orders instead, which
 * returned `order.toJSON()`, so the same rule was never applied to it.
 *
 * A rider still sees everything — that is the job — and a customer obviously
 * sees their own order.
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
  verifyVendor,
} = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

const HYD = { lat: 17.385, lng: 78.4867 };
const ADDRESS = '221B Baker Street, Koramangala';

async function seedShop() {
  const shop = await authenticatedUser('shopkeeper');
  await verifyVendor(shop.user);
  await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ ...HYD, name: 'Ravi Vegetables', address: '12 Main Road' });
  return shop;
}

/** An order placed with an independent shop, with identifiable details on it. */
async function placeShopOrder() {
  const shop = await seedShop();
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 9900,
    stock: 500,
    owner: shop.user._id,
  });

  const customer = await authenticatedUser('customer');
  // Give the customer a distinctive name we can search the payload for.
  await User.updateOne({ _id: customer.user._id }, { $set: { name: 'Wilhelmina Featherstone' } });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 2 }],
      address: ADDRESS,
      paymentMethod: 'cod',
      shopId: shop.user._id.toHexString(),
      ...HYD,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const stored = await User.findById(customer.user._id).lean();
  return { shop, customer, orderId: created.body.data.id, stored };
}

// ---------------------------------------------------------------------------
// The shopkeeper
// ---------------------------------------------------------------------------

test('a shopkeeper order list carries no customer identity', async () => {
  const { shop, stored } = await placeShopOrder();

  const res = await api().get('/api/orders').set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1, 'they must still see the order itself');

  const order = res.body.data[0];
  assert.equal(order.customerName, undefined);
  assert.equal(order.phone, undefined);
  assert.equal(order.address, undefined);
  assert.equal(order.deliveryLocation, undefined, 'a home as coordinates is still a home');

  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('Wilhelmina Featherstone'), 'the name must not survive anywhere');
  assert.ok(!body.includes(ADDRESS));
  if (stored.phone) assert.ok(!body.includes(stored.phone));
});

test('a shopkeeper still gets everything needed to pack and be paid', async () => {
  const { shop } = await placeShopOrder();

  const res = await api().get('/api/orders').set(auth(shop.accessToken));
  const order = res.body.data[0];

  assert.ok(order.orderNumber, 'the order number is how it is referred to');
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].name, 'Tomato');
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.totalAmountPaise, 19800 + order.deliveryFeePaise);
  assert.equal(order.status, 'Pending');
  assert.equal(order.paymentMethod, 'cod');
});

test('fetching one order by id redacts it the same way', async () => {
  const { shop, orderId } = await placeShopOrder();

  const res = await api().get(`/api/orders/${orderId}`).set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.customerName, undefined);
  assert.equal(res.body.data.address, undefined);
});

test('driving the status does not hand the details back', async () => {
  const { shop, orderId } = await placeShopOrder();

  // The response to a write is a second way to read the same document, and it
  // went through toJSON() untouched.
  const res = await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.customerName, undefined);
  assert.equal(res.body.data.phone, undefined);
  assert.equal(res.body.data.address, undefined);
  assert.equal(res.body.data.status, 'Preparing', 'the transition still happened');
});

test('cancelling does not hand the details back either', async () => {
  const { shop, orderId } = await placeShopOrder();

  const res = await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Cancelled' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.customerName, undefined);
  assert.equal(res.body.data.address, undefined);
});

// ---------------------------------------------------------------------------
// Everyone else is unaffected
// ---------------------------------------------------------------------------

test('the rider gets the address, because that is the job', async () => {
  const { shop, orderId, stored } = await placeShopOrder();
  const rider = await authenticatedUser('delivery');

  for (const status of ['Preparing', 'Out for Delivery']) {
    await api()
      .patch(`/api/orders/${orderId}/status`)
      .set(auth(shop.accessToken))
      .send({ status });
  }
  await api().post(`/api/orders/${orderId}/claim`).set(auth(rider.accessToken));

  const res = await api().get('/api/orders').set(auth(rider.accessToken));
  const order = res.body.data.find((o) => o.id === orderId);

  assert.ok(order, 'the rider must see their own assignment');
  assert.equal(order.address, ADDRESS, 'a courier cannot deliver to a redacted address');
  assert.equal(order.customerName, 'Wilhelmina Featherstone');
  assert.equal(order.phone, stored.phone ?? order.phone);
});

// ---------------------------------------------------------------------------
// Rider location: the one rider fact the shop IS allowed to see
// ---------------------------------------------------------------------------

test('a shopkeeper sees the assigned rider\'s live location', async () => {
  const { shop, orderId } = await placeShopOrder();
  const rider = await authenticatedUser('delivery');

  await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });
  await api().post(`/api/orders/${orderId}/claim`).set(auth(rider.accessToken));
  await api()
    .post('/api/rider/location')
    .set(auth(rider.accessToken))
    .send({ lat: HYD.lat, lng: HYD.lng });

  const res = await api().get(`/api/orders/${orderId}/rider-location`).set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.lat, HYD.lat);
  assert.equal(res.body.data.lng, HYD.lng);
  assert.ok(res.body.data.updatedAt);
});

test('rider location is null before a rider claims the order', async () => {
  const { shop, orderId } = await placeShopOrder();

  const res = await api().get(`/api/orders/${orderId}/rider-location`).set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);
});

test('rider location is null once the fix goes stale', async () => {
  const { shop, orderId } = await placeShopOrder();
  const rider = await authenticatedUser('delivery');

  await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });
  await api().post(`/api/orders/${orderId}/claim`).set(auth(rider.accessToken));
  await User.updateOne(
    { _id: rider.user._id },
    {
      $set: {
        'rider.lastLocation': { type: 'Point', coordinates: [HYD.lng, HYD.lat] },
        'rider.lastLocationAt': new Date(Date.now() - 10 * 60 * 1000),
      },
    }
  );

  const res = await api().get(`/api/orders/${orderId}/rider-location`).set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null, 'a ten-minute-old fix must read as gone, not live');
});

test('rider location is 404 for a shopkeeper who does not own the order', async () => {
  const { orderId } = await placeShopOrder();
  const otherShop = await authenticatedUser('shopkeeper');

  const res = await api().get(`/api/orders/${orderId}/rider-location`).set(auth(otherShop.accessToken));
  assert.equal(res.status, 404);
});

test('a customer cannot read rider location off their own order', async () => {
  const { customer, orderId } = await placeShopOrder();

  const res = await api().get(`/api/orders/${orderId}/rider-location`).set(auth(customer.accessToken));
  assert.equal(res.status, 403);
});

test('the customer still sees their own order in full', async () => {
  const { customer, orderId } = await placeShopOrder();

  const res = await api().get(`/api/orders/${orderId}`).set(auth(customer.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.address, ADDRESS);
  assert.equal(res.body.data.customerName, 'Wilhelmina Featherstone');
});

test('a market stall sees no customer through /api/orders either', async () => {
  // The stall feed was already safe; this covers the other door into the same
  // document, which is the one that was leaking.
  const { shop, orderId } = await placeShopOrder();
  await Order.updateOne({ _id: orderId }, { $set: { shop: null, market: null } });

  const res = await api().get('/api/orders').set(auth(shop.accessToken));
  const order = res.body.data.find((o) => o.id === orderId);

  assert.ok(order, 'a legacy pooled order is still visible to every shopkeeper');
  assert.equal(order.customerName, undefined, 'and still carries no customer');
  assert.equal(order.address, undefined);
});
