'use strict';

/**
 * Handover codes beyond the shop counter: the customer's code at the door, one
 * code per market stall, the developer override, and the leak checks that make
 * any of it mean something.
 *
 * The rule every test here is ultimately about: the rider types both codes, so
 * the rider must be able to read neither. A code the rider could see would turn
 * "the customer confirmed delivery" into "the rider pressed a button".
 *
 * Independent-shop pickup is covered in shopPickupHandoff.test.js.
 */

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
  shopPickupCode,
  stallPickupCode,
  deliveryCode,
} = require('./helpers');

const Order = require('../models/Order');
const OrderHandover = require('../models/OrderHandover');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const sourcing = require('../services/sourcing');
const handover = require('../services/handover');
const { migrateDroppedPickupCode } = require('../db/migrations');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/** Deep equality search; see shopPickupHandoff.test.js for why not `includes`. */
function carriesCode(value, code) {
  if (value === code) return true;
  if (Array.isArray(value)) return value.some((v) => carriesCode(v, code));
  if (value && typeof value === 'object') return Object.values(value).some((v) => carriesCode(v, code));
  return false;
}

const wrongCodeFor = (code) => (code === '000000' ? '111111' : '000000');

async function seedProduct(name = 'Tomato', pricePaise = 4000) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise, stock: 500 });
}

// ---------------------------------------------------------------------------
// Marketless orders: the customer's code at the door
// ---------------------------------------------------------------------------

/** A legacy (no shop, no market) COD order, driven to Out for Delivery by staff. */
async function legacyOrder({ claimedBy = null, outForDelivery = true } = {}) {
  const customer = await authenticatedUser('customer');
  const staff = await authenticatedUser('shopkeeper');
  const product = await seedProduct();

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity: 1 }],
      address: '12 Test Street',
      paymentMethod: 'cod',
    })
    .expect(201);
  const id = created.body.data.id;

  const steps = outForDelivery ? ['Preparing', 'Out for Delivery'] : ['Preparing'];
  for (const status of steps) {
    await api().patch(`/api/orders/${id}/status`).set(auth(staff.accessToken)).send({ status }).expect(200);
  }
  if (claimedBy) {
    await api().post(`/api/orders/${id}/claim`).set(auth(claimedBy.accessToken)).expect(200);
  }

  return { id, customer, staff };
}

test('the customer is shown a delivery code only once the order is on its way', async () => {
  const early = await legacyOrder({ outForDelivery: false });
  const notYet = await api().get(`/api/orders/${early.id}/delivery-code`).set(auth(early.customer.accessToken));
  assert.equal(notYet.status, 409, 'a code shared before collection could close an order nobody collected');
  assert.equal(notYet.body.error.code, 'CODE_NOT_AVAILABLE');

  const { id, customer } = await legacyOrder();
  const res = await api().get(`/api/orders/${id}/delivery-code`).set(auth(customer.accessToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.code, /^\d{6}$/);
  assert.equal(res.body.data.stage, 'delivery');
});

test('the rider completes delivery with the customer’s code, COD is collected, and the code is retired', async () => {
  const rider = await authenticatedUser('delivery');
  const { id, customer } = await legacyOrder({ claimedBy: rider });
  const code = await deliveryCode(id, customer.accessToken);

  const res = await api().post(`/api/orders/${id}/verify-delivery`).set(auth(rider.accessToken)).send({ code });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'Delivered');
  assert.equal(res.body.data.paymentStatus, 'paid');

  const stored = await Order.findById(id).lean();
  assert.equal(String(stored.statusHistory.at(-1).by), String(rider.user._id));
  const row = await OrderHandover.findOne({ order: id, stage: 'delivery' }).select('+code').lean();
  assert.ok(row.verifiedAt);
  assert.equal(row.code, null);
});

test('a wrong delivery code is refused, and neither the order nor the payment moves', async () => {
  const rider = await authenticatedUser('delivery');
  const { id, customer } = await legacyOrder({ claimedBy: rider });
  const code = await deliveryCode(id, customer.accessToken);

  const res = await api()
    .post(`/api/orders/${id}/verify-delivery`)
    .set(auth(rider.accessToken))
    .send({ code: wrongCodeFor(code) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'WRONG_CODE');
  assert.match(res.body.error.message, /customer/);

  const stored = await Order.findById(id).lean();
  assert.equal(stored.status, 'Out for Delivery');
  assert.equal(stored.paymentStatus, 'pending', 'COD is not marked collected on a delivery nobody confirmed');
});

test('the rider cannot read the delivery code - from any route', async () => {
  const rider = await authenticatedUser('delivery');
  const { id, customer } = await legacyOrder({ claimedBy: rider });
  const code = await deliveryCode(id, customer.accessToken);

  const direct = await api().get(`/api/orders/${id}/delivery-code`).set(auth(rider.accessToken));
  assert.equal(direct.status, 403);

  for (const path of ['/api/orders', `/api/orders/${id}`, '/api/rider/orders']) {
    const res = await api().get(path).set(auth(rider.accessToken));
    assert.equal(carriesCode(res.body, code), false, `${path} carried the customer's code to the rider`);
  }
});

test('nobody but the order’s own customer can read its delivery code', async () => {
  const { id, customer, staff } = await legacyOrder();
  await deliveryCode(id, customer.accessToken);
  const otherCustomer = await authenticatedUser('customer');

  const byOther = await api().get(`/api/orders/${id}/delivery-code`).set(auth(otherCustomer.accessToken));
  assert.equal(byOther.status, 404);

  const byShop = await api().get(`/api/orders/${id}/delivery-code`).set(auth(staff.accessToken));
  assert.equal(byShop.status, 403);

  const developer = await authenticatedUser('developer');
  const byDeveloper = await api().get(`/api/orders/${id}/delivery-code`).set(auth(developer.accessToken));
  assert.equal(byDeveloper.status, 403, 'a route that shows an operator one live code can show them all');
});

test('a rider can no longer PATCH an order to Delivered; a developer can, and is recorded doing it', async () => {
  const rider = await authenticatedUser('delivery');
  const { id } = await legacyOrder({ claimedBy: rider });

  const byRider = await api().patch(`/api/orders/${id}/status`).set(auth(rider.accessToken)).send({ status: 'Delivered' });
  assert.equal(byRider.status, 409);
  assert.equal(byRider.body.error.code, 'DELIVERY_CODE_REQUIRED');
  assert.equal((await Order.findById(id).lean()).status, 'Out for Delivery');

  const developer = await authenticatedUser('developer');
  const override = await api()
    .patch(`/api/orders/${id}/status`)
    .set(auth(developer.accessToken))
    .send({ status: 'Delivered' });
  assert.equal(override.status, 200, JSON.stringify(override.body));

  const stored = await Order.findById(id).lean();
  assert.equal(stored.status, 'Delivered');
  assert.equal(String(stored.statusHistory.at(-1).by), String(developer.user._id), 'the override is attributable');
});

test('the customer can issue a new code if theirs locks at the door', async () => {
  const rider = await authenticatedUser('delivery');
  const { id, customer } = await legacyOrder({ claimedBy: rider });
  const code = await deliveryCode(id, customer.accessToken);

  for (let i = 0; i < 5; i += 1) {
    await api().post(`/api/orders/${id}/verify-delivery`).set(auth(rider.accessToken)).send({ code: wrongCodeFor(code) });
  }
  const locked = await api().get(`/api/orders/${id}/delivery-code`).set(auth(customer.accessToken));
  assert.equal(locked.body.data.locked, true);

  const fresh = await api().post(`/api/orders/${id}/delivery-code/reissue`).set(auth(customer.accessToken));
  assert.equal(fresh.status, 200);

  const done = await api()
    .post(`/api/orders/${id}/verify-delivery`)
    .set(auth(rider.accessToken))
    .send({ code: fresh.body.data.code });
  assert.equal(done.status, 200, JSON.stringify(done.body));
});

test('an independent shop order needs two different codes, one from each party', async () => {
  const shop = await authenticatedUser('shopkeeper');
  const customer = await authenticatedUser('customer');
  const rider = await authenticatedUser('delivery');
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 50,
    owner: shop.user._id,
  });
  await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer.user._id,
    customerName: customer.user.name,
    phone: customer.user.phone,
    address: '12 Test Lane',
    items: [{ product: product._id, name: 'Tomato', unitPricePaise: 4000, quantity: 1, lineTotalPaise: 4000 }],
    subtotalPaise: 4000,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Preparing',
    shop: shop.user._id,
    shopName: 'Test Shop',
  });
  const id = (await Order.findOne({ shop: shop.user._id }).lean())._id.toHexString();

  await api().post(`/api/orders/${id}/claim`).set(auth(rider.accessToken)).expect(200);
  const pickup = await shopPickupCode(id, shop.accessToken);

  // The shop's code does not open the door: stages are separate handovers.
  await api().post(`/api/orders/${id}/verify-pickup`).set(auth(rider.accessToken)).send({ code: pickup }).expect(200);
  const reused = await api().post(`/api/orders/${id}/verify-delivery`).set(auth(rider.accessToken)).send({ code: pickup });
  assert.equal(reused.status, 409, 'a spent pickup code is not a delivery code');
  assert.equal(reused.body.error.code, 'CODE_NOT_ISSUED');

  const door = await deliveryCode(id, customer.accessToken);
  await api().post(`/api/orders/${id}/verify-delivery`).set(auth(rider.accessToken)).send({ code: door }).expect(200);
  assert.equal((await Order.findById(id).lean()).status, 'Delivered');
});

// ---------------------------------------------------------------------------
// Market orders: one code per stall, then the customer's
// ---------------------------------------------------------------------------

async function seedMarketOrder({ stallCount = 2 } = {}) {
  const customer = await authenticatedUser('customer');
  const rider = await authenticatedUser('delivery');
  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
  });

  const products = [];
  const stalls = [];
  for (let i = 0; i < stallCount; i += 1) {
    const product = await seedProduct(`Veg ${i}`);
    await MarketPrice.create({ market: market._id, product: product._id, pricePaise: 4000 });
    products.push(product);

    const session = await authenticatedUser('shopkeeper');
    const stall = await Stall.create({
      market: market._id,
      stallNumber: `A-${i + 1}`,
      name: `Stall ${i + 1}`,
      owner: session.user._id,
      status: 'approved',
    });
    stalls.push({ ...session, stall });
  }

  await api().post('/api/rider/location').set(auth(rider.accessToken)).send({ lat: 17.3851, lng: 78.4868 });
  await api().patch('/api/rider/duty').set(auth(rider.accessToken)).send({ dutyStatus: 'online' });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: products.map((p) => ({ productId: p._id.toHexString(), quantity: 1 })),
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const orderId = created.body.data.id;
  const lines = created.body.data.items;

  for (let i = 0; i < stallCount; i += 1) {
    await api()
      .post(`/api/stalls/orders/${orderId}/claim`)
      .set(auth(stalls[i].accessToken))
      .send({ lineIds: [lines[i].lineId] })
      .expect(200);
  }
  await sourcing.settlePending();
  await api().post(`/api/rider/orders/${orderId}/accept`).set(auth(rider.accessToken)).expect(200);

  return { orderId, customer, rider, stalls, market };
}

async function packAll({ orderId, stalls }) {
  for (const s of stalls) {
    await api().post(`/api/stalls/orders/${orderId}/pack`).set(auth(s.accessToken)).send({}).expect(200);
  }
}

test('every stall on a shared order has its own code, and each stall sees only its own', async () => {
  const { orderId, stalls, rider } = await seedMarketOrder({ stallCount: 2 });

  const [a, b] = await Promise.all(stalls.map((s) => stallPickupCode(orderId, s.accessToken)));
  assert.notEqual(a, b, 'two stalls on one order are never shown the same number');
  assert.equal(await OrderHandover.countDocuments({ order: orderId, stage: 'pickup' }), 2);

  // A stall with nothing on this order is told nothing about it.
  const elsewhere = await authenticatedUser('shopkeeper');
  const market2 = await Market.create({
    name: 'Other',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.49, 17.39] },
  });
  await Stall.create({
    market: market2._id,
    stallNumber: 'Z-9',
    name: 'Stranger',
    owner: elsewhere.user._id,
    status: 'approved',
  });
  const stranger = await api().get(`/api/stalls/orders/${orderId}/pickup-code`).set(auth(elsewhere.accessToken));
  assert.equal(stranger.status, 404);

  const byRider = await api().get(`/api/stalls/orders/${orderId}/pickup-code`).set(auth(rider.accessToken));
  assert.equal(byRider.status, 403);
});

test("one stall's code cannot release another stall's bags", async () => {
  const ctx = await seedMarketOrder({ stallCount: 2 });
  await packAll(ctx);
  const [first, second] = ctx.stalls;
  const secondsCode = await stallPickupCode(ctx.orderId, second.accessToken);
  await stallPickupCode(ctx.orderId, first.accessToken);

  const res = await api()
    .post(`/api/rider/orders/${ctx.orderId}/collect`)
    .set(auth(ctx.rider.accessToken))
    .send({ stallId: first.stall._id.toHexString(), code: secondsCode });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'WRONG_CODE');
  assert.match(res.body.error.message, /stall/);

  const order = await Order.findById(ctx.orderId).lean();
  assert.ok(order.items.every((item) => !item.claim.collectedAt), 'nothing was collected on a wrong code');
});

test('collecting without a code is refused before it touches anything', async () => {
  const ctx = await seedMarketOrder({ stallCount: 1 });
  await packAll(ctx);

  const res = await api()
    .post(`/api/rider/orders/${ctx.orderId}/collect`)
    .set(auth(ctx.rider.accessToken))
    .send({ stallId: ctx.stalls[0].stall._id.toHexString() });
  assert.equal(res.status, 400);
});

test("a stall's code releases all its bags in one go and is then retired", async () => {
  const ctx = await seedMarketOrder({ stallCount: 2 });
  await packAll(ctx);
  const [first, second] = ctx.stalls;
  const code = await stallPickupCode(ctx.orderId, first.accessToken);

  const collected = await api()
    .post(`/api/rider/orders/${ctx.orderId}/collect`)
    .set(auth(ctx.rider.accessToken))
    .send({ stallId: first.stall._id.toHexString(), code });
  assert.equal(collected.status, 200, JSON.stringify(collected.body));
  assert.equal(collected.body.data.dispatched, false, 'the other stall still has bags');

  const row = await OrderHandover.findOne({ order: ctx.orderId, stall: first.stall._id }).select('+code').lean();
  assert.ok(row.verifiedAt);
  assert.equal(row.code, null);

  // Nothing left at this stall, so there is no code to show it and nothing to collect.
  const shown = await api().get(`/api/stalls/orders/${ctx.orderId}/pickup-code`).set(auth(first.accessToken));
  assert.equal(shown.status, 409);
  const again = await api()
    .post(`/api/rider/orders/${ctx.orderId}/collect`)
    .set(auth(ctx.rider.accessToken))
    .send({ stallId: first.stall._id.toHexString(), code });
  assert.equal(again.status, 409);

  // The second stall's code still stands on its own.
  const last = await api()
    .post(`/api/rider/orders/${ctx.orderId}/collect`)
    .set(auth(ctx.rider.accessToken))
    .send({ stallId: second.stall._id.toHexString(), code: await stallPickupCode(ctx.orderId, second.accessToken) });
  assert.equal(last.status, 200);
  assert.equal(last.body.data.dispatched, true);
});

test('a market order is closed only with the customer’s code, and never pays out on a wrong one', async () => {
  const ctx = await seedMarketOrder({ stallCount: 2 });
  await packAll(ctx);
  for (const s of ctx.stalls) {
    await api()
      .post(`/api/rider/orders/${ctx.orderId}/collect`)
      .set(auth(ctx.rider.accessToken))
      .send({ stallId: s.stall._id.toHexString(), code: await stallPickupCode(ctx.orderId, s.accessToken) })
      .expect(200);
  }
  const code = await deliveryCode(ctx.orderId, ctx.customer.accessToken);

  const wrong = await api()
    .post(`/api/rider/orders/${ctx.orderId}/deliver`)
    .set(auth(ctx.rider.accessToken))
    .send({ code: wrongCodeFor(code) });
  assert.equal(wrong.status, 400);
  const held = await Order.findById(ctx.orderId).lean();
  assert.equal(held.fulfillment.status, 'dispatched');
  assert.equal(held.paymentStatus, 'pending');
  assert.equal(held.settledAt ?? null, null, 'settlement never ran');

  const noCode = await api().post(`/api/rider/orders/${ctx.orderId}/deliver`).set(auth(ctx.rider.accessToken)).send({});
  assert.equal(noCode.status, 400);

  const done = await api()
    .post(`/api/rider/orders/${ctx.orderId}/deliver`)
    .set(auth(ctx.rider.accessToken))
    .send({ code });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.fulfillment.status, 'delivered');
});

test('no order payload anywhere carries a live code, whoever asks', async () => {
  const ctx = await seedMarketOrder({ stallCount: 2 });
  await packAll(ctx);
  const stallCodes = await Promise.all(ctx.stalls.map((s) => stallPickupCode(ctx.orderId, s.accessToken)));

  const developer = await authenticatedUser('developer');
  const reads = [
    ['rider', ctx.rider.accessToken, '/api/rider/orders'],
    ['rider', ctx.rider.accessToken, '/api/orders'],
    ['stall', ctx.stalls[0].accessToken, '/api/stalls/me/orders'],
    ['customer', ctx.customer.accessToken, '/api/orders'],
    ['developer', developer.accessToken, '/api/orders'],
    ['developer', developer.accessToken, '/api/developer/dump'],
  ];

  for (const [who, token, path] of reads) {
    const res = await api().get(path).set(auth(token));
    assert.equal(res.status, 200, `${who} ${path}: ${res.status}`);
    for (const code of stallCodes) {
      assert.equal(carriesCode(res.body, code), false, `${who} ${path} carried a stall code`);
    }
  }
});

// ---------------------------------------------------------------------------
// The pieces underneath
// ---------------------------------------------------------------------------

test('a new code is never one already live on the same order', () => {
  const original = crypto.randomInt;
  const sequence = [123456, 123456, 123456, 654321];
  crypto.randomInt = () => sequence.shift();
  try {
    assert.equal(handover.generateCode(new Set(['123456'])), '654321');
  } finally {
    crypto.randomInt = original;
  }
});

test('codes are zero-padded to six digits and compared exactly', () => {
  const original = crypto.randomInt;
  crypto.randomInt = () => 42;
  try {
    assert.equal(handover.generateCode(), '000042');
  } finally {
    crypto.randomInt = original;
  }
  assert.equal(handover.codesMatch('000042', '000042'), true);
  assert.equal(handover.codesMatch('000042', '42'), false);
  assert.equal(handover.codesMatch('000042', undefined), false);
});

test('the rider-held pickupCode left on old orders is removed on boot, and only that', async () => {
  const raw = mongoose.connection.collection('orders');
  const { insertedId } = await raw.insertOne({ orderNumber: 'VBLEGACY', status: 'Preparing', pickupCode: '482913' });

  const first = await migrateDroppedPickupCode();
  assert.equal(first.cleared, 1);

  const after = await raw.findOne({ _id: insertedId });
  assert.equal('pickupCode' in after, false);
  assert.equal(after.orderNumber, 'VBLEGACY', 'nothing else on the order is touched');

  const second = await migrateDroppedPickupCode();
  assert.equal(second.cleared, 0, 'idempotent');
});
