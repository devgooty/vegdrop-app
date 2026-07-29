'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  createUser,
  authenticatedUser,
  auth,
} = require('./helpers');

const Market = require('../models/Market');
const Stall = require('../models/Stall');
const Product = require('../models/Product');
const Order = require('../models/Order');
const StallOrder = require('../models/StallOrder');
const WalletTransaction = require('../models/WalletTransaction');
const fulfilment = require('../services/fulfilment');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

// --- Fixtures --------------------------------------------------------------

const HYD = { latitude: 17.3833, longitude: 78.4333 };

async function makeMarket(overrides = {}) {
  return Market.create({
    name: overrides.name || 'Test Market',
    slug: overrides.slug || `market-${Math.random().toString(36).slice(2, 10)}`,
    address: 'Somewhere',
    city: 'Hyderabad',
    location: {
      type: 'Point',
      coordinates: [overrides.longitude ?? HYD.longitude, overrides.latitude ?? HYD.latitude],
    },
    serviceRadiusM: overrides.serviceRadiusM ?? 8000,
  });
}

/** A stall plus its owning shopkeeper, since ownership is what authorizes writes. */
async function makeStall(market, { stallNumber = 'A-01', name = 'Test Stall' } = {}) {
  const { user, password } = await createUser({ role: 'shopkeeper' });
  const stall = await Stall.create({
    market: market._id,
    owner: user._id,
    stallNumber,
    name,
    phone: user.phone,
  });
  return { stall, owner: user, password };
}

async function makeProduct(stall, { sku = 'VEG-TEST-1', pricePaise = 5000, stock = 10 } = {}) {
  return Product.create({
    sku,
    stall: stall._id,
    market: stall.market,
    categoryId: 1,
    name: `Product ${sku}`,
    pricePaise,
    stock,
  });
}

/** Two stalls in one market, one product each — the minimum multi-stall basket. */
async function twoStallSetup() {
  const market = await makeMarket();
  const a = await makeStall(market, { stallNumber: 'A-01', name: 'Stall A' });
  const b = await makeStall(market, { stallNumber: 'B-12', name: 'Stall B' });
  const productA = await makeProduct(a.stall, { sku: 'SKU-A', pricePaise: 10000, stock: 5 });
  const productB = await makeProduct(b.stall, { sku: 'SKU-B', pricePaise: 20000, stock: 5 });
  return { market, a, b, productA, productB };
}

async function signInAs(user, password) {
  const { signIn } = require('./helpers');
  return signIn({ identifier: user.email, password });
}

async function placeOrder(customerToken, items, extra = {}) {
  return api()
    .post('/api/orders')
    .set(auth(customerToken))
    .send({
      items,
      address: '12 Test Street',
      paymentMethod: 'cod',
      ...extra,
    });
}

// --- Splitting -------------------------------------------------------------

test('an order spanning two stalls creates one stall order per stall', async () => {
  const { productA, productB, a, b } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  const res = await placeOrder(customer.accessToken, [
    { productId: productA._id.toHexString(), quantity: 2 },
    { productId: productB._id.toHexString(), quantity: 1 },
  ]);

  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'Awaiting Acceptance');
  assert.equal(res.body.data.stallOrderCount, 2);

  const stallOrders = await StallOrder.find({ order: res.body.data.id }).sort({ stallNumber: 1 });
  assert.equal(stallOrders.length, 2);
  assert.equal(stallOrders[0].stallNumber, 'A-01');
  assert.equal(stallOrders[1].stallNumber, 'B-12');

  // Each stall sees only its own money, not the order total.
  assert.equal(stallOrders[0].subtotalPaise, 20000);
  assert.equal(stallOrders[1].subtotalPaise, 20000);
  assert.equal(stallOrders.every((s) => s.status === 'awaiting'), true);

  // Both belong to the right stalls.
  assert.deepEqual(
    stallOrders.map((s) => s.stall.toString()).sort(),
    [a.stall._id.toString(), b.stall._id.toString()].sort()
  );
});

test('a basket mixing two markets is rejected', async () => {
  const marketOne = await makeMarket({ slug: 'one' });
  const marketTwo = await makeMarket({ slug: 'two', latitude: 17.47, longitude: 78.48 });
  const stallOne = await makeStall(marketOne, { stallNumber: 'A-01' });
  const stallTwo = await makeStall(marketTwo, { stallNumber: 'Z-99' });
  const productOne = await makeProduct(stallOne.stall, { sku: 'M1' });
  const productTwo = await makeProduct(stallTwo.stall, { sku: 'M2' });

  const customer = await authenticatedUser('customer');
  const res = await placeOrder(customer.accessToken, [
    { productId: productOne._id.toHexString(), quantity: 1 },
    { productId: productTwo._id.toHexString(), quantity: 1 },
  ]);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'MIXED_MARKETS');
  assert.equal(await Order.countDocuments({}), 0);
});

test('a basket containing a closed stall is refused before payment', async () => {
  const { productA, productB, b } = await twoStallSetup();
  await Stall.updateOne({ _id: b.stall._id }, { $set: { isOpen: false } });

  const customer = await authenticatedUser('customer');
  const res = await placeOrder(customer.accessToken, [
    { productId: productA._id.toHexString(), quantity: 1 },
    { productId: productB._id.toHexString(), quantity: 1 },
  ]);

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'STALL_CLOSED');

  // Nothing was claimed from the open stall either.
  const fresh = await Product.findById(productA._id);
  assert.equal(fresh.stock, 5);
});

// --- All-or-nothing acceptance --------------------------------------------

test('the order confirms only after every stall accepts', async () => {
  const { productA, productB, a, b } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  const created = await placeOrder(customer.accessToken, [
    { productId: productA._id.toHexString(), quantity: 1 },
    { productId: productB._id.toHexString(), quantity: 1 },
  ]);
  const orderId = created.body.data.id;

  const sessionA = await signInAs(a.owner, a.password);
  const sessionB = await signInAs(b.owner, b.password);

  const stallOrderA = await StallOrder.findOne({ order: orderId, stall: a.stall._id });
  const stallOrderB = await StallOrder.findOne({ order: orderId, stall: b.stall._id });

  // First acceptance must NOT confirm the order.
  const first = await api()
    .post(`/api/stall-orders/${stallOrderA._id}/accept`)
    .set(auth(sessionA.accessToken))
    .send({});
  assert.equal(first.status, 200);
  assert.equal(first.body.order.status, 'Awaiting Acceptance');
  assert.equal(first.body.waitingOn, 1);

  // Second one does.
  const second = await api()
    .post(`/api/stall-orders/${stallOrderB._id}/accept`)
    .set(auth(sessionB.accessToken))
    .send({});
  assert.equal(second.status, 200);
  assert.equal(second.body.order.status, 'Confirmed');

  const order = await Order.findById(orderId);
  assert.equal(order.status, 'Confirmed');
  assert.equal(order.acceptedCount, 2);
});

test('one stall rejecting fails the whole order and stands the other down', async () => {
  const { productA, productB, a, b } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  const created = await placeOrder(customer.accessToken, [
    { productId: productA._id.toHexString(), quantity: 2 },
    { productId: productB._id.toHexString(), quantity: 1 },
  ]);
  const orderId = created.body.data.id;

  const sessionA = await signInAs(a.owner, a.password);
  const sessionB = await signInAs(b.owner, b.password);

  const stallOrderA = await StallOrder.findOne({ order: orderId, stall: a.stall._id });
  const stallOrderB = await StallOrder.findOne({ order: orderId, stall: b.stall._id });

  // A accepts...
  await api().post(`/api/stall-orders/${stallOrderA._id}/accept`).set(auth(sessionA.accessToken)).send({});
  // ...but B declines, which kills the order.
  const rejected = await api()
    .post(`/api/stall-orders/${stallOrderB._id}/reject`)
    .set(auth(sessionB.accessToken))
    .send({ reason: 'Sold out today' });

  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.order.status, 'Rejected');

  const order = await Order.findById(orderId);
  assert.equal(order.status, 'Rejected');
  assert.equal(order.rejectionReason, 'Sold out today');

  // The stall that accepted is cancelled, not left hanging.
  const after = await StallOrder.findById(stallOrderA._id);
  assert.equal(after.status, 'cancelled');

  // All stock is back.
  assert.equal((await Product.findById(productA._id)).stock, 5);
  assert.equal((await Product.findById(productB._id)).stock, 5);
});

test('a wallet hold is released in full when a stall rejects', async () => {
  const { productA, productB, b } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  // Fund the wallet: 1000 rupees.
  await WalletTransaction.create({
    user: customer.user._id,
    type: 'credit',
    amountPaise: 100000,
    balanceAfterPaise: 100000,
    reason: 'promotional_credit',
    idempotencyKey: `seed:${customer.user._id}`,
  });

  const created = await placeOrder(
    customer.accessToken,
    [
      { productId: productA._id.toHexString(), quantity: 1 },
      { productId: productB._id.toHexString(), quantity: 1 },
    ],
    { paymentMethod: 'wallet' }
  );
  assert.equal(created.status, 201);

  const orderId = created.body.data.id;
  const held = await Order.findById(orderId);
  assert.equal(held.paymentStatus, 'held');

  // Money is out of the spendable balance while held.
  const duringHold = await WalletTransaction.currentBalancePaise(customer.user._id);
  assert.equal(duringHold, 100000 - held.totalAmountPaise);

  const sessionB = await signInAs(b.owner, b.password);
  const stallOrderB = await StallOrder.findOne({ order: orderId, stall: b.stall._id });
  await api().post(`/api/stall-orders/${stallOrderB._id}/reject`).set(auth(sessionB.accessToken)).send({});

  // ...and fully back afterwards.
  const afterRelease = await WalletTransaction.currentBalancePaise(customer.user._id);
  assert.equal(afterRelease, 100000);

  const settled = await Order.findById(orderId);
  assert.equal(settled.paymentStatus, 'refunded');
});

test('a stall that does not answer in time is auto-rejected by the sweeper', async () => {
  const { productA, productB } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  const created = await placeOrder(customer.accessToken, [
    { productId: productA._id.toHexString(), quantity: 1 },
    { productId: productB._id.toHexString(), quantity: 1 },
  ]);
  const orderId = created.body.data.id;

  // Wind every deadline into the past rather than waiting three real minutes.
  await StallOrder.updateMany({ order: orderId }, { $set: { respondByAt: new Date(Date.now() - 1000) } });

  const failedCount = await fulfilment.sweepExpiredStallOrders();
  assert.ok(failedCount >= 1);

  const order = await Order.findById(orderId);
  assert.equal(order.status, 'Rejected');
  assert.match(order.rejectionReason, /did not respond/i);

  assert.equal((await Product.findById(productA._id)).stock, 5);
});

test('a stall cannot accept another stall\'s slice', async () => {
  const { productA, productB, a, b } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  const created = await placeOrder(customer.accessToken, [
    { productId: productA._id.toHexString(), quantity: 1 },
    { productId: productB._id.toHexString(), quantity: 1 },
  ]);

  const stallOrderB = await StallOrder.findOne({ order: created.body.data.id, stall: b.stall._id });
  const sessionA = await signInAs(a.owner, a.password);

  const res = await api()
    .post(`/api/stall-orders/${stallOrderB._id}/accept`)
    .set(auth(sessionA.accessToken))
    .send({});

  // 404, not 403: another stall's ids must not be probeable.
  assert.equal(res.status, 404);
  assert.equal((await StallOrder.findById(stallOrderB._id)).status, 'awaiting');
});

// --- Catalog ownership -----------------------------------------------------

test('a shopkeeper cannot edit another stall\'s product', async () => {
  const market = await makeMarket();
  const a = await makeStall(market, { stallNumber: 'A-01' });
  const b = await makeStall(market, { stallNumber: 'B-12' });
  const productB = await makeProduct(b.stall, { sku: 'SKU-B', pricePaise: 20000 });

  const sessionA = await signInAs(a.owner, a.password);

  const res = await api()
    .patch(`/api/products/${productB._id}`)
    .set(auth(sessionA.accessToken))
    .send({ price: 1 });

  assert.equal(res.status, 404);
  assert.equal((await Product.findById(productB._id)).pricePaise, 20000);
});

test('a shopkeeper can edit their own product', async () => {
  const market = await makeMarket();
  const a = await makeStall(market, { stallNumber: 'A-01' });
  const productA = await makeProduct(a.stall, { sku: 'SKU-A', pricePaise: 10000 });

  const sessionA = await signInAs(a.owner, a.password);

  const res = await api()
    .patch(`/api/products/${productA._id}`)
    .set(auth(sessionA.accessToken))
    .send({ price: 150 });

  assert.equal(res.status, 200);
  assert.equal((await Product.findById(productA._id)).pricePaise, 15000);
});

test('the same SKU may be listed by two different stalls', async () => {
  const market = await makeMarket();
  const a = await makeStall(market, { stallNumber: 'A-01' });
  const b = await makeStall(market, { stallNumber: 'B-12' });

  await makeProduct(a.stall, { sku: 'VEG-TOMATO-1000', pricePaise: 4000 });
  await makeProduct(b.stall, { sku: 'VEG-TOMATO-1000', pricePaise: 4200 });

  assert.equal(await Product.countDocuments({ sku: 'VEG-TOMATO-1000' }), 2);
});

// --- Geo -------------------------------------------------------------------

test('markets are returned nearest-first with a deliverable flag', async () => {
  await makeMarket({ slug: 'near', name: 'Near Market', latitude: 17.3840, longitude: 78.4340 });
  await makeMarket({ slug: 'far', name: 'Far Market', latitude: 17.4747, longitude: 78.4869 });

  const res = await api()
    .get('/api/markets')
    .query({ latitude: HYD.latitude, longitude: HYD.longitude, radiusM: 30000 });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.data[0].name, 'Near Market');
  assert.ok(res.body.data[0].distanceM < res.body.data[1].distanceM);
  assert.equal(res.body.nearest.name, 'Near Market');
});

// --- Rider -----------------------------------------------------------------

test('the rider route lists every stall pickup with a map pin', async () => {
  const { productA, productB, a, b } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  const created = await placeOrder(
    customer.accessToken,
    [
      { productId: productA._id.toHexString(), quantity: 1 },
      { productId: productB._id.toHexString(), quantity: 1 },
    ],
    { latitude: 17.39, longitude: 78.44 }
  );
  const orderId = created.body.data.id;

  const sessionA = await signInAs(a.owner, a.password);
  const sessionB = await signInAs(b.owner, b.password);
  const soA = await StallOrder.findOne({ order: orderId, stall: a.stall._id });
  const soB = await StallOrder.findOne({ order: orderId, stall: b.stall._id });

  await api().post(`/api/stall-orders/${soA._id}/accept`).set(auth(sessionA.accessToken)).send({});
  await api().post(`/api/stall-orders/${soB._id}/accept`).set(auth(sessionB.accessToken)).send({});

  const rider = await authenticatedUser('delivery');
  const res = await api().get(`/api/delivery/orders/${orderId}/route`).set(auth(rider.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.pickups.length, 2);
  assert.equal(res.body.data.pickupsRemaining, 2);

  const [first, second] = res.body.data.pickups;
  assert.equal(first.stallNumber, 'A-01');
  assert.equal(second.stallNumber, 'B-12');
  // Falls back to the market centroid, so a marker always renders.
  assert.ok(typeof first.latitude === 'number');
  assert.ok(typeof first.longitude === 'number');

  assert.equal(res.body.data.dropoff.address, '12 Test Street');
  assert.equal(res.body.data.dropoff.latitude, 17.39);
});

test('a pickup requires the stall\'s code and advances the order when all are collected', async () => {
  const { productA, productB, a, b } = await twoStallSetup();
  const customer = await authenticatedUser('customer');

  const created = await placeOrder(customer.accessToken, [
    { productId: productA._id.toHexString(), quantity: 1 },
    { productId: productB._id.toHexString(), quantity: 1 },
  ]);
  const orderId = created.body.data.id;

  const sessionA = await signInAs(a.owner, a.password);
  const sessionB = await signInAs(b.owner, b.password);
  const soA = await StallOrder.findOne({ order: orderId, stall: a.stall._id });
  const soB = await StallOrder.findOne({ order: orderId, stall: b.stall._id });

  await api().post(`/api/stall-orders/${soA._id}/accept`).set(auth(sessionA.accessToken)).send({});
  const acceptB = await api()
    .post(`/api/stall-orders/${soB._id}/accept`)
    .set(auth(sessionB.accessToken))
    .send({});

  // The final acceptance confirms the order and mints the pickup codes.
  assert.equal(acceptB.body.order.status, 'Confirmed');

  await api().post(`/api/stall-orders/${soA._id}/packed`).set(auth(sessionA.accessToken)).send({});
  await api().post(`/api/stall-orders/${soB._id}/packed`).set(auth(sessionB.accessToken)).send({});

  const rider = await authenticatedUser('delivery');

  // A wrong code is refused.
  const wrong = await api()
    .post(`/api/delivery/stall-orders/${soA._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ pickupCode: '000000' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'INVALID_PICKUP_CODE');

  /**
   * The real codes are only ever returned once, to the vendor. Rather than try
   * to recover them, overwrite each hash with a known code — this asserts the
   * verification path, which is what matters here.
   */
  for (const so of [soA, soB]) {
    await StallOrder.updateOne(
      { _id: so._id },
      { $set: { pickupCodeHash: fulfilment.hashPickupCode(so._id.toHexString(), '123456') } }
    );
  }

  const firstPickup = await api()
    .post(`/api/delivery/stall-orders/${soA._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ pickupCode: '123456' });
  assert.equal(firstPickup.status, 200);
  assert.equal(firstPickup.body.pickupsRemaining, 1);

  // Still in the market — one bag outstanding.
  assert.notEqual((await Order.findById(orderId)).status, 'Out for Delivery');

  const secondPickup = await api()
    .post(`/api/delivery/stall-orders/${soB._id}/pickup`)
    .set(auth(rider.accessToken))
    .send({ pickupCode: '123456' });
  assert.equal(secondPickup.status, 200);
  assert.equal(secondPickup.body.pickupsRemaining, 0);

  assert.equal((await Order.findById(orderId)).status, 'Out for Delivery');
});

// --- Fallback --------------------------------------------------------------

test('a rejected order suggests another market that can fulfil the basket', async () => {
  const { productA, productB, b, market } = await twoStallSetup();

  // A second market a few km away that stocks both SKUs at one open stall.
  const alternative = await makeMarket({ slug: 'alt', name: 'Alternative Market', latitude: 17.4000, longitude: 78.4500 });
  const altStall = await makeStall(alternative, { stallNumber: 'X-01', name: 'Alt Stall' });
  await makeProduct(altStall.stall, { sku: 'SKU-A', pricePaise: 10500, stock: 10 });
  await makeProduct(altStall.stall, { sku: 'SKU-B', pricePaise: 20500, stock: 10 });
  void market;

  const customer = await authenticatedUser('customer');
  const created = await placeOrder(
    customer.accessToken,
    [
      { productId: productA._id.toHexString(), quantity: 1 },
      { productId: productB._id.toHexString(), quantity: 1 },
    ],
    { latitude: HYD.latitude, longitude: HYD.longitude }
  );
  const orderId = created.body.data.id;

  const sessionB = await signInAs(b.owner, b.password);
  const stallOrderB = await StallOrder.findOne({ order: orderId, stall: b.stall._id });
  await api().post(`/api/stall-orders/${stallOrderB._id}/reject`).set(auth(sessionB.accessToken)).send({});

  const res = await api()
    .get(`/api/orders/${orderId}/alternative-markets`)
    .set(auth(customer.accessToken));

  assert.equal(res.status, 200);
  const complete = res.body.data.filter((m) => m.canFulfilAll);
  assert.equal(complete.length, 1);
  assert.equal(complete[0].name, 'Alternative Market');
  assert.deepEqual(complete[0].missingItems, []);
});
