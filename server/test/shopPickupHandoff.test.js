'use strict';

/**
 * Independent-shop pickup: the rider accepts, walks to the counter, and types
 * the code the SHOP is showing.
 *
 * This file used to be the executable statement of the opposite direction -
 * the rider was shown the code and the shopkeeper typed it in. Every assertion
 * about who reads and who submits was re-pointed deliberately rather than
 * deleted, so the old guarantees each have a named successor:
 *
 *   "the shopkeeper never receives the code"   -> the shop is the ONLY reader
 *   "the assigned rider receives their code"   -> the rider receives it from nowhere
 *   "accept returns the code"                  -> accept returns no code at all
 *   "a wrong guess does not burn the real code" -> it is counted, and five lock it
 *
 * The delivery code at the customer's door, and market stalls, are in
 * handoverCodes.test.js.
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
  createUser,
  shopPickupCode,
} = require('./helpers');

const Order = require('../models/Order');
const OrderHandover = require('../models/OrderHandover');
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

async function placeShopOrder(shop, { status = 'Preparing' } = {}) {
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
    status,
    shop: shop.user._id,
    shopName: 'Test Shop',
  });

  return { order, buyer };
}

/** Dispatch already assigned a nearest rider; this drives the accept step too. */
async function preparedAndAccepted({ shop, rider }) {
  const { order, buyer } = await placeShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);
  const accept = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });
  assert.equal(accept.accepted, true);
  return { order: accept.order, buyer };
}

/**
 * True when `code` appears anywhere in `value` as a whole string value.
 *
 * Deliberately a deep equality search rather than `JSON.stringify().includes`:
 * six digits turn up inside phone numbers, timestamps and ObjectIds, and a leak
 * check that fails at random would teach everyone to ignore it.
 */
function carriesCode(value, code) {
  if (value === code) return true;
  if (Array.isArray(value)) return value.some((v) => carriesCode(v, code));
  if (value && typeof value === 'object') return Object.values(value).some((v) => carriesCode(v, code));
  return false;
}

const wrongCodeFor = (code) => (code === '000000' ? '111111' : '000000');

// ---------------------------------------------------------------------------
// Accepting is about the rider, not the code
// ---------------------------------------------------------------------------

test('accepting stamps riderAcceptedAt and creates no code', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeShopOrder(shop);

  const offered = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(offered.assigned, true);

  const before = await Order.findById(order._id).lean();
  assert.equal(before.riderAcceptedAt, null, 'not accepted yet, just picked as nearest');

  const result = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });
  assert.equal(result.accepted, true);
  assert.ok(result.order.riderAcceptedAt);
  assert.equal(result.order.toJSON().pickupCode, undefined, 'the order carries no code of any kind');
  assert.equal(await OrderHandover.countDocuments(), 0, 'a rider tapping accept mints nothing');
});

test('a rider who is not the assignee cannot accept', async () => {
  const shop = await seedShop();
  await seedOnlineRider();
  const stranger = await authenticatedUser('delivery');
  const { order } = await placeShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const result = await dispatch.acceptShopAssignment({ orderId: order._id, riderId: stranger.user._id });
  assert.equal(result.accepted, false);
});

test('accepting twice the second time finds nothing left to accept', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeShopOrder(shop);
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
  const { order } = await placeShopOrder(shop);

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
// The code belongs to the shop
// ---------------------------------------------------------------------------

test('the shop is shown a six-digit pickup code once it has accepted the order', async () => {
  const shop = await seedShop();
  const { order } = await placeShopOrder(shop);

  const res = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(shop.accessToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.code, /^\d{6}$/);
  assert.equal(res.body.data.locked, false);
  assert.equal(res.body.data.verified, false);
  assert.equal(res.body.data.attemptsRemaining, 5);

  const again = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(shop.accessToken));
  assert.equal(again.body.data.code, res.body.data.code, 'a reload shows the same code, not a new one');
  assert.equal(await OrderHandover.countDocuments({ order: order._id }), 1);
});

test('there is no pickup code before the shop accepts the order', async () => {
  const shop = await seedShop();
  const { order } = await placeShopOrder(shop, { status: 'Pending' });

  const res = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(shop.accessToken));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CODE_NOT_AVAILABLE');
});

test('two first reads at once still produce exactly one code', async () => {
  const shop = await seedShop();
  const { order } = await placeShopOrder(shop);

  const reads = await Promise.all(
    Array.from({ length: 5 }, () => api().get(`/api/orders/${order._id}/pickup-code`).set(auth(shop.accessToken)))
  );
  const codes = new Set(reads.map((r) => r.body.data?.code));
  assert.ok(reads.every((r) => r.status === 200), reads.map((r) => r.status).join(','));
  assert.equal(codes.size, 1, 'every device the shop opens shows the same number');
  assert.equal(await OrderHandover.countDocuments({ order: order._id }), 1);
});

test("another shop cannot read this shop's pickup code", async () => {
  const shop = await seedShop();
  const otherShop = await seedShop();
  const { order } = await placeShopOrder(shop);
  await shopPickupCode(order._id, shop.accessToken);

  const res = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(otherShop.accessToken));
  assert.equal(res.status, 404, 'no confirmation that the order even exists');
});

test('the rider cannot read the pickup code - from any route', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);
  const code = await shopPickupCode(order._id, shop.accessToken);

  // The holder route itself.
  const direct = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(rider.accessToken));
  assert.equal(direct.status, 403);

  // Every order payload a rider is ever handed on the way to the counter.
  const accepted = await api().post(`/api/rider/orders/${order._id}/accept`).set(auth(rider.accessToken));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(carriesCode(accepted.body, code), false, 'accept returns the raw order to the rider');

  const list = await api().get('/api/orders').set(auth(rider.accessToken));
  assert.equal(carriesCode(list.body, code), false);

  const one = await api().get(`/api/orders/${order._id}`).set(auth(rider.accessToken));
  assert.equal(carriesCode(one.body, code), false);

  const jobs = await api().get('/api/rider/orders').set(auth(rider.accessToken));
  assert.equal(carriesCode(jobs.body, code), false);
});

test('the customer cannot read the pickup code', async () => {
  const shop = await seedShop();
  const { order, buyer } = await placeShopOrder(shop);
  const code = await shopPickupCode(order._id, shop.accessToken);

  const session = await require('./helpers').signIn({ phone: buyer.phone });
  const direct = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(session.accessToken));
  assert.equal(direct.status, 403);

  const list = await api().get('/api/orders').set(auth(session.accessToken));
  assert.equal(carriesCode(list.body, code), false);
});

// ---------------------------------------------------------------------------
// The rider types it
// ---------------------------------------------------------------------------

test('the right code moves the order to Out for Delivery and retires the code', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });
  const code = await shopPickupCode(order._id, shop.accessToken);

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'Out for Delivery');

  const stored = await Order.findById(order._id).lean();
  assert.equal(stored.status, 'Out for Delivery');
  const history = stored.statusHistory.at(-1);
  assert.equal(history.status, 'Out for Delivery');
  assert.equal(String(history.by), String(rider.user._id), 'the rider performed the handover, so the rider is recorded');

  const handover = await OrderHandover.findOne({ order: order._id, stage: 'pickup' }).select('+code').lean();
  assert.ok(handover.verifiedAt);
  assert.equal(String(handover.verifiedBy), String(rider.user._id));
  assert.equal(handover.code, null, 'used once, then gone');

  const after = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(shop.accessToken));
  assert.equal(after.status, 409, 'nothing left to show once collected');
});

test('a wrong code is refused, counted, and the order stays Preparing', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });
  const code = await shopPickupCode(order._id, shop.accessToken);

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code: wrongCodeFor(code) });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'WRONG_CODE');
  assert.equal(res.body.error.details.attemptsRemaining, 4);
  assert.match(res.body.error.message, /shop/);

  assert.equal((await Order.findById(order._id).lean()).status, 'Preparing');
  const shown = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(shop.accessToken));
  assert.equal(shown.body.data.code, code, 'a wrong guess does not change the code');
  assert.equal(shown.body.data.attemptsRemaining, 4, 'but the shop can see it was guessed at');
});

test('five wrong codes lock it; even the right code is then refused until the shop issues a new one', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });
  const code = await shopPickupCode(order._id, shop.accessToken);

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await api()
      .post(`/api/orders/${order._id}/verify-pickup`)
      .set(auth(rider.accessToken))
      .send({ code: wrongCodeFor(code) });
  }
  assert.equal(last.body.error.code, 'CODE_LOCKED', 'the fifth wrong guess locks it');

  const rightButLocked = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code });
  assert.equal(rightButLocked.status, 409);
  assert.equal(rightButLocked.body.error.code, 'CODE_LOCKED', 'a locked code is dead, digits and all');
  assert.equal((await Order.findById(order._id).lean()).status, 'Preparing');

  const shown = await api().get(`/api/orders/${order._id}/pickup-code`).set(auth(shop.accessToken));
  assert.equal(shown.body.data.locked, true);
  assert.equal(shown.body.data.code, null, 'nothing to read out while it is locked');

  const fresh = await api().post(`/api/orders/${order._id}/pickup-code/reissue`).set(auth(shop.accessToken));
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.data.locked, false);
  assert.equal(fresh.body.data.attemptsRemaining, 5);
  assert.match(fresh.body.data.code, /^\d{6}$/);

  const verified = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code: fresh.body.data.code });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
});

test('a rider cannot confirm pickup before the shop has ever opened its code', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code: '123456' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CODE_NOT_ISSUED');
  assert.match(res.body.error.message, /shop/);
});

test('the shopkeeper can no longer confirm pickup themselves', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });
  const code = await shopPickupCode(order._id, shop.accessToken);

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(shop.accessToken))
    .send({ code });

  assert.equal(res.status, 403, 'the holder of a code cannot also be the one who redeems it');
  assert.equal((await Order.findById(order._id).lean()).status, 'Preparing');
});

test('a rider the order is not assigned to cannot use the code', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const stranger = await authenticatedUser('delivery');
  const { order } = await preparedAndAccepted({ shop, rider });
  const code = await shopPickupCode(order._id, shop.accessToken);

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(stranger.accessToken))
    .send({ code });

  assert.equal(res.status, 404);
  const handover = await OrderHandover.findOne({ order: order._id }).lean();
  assert.equal(handover.attempts, 0, 'a stranger never even reaches the code, so spends none of its attempts');
});

test('a malformed code is rejected by validation before it ever reaches the check', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });
  await shopPickupCode(order._id, shop.accessToken);

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code: 'abcdef' });

  assert.equal(res.status, 400);
  assert.equal((await OrderHandover.findOne({ order: order._id }).lean()).attempts, 0);
});

test('PATCHing a shop order to Out for Delivery is refused, rider or no rider', async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await preparedAndAccepted({ shop, rider });
  const { order: unassigned } = await placeShopOrder(shop);

  for (const id of [order._id, unassigned._id]) {
    const res = await api()
      .patch(`/api/orders/${id}/status`)
      .set(auth(shop.accessToken))
      .send({ status: 'Out for Delivery' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PICKUP_CODE_REQUIRED');
  }
});

test('a rider who took the order from the open pool confirms pickup the same way', async () => {
  const shop = await seedShop();
  const rider = await authenticatedUser('delivery');
  const { order } = await placeShopOrder(shop);

  const claimed = await api().post(`/api/orders/${order._id}/claim`).set(auth(rider.accessToken));
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

  const code = await shopPickupCode(order._id, shop.accessToken);
  assert.equal(carriesCode(claimed.body, code), false);

  const res = await api()
    .post(`/api/orders/${order._id}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const stored = await Order.findById(order._id).lean();
  assert.equal(stored.status, 'Out for Delivery');
  assert.ok(stored.riderAcceptedAt, 'reaching the counter with the code is accepting');
});

// ---------------------------------------------------------------------------
// Who gets to see the rider
// ---------------------------------------------------------------------------

test("the shopkeeper sees the rider's name and phone once accepted, not before", async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { order } = await placeShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const beforeAccept = await api().get('/api/orders').set(auth(shop.accessToken));
  assert.equal(beforeAccept.body.data[0].riderName, undefined, 'picked as nearest is not yet a person who agreed');

  await dispatch.acceptShopAssignment({ orderId: order._id, riderId: rider.user._id });

  const afterAccept = await api().get('/api/orders').set(auth(shop.accessToken));
  assert.equal(afterAccept.body.data[0].riderName, rider.user.name);
  assert.equal(afterAccept.body.data[0].riderPhone, rider.user.phone);
});

test("the customer also sees the rider's name and phone once accepted", async () => {
  const shop = await seedShop();
  const rider = await seedOnlineRider();
  const { buyer } = await preparedAndAccepted({ shop, rider });

  const session = await require('./helpers').signIn({ phone: buyer.phone });
  const res = await api().get('/api/orders').set(auth(session.accessToken));
  assert.equal(res.body.data[0].riderName, rider.user.name);
  assert.equal(res.body.data[0].riderPhone, rider.user.phone);
});

// ---------------------------------------------------------------------------
// The rider-facing HTTP routes
// ---------------------------------------------------------------------------

test('POST /rider/orders/:id/decline works for a shop order', async () => {
  const shop = await seedShop();
  const near = await seedOnlineRider({ metresEast: 100 });
  const next = await seedOnlineRider({ metresEast: 900 });
  const { order } = await placeShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const res = await api().post(`/api/rider/orders/${order._id}/decline`).set(auth(near.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.declined, true);

  const after = await Order.findById(order._id).lean();
  assert.equal(String(after.assignedTo), String(next.user._id));
});

test('a stranger cannot accept a shop pickup that was not offered to them', async () => {
  const shop = await seedShop();
  await seedOnlineRider();
  const stranger = await authenticatedUser('delivery');
  const { order } = await placeShopOrder(shop);
  await dispatch.offerShopOrderToNearestRider(order._id);

  const res = await api().post(`/api/rider/orders/${order._id}/accept`).set(auth(stranger.accessToken));
  assert.equal(res.status, 409);
});
