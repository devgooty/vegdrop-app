'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, api, auth, authenticatedUser, createUser } = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const dispatch = require('../services/dispatch');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

const HYD = { lat: 17.385, lng: 78.4867 };

/** An independent shopkeeper with a pinned location, via the real endpoint. */
async function seedShop() {
  const shop = await authenticatedUser('shopkeeper');
  const res = await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ lat: HYD.lat, lng: HYD.lng, name: 'Test Shop', address: '1 Test Lane' });
  assert.equal(res.status, 200);
  return shop;
}

/** A rider close enough to the shop to be picked, on duty and freshly pinged. */
async function seedOnlineRider({ metresEast = 100 } = {}) {
  const rider = await authenticatedUser('delivery');
  const offsetDeg = metresEast / (111320 * Math.cos((HYD.lat * Math.PI) / 180));
  await User.updateOne(
    { _id: rider.user._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: [HYD.lng + offsetDeg, HYD.lat] },
        'rider.lastLocationAt': new Date(),
      },
    }
  );
  return rider;
}

async function placeAndPrepareShopOrder(shop) {
  const { user: buyer } = await createUser({ role: 'customer' });
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 500,
  });

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: buyer._id,
    customerName: buyer.name,
    phone: buyer.phone,
    address: '12 Test Lane',
    items: [{ product: product._id, name: product.name, unitPricePaise: 4000, quantity: 1, lineTotalPaise: 4000 }],
    subtotalPaise: 4000,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Preparing',
    shop: shop.user._id,
    shopName: 'Test Shop',
  });

  return { order, buyer };
}

/** Dispatch already assigned a nearest rider; this drives the accept step too. */
async function preparedAndAccepted({ shop, rider }) {
  const { order, buyer } = await placeAndPrepareShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);
  const accept = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });
  assert.equal(accept.accepted, true);
  return { order: accept.order, buyer };
}

// ---------------------------------------------------------------------------
// Accepting turns a candidate into a code
// ---------------------------------------------------------------------------

test('accepting generates a 6-digit pickup code and stamps riderAcceptedAt', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeAndPrepareShopOrder(shop);

  const offered = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(offered.assigned, true);

  const before = await Order.findById(order._id).lean();
  assert.equal(before.riderAcceptedAt, null, 'not accepted yet, just picked as nearest');
  assert.equal(before.pickupCode, null);

  const result = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });
  assert.equal(result.accepted, true);
  assert.ok(result.order.riderAcceptedAt);
  assert.match(result.order.pickupCode, /^\d{6}$/);
});

test('a rider who is not the assignee cannot accept', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const stranger = await authenticatedUser('delivery');
  const { order } = await placeAndPrepareShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const result = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: stranger.user._id });
  assert.equal(result.accepted, false);
  void rider;
});

test('accepting twice the second time finds nothing left to accept', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeAndPrepareShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const first = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });
  assert.equal(first.accepted, true);
  const second = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });
  assert.equal(second.accepted, false, 'riderAcceptedAt is already set');
});

// ---------------------------------------------------------------------------
// Declining before accepting cascades to the next nearest
// ---------------------------------------------------------------------------

test('declining before accepting releases the order to the next nearest rider', async () => {
  const shop = await seedShop();
  const near = await seedOnlineRider({ metresEast: 100 });
  const next = await seedOnlineRider({ metresEast: 900 });
  const { order } = await placeAndPrepareShopOrder(shop);

  const first = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(String(first.rider._id), String(near.user._id));

  const declined = await dispatch.declineShopAssignment({ orderId: order._id, riderId: near.user._id });
  assert.equal(declined.declined, true);
  assert.equal(declined.next.assigned, true);
  assert.equal(String(declined.next.rider._id), String(next.user._id));

  const after = await Order.findById(order._id).lean();
  assert.equal(String(after.assignedTo), String(next.user._id));
  assert.ok(after.fulfillment.riderOffer.declinedBy.some((id) => String(id) === String(near.user._id)));
});

test('a rider cannot decline after already accepting', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const result = await dispatch.declineShopAssignment({ orderId: order._id, riderId: rider.user._id });
  assert.equal(result.declined, false, 'committed once accepted; backing out is a phone call, not a button');
});

test('the timeout sweep never touches an assignment the rider already accepted', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer.expiresAt': new Date(Date.now() - 1000) } }
  );

  const result = await dispatch.expireShopOrderAssignment(order._id);
  assert.equal(result.action, 'skipped');

  const after = await Order.findById(order._id).lean();
  assert.equal(String(after.assignedTo), String(rider.user._id), 'still assigned; accepting ends the timeout clock');
});

// ---------------------------------------------------------------------------
// The pickup code itself
// ---------------------------------------------------------------------------

test('the correct code moves the order to Out for Delivery and clears itself', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(shop.accessToken))
    .send({ code: order.pickupCode });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'Out for Delivery');

  const stored = await Order.findById(order._id).lean();
  assert.equal(stored.pickupCode, null, 'used once, then gone');
  assert.equal(stored.status, 'Out for Delivery');
});

test('a wrong code is refused and the order stays Preparing', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const wrong = order.pickupCode === '000000' ? '111111' : '000000';
  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(shop.accessToken))
    .send({ code: wrong });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'WRONG_CODE');

  const stored = await Order.findById(order._id).lean();
  assert.equal(stored.status, 'Preparing');
  assert.ok(stored.pickupCode, 'a wrong guess does not burn the real code');
});

test('verifying before any rider has accepted is refused', async () => {
  const shop = await seedShop();
  const { order } = await placeAndPrepareShopOrder(shop);

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(shop.accessToken))
    .send({ code: '123456' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'NOT_ACCEPTED_YET');
});

test('a shopkeeper cannot verify pickup on another shop\'s order', async () => {
  const shop = await seedShop();
  const otherShop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(otherShop.accessToken))
    .send({ code: order.pickupCode });

  assert.equal(res.status, 404, 'no confirmation that the order even exists');
});

test('a malformed code is rejected by validation before it ever reaches the check', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(shop.accessToken))
    .send({ code: 'abcdef' });

  assert.equal(res.status, 400);
});

test('manually PATCHing to Out for Delivery is refused once a rider has accepted', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const res = await api()
    .patch(`/api/orders/${order._id}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Out for Delivery' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PICKUP_CODE_REQUIRED');
});

// ---------------------------------------------------------------------------
// Who gets to see what
// ---------------------------------------------------------------------------

test('the shopkeeper never receives the pickup code itself', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  await preparedAndAccepted({ shop, rider });

  const res = await api().get('/api/orders').set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  const order = res.body.data[0];
  assert.equal(order.pickupCode, undefined, 'the code is told, not read off a screen');
});

test('the customer never receives the pickup code either', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order, buyer } = await preparedAndAccepted({ shop, rider });
  void order;

  const session = await require('./helpers').signIn({ phone: buyer.phone });
  const res = await api().get('/api/orders').set(auth(session.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].pickupCode, undefined);
});

test('the assigned rider does receive their own pickup code', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const res = await api().get('/api/orders').set(auth(rider.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].pickupCode, order.pickupCode);
});

test('the shopkeeper sees the rider\'s name and phone once accepted, not before', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeAndPrepareShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const beforeAccept = await api().get('/api/orders').set(auth(shop.accessToken));
  assert.equal(beforeAccept.body.data[0].riderName, undefined, 'picked as nearest is not yet a person who agreed');

  await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });

  const afterAccept = await api().get('/api/orders').set(auth(shop.accessToken));
  assert.equal(afterAccept.body.data[0].riderName, rider.user.name);
  assert.equal(afterAccept.body.data[0].riderPhone, rider.user.phone);
});

test('the customer also sees the rider\'s name and phone once accepted', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order, buyer } = await preparedAndAccepted({ shop, rider });
  void order;

  const session = await require('./helpers').signIn({ phone: buyer.phone });
  const res = await api().get('/api/orders').set(auth(session.accessToken));
  assert.equal(res.body.data[0].riderName, rider.user.name);
  assert.equal(res.body.data[0].riderPhone, rider.user.phone);
});

// ---------------------------------------------------------------------------
// The rider-facing HTTP routes
// ---------------------------------------------------------------------------

test('POST /rider/orders/:id/accept works for a shop order and returns the code', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeAndPrepareShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const res = await api().post(`/api/rider/orders/${order._id}/accept`).set(auth(rider.accessToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.pickupCode, /^\d{6}$/);
});

test('POST /rider/orders/:id/decline works for a shop order', async () => {
  const shop = await seedShop();
  const near = await seedOnlineRider({ metresEast: 100 });
  const next = await seedOnlineRider({ metresEast: 900 });
  const { order } = await placeAndPrepareShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const res = await api().post(`/api/rider/orders/${order._id}/decline`).set(auth(near.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.declined, true);

  const after = await Order.findById(order._id).lean();
  assert.equal(String(after.assignedTo), String(next.user._id));
});

test('a stranger cannot accept a shop pickup that was not offered to them', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const stranger = await authenticatedUser('delivery');
  const { order } = await placeAndPrepareShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const res = await api().post(`/api/rider/orders/${order._id}/accept`).set(auth(stranger.accessToken));
  assert.equal(res.status, 409);
  void rider;
});
