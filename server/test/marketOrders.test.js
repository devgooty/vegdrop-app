'use strict';

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

const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const sourcing = require('../services/sourcing');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedProduct(name = 'Tomato', pricePaise = 9900) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise, stock: 500 });
}

async function seedMarket({ name = 'Rythu Bazaar', lng = 78.4867, lat = 17.385, owner = null } = {}) {
  return Market.create({
    name,
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [lng, lat] },
    // A market_owner only sees orders in markets they own, so any test acting as
    // one has to say which market is theirs. Left null for the majority of tests,
    // which act as a customer, a shopkeeper or a rider and do not care.
    owner,
  });
}

/** A stall plus a signed-in shopkeeper who owns it. */
async function seedStallWithOwner(market, { stallNumber = 'A-1', autoAccept = false } = {}) {
  const session = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: session.user._id,
    autoAccept,
    status: 'approved',
  });
  return { ...session, stall };
}

// ---------------------------------------------------------------------------
// Checkout against a market
// ---------------------------------------------------------------------------

test('an order placed at a market is priced from that market sheet, not the catalog', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct('Tomato', 9900); // catalog says ₹99
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 }); // market says ₹40

  const res = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
      lat: 17.385,
      lng: 78.4867,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.items[0].unitPricePaise, 4000, 'the market price wins');
  assert.equal(res.body.data.subtotalPaise, 8000);
  assert.equal(res.body.data.marketName, 'Rythu Bazaar');
  assert.equal(res.body.data.fulfillment.status, 'sourcing');
  assert.equal(res.body.data.status, 'Pending');
  assert.ok(res.body.data.fulfillment.sourcingDeadline, 'the clock must be running from the start');
});

test('a market that does not sell one of the items refuses the order', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const [tomato, okra] = await Promise.all([seedProduct('Tomato'), seedProduct('Okra')]);
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  // No price sheet entry for okra.

  const res = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [
        { productId: tomato._id.toHexString(), quantity: 1 },
        { productId: okra._id.toHexString(), quantity: 1 },
      ],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'MARKET_CANNOT_FILL');
});

test('an order with no market keeps the original behaviour exactly', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct('Tomato', 9900);

  const res = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.unitPricePaise, undefined);
  assert.equal(res.body.data.items[0].unitPricePaise, 9900, 'catalog price for a marketless order');
  assert.equal(res.body.data.market, null);
  assert.equal(res.body.data.status, 'Pending');
  assert.equal(res.body.data.fulfillment.status, null, 'no sourcing machinery at all');
});

test('a stall with declared stock accepts the order before the response comes back', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  const { stall } = await seedStallWithOwner(market, { stallNumber: 'A-1', autoAccept: true });
  await StallInventory.create({
    stall: stall._id,
    market: market._id,
    product: tomato._id,
    stock: 50,
  });

  const res = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.fulfillment.status, 'packing', 'auto-accept answers instantly');
  assert.equal(res.body.data.status, 'Preparing');
  assert.ok(res.body.data.fulfillment.lockedAt);
});

// ---------------------------------------------------------------------------
// The stall's own view
// ---------------------------------------------------------------------------

test('a stall sees the goods but never the customer', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market);

  await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Secret Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  const res = await api().get('/api/stalls/me/orders').set(auth(shop.accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.offers.length, 1);

  const offer = res.body.data.offers[0];
  assert.equal(offer.openLines.length, 1);
  assert.equal(offer.openLines[0].quantity, 2);

  const serialised = JSON.stringify(offer);
  assert.ok(!serialised.includes('Secret Lane'), 'the delivery address is not a stall\'s business');
  assert.ok(!serialised.includes(customer.user.phone), 'nor is the customer phone number');
});

test('a stall can accept lines, and the second stall is told it lost them', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  const a = await seedStallWithOwner(market, { stallNumber: 'A-1' });
  const b = await seedStallWithOwner(market, { stallNumber: 'B-2' });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  const orderId = created.body.data.id;
  const lineId = created.body.data.items[0].lineId;

  const first = await api()
    .post(`/api/stalls/orders/${orderId}/claim`)
    .set(auth(a.accessToken))
    .send({ lineIds: [lineId] });

  assert.equal(first.status, 200);
  assert.equal(first.body.data.won.length, 1);
  assert.equal(first.body.data.locked, true, 'the only line, so the order locks');

  const second = await api()
    .post(`/api/stalls/orders/${orderId}/claim`)
    .set(auth(b.accessToken))
    .send({ lineIds: [lineId] });

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'NOT_SOURCING');
});

test('a closed stall cannot accept', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market);

  await api().patch('/api/stalls/me').set(auth(shop.accessToken)).send({ isOpen: false });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  const res = await api()
    .post(`/api/stalls/orders/${created.body.data.id}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'STALL_CLOSED');
});

// ---------------------------------------------------------------------------
// Bundled fix 1 — shopkeepers used to see every order in the system
// ---------------------------------------------------------------------------

test('a shopkeeper cannot see orders belonging to another market', async () => {
  const customer = await authenticatedUser('customer');

  const mine = await seedMarket({ name: 'My Market', lng: 78.48, lat: 17.38 });
  const theirs = await seedMarket({ name: 'Their Market', lng: 78.6, lat: 17.5 });

  const tomato = await seedProduct();
  await MarketPrice.create({ market: theirs._id, product: tomato._id, pricePaise: 4000 });

  const outsider = await seedStallWithOwner(mine, { stallNumber: 'A-1' });

  await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Confidential Lane',
      paymentMethod: 'cod',
      marketId: theirs._id.toHexString(),
    });

  // The stall feed is scoped to their own market.
  const feed = await api().get('/api/stalls/me/orders').set(auth(outsider.accessToken));
  assert.equal(feed.body.data.offers.length, 0);

  // And so is the general order list, which used to return everything.
  const list = await api().get('/api/orders').set(auth(outsider.accessToken));
  assert.equal(list.status, 200);
  assert.equal(
    list.body.data.length,
    0,
    'a shopkeeper in another market must not see the name, phone or address'
  );
});

test('a shopkeeper cannot claim into a market they do not trade in', async () => {
  const customer = await authenticatedUser('customer');
  const mine = await seedMarket({ name: 'Mine', lng: 78.48, lat: 17.38 });
  const theirs = await seedMarket({ name: 'Theirs', lng: 78.6, lat: 17.5 });

  const tomato = await seedProduct();
  await MarketPrice.create({ market: theirs._id, product: tomato._id, pricePaise: 4000 });

  const outsider = await seedStallWithOwner(mine, { stallNumber: 'A-1' });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: theirs._id.toHexString(),
    });

  const res = await api()
    .post(`/api/stalls/orders/${created.body.data.id}/claim`)
    .set(auth(outsider.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });

  // 404, not 403 — order ids must not be probeable across markets.
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Bundled fix 3 — staff could force a sourcing order to Preparing
// ---------------------------------------------------------------------------

test('staff cannot push a market order straight to Preparing', async () => {
  const customer = await authenticatedUser('customer');
  const owner = await authenticatedUser('market_owner');
  const market = await seedMarket({ owner: owner.user._id });
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  const res = await api()
    .patch(`/api/orders/${created.body.data.id}/status`)
    .set(auth(owner.accessToken))
    .send({ status: 'Preparing' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'MARKET_ORDER_IMMUTABLE');

  const fresh = await Order.findById(created.body.data.id);
  assert.equal(fresh.fulfillment.status, 'sourcing', 'the claim race is still the only way in');
  assert.equal(fresh.status, 'Pending');
});

test('the legacy status flow still works for a marketless order', async () => {
  const customer = await authenticatedUser('customer');
  const keeper = await authenticatedUser('shopkeeper');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
    });

  const res = await api()
    .patch(`/api/orders/${created.body.data.id}/status`)
    .set(auth(keeper.accessToken))
    .send({ status: 'Preparing' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'Preparing');
});

// ---------------------------------------------------------------------------
// The cancellation cutoff, over HTTP
// ---------------------------------------------------------------------------

test('a customer can cancel while stalls are still deciding, but not after', async () => {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market);

  const place = () =>
    api()
      .post('/api/orders')
      .set(auth(customer.accessToken))
      .send({
        items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
        address: '12 Test Lane',
        paymentMethod: 'cod',
        marketId: market._id.toHexString(),
      });

  // While sourcing: allowed.
  const first = await place();
  const cancelled = await api()
    .patch(`/api/orders/${first.body.data.id}/status`)
    .set(auth(customer.accessToken))
    .send({ status: 'Cancelled' });

  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.fulfillment.status, 'cancelled');
  assert.equal(cancelled.body.data.status, 'Cancelled');
  assert.equal(
    (await Product.findById(tomato._id)).stock,
    500,
    'cancelling puts the stock back'
  );

  // Once a stall has accepted: refused.
  const second = await place();
  await api()
    .post(`/api/stalls/orders/${second.body.data.id}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [second.body.data.items[0].lineId] });

  const late = await api()
    .patch(`/api/orders/${second.body.data.id}/status`)
    .set(auth(customer.accessToken))
    .send({ status: 'Cancelled' });

  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ORDER_LOCKED');
  assert.equal((await Order.findById(second.body.data.id)).fulfillment.status, 'packing');
});

test('a market owner can still call off an order that is already packing', async () => {
  const customer = await authenticatedUser('customer');
  const owner = await authenticatedUser('market_owner');
  const market = await seedMarket({ owner: owner.user._id });
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market);

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  await api()
    .post(`/api/stalls/orders/${created.body.data.id}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });

  const res = await api()
    .patch(`/api/orders/${created.body.data.id}/status`)
    .set(auth(owner.accessToken))
    .send({ status: 'Cancelled' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.fulfillment.status, 'cancelled');
  assert.equal((await Stall.findById(shop.stall._id)).activeLoad, 0, 'the stall is released');
});

// ---------------------------------------------------------------------------
// Bundled fix 2 — riders could never see their own offer
// ---------------------------------------------------------------------------

test('a rider sees the pickup they are being offered', async () => {
  const customer = await authenticatedUser('customer');
  const rider = await authenticatedUser('delivery');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market, { stallNumber: 'C-7' });

  // The rider comes on duty and reports where they are.
  await api()
    .post('/api/rider/location')
    .set(auth(rider.accessToken))
    .send({ lat: 17.3851, lng: 78.4868 });
  await api().patch('/api/rider/duty').set(auth(rider.accessToken)).send({ dutyStatus: 'online' });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  await api()
    .post(`/api/stalls/orders/${created.body.data.id}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });

  await sourcing.settlePending();

  const feed = await api().get('/api/rider/orders').set(auth(rider.accessToken));
  assert.equal(feed.status, 200);
  assert.equal(feed.body.data.offers.length, 1, 'the offer must actually reach the rider we chose');

  const offer = feed.body.data.offers[0];
  assert.equal(offer.marketName, 'Rythu Bazaar');
  assert.equal(offer.stallCount, 1);
  assert.equal(offer.pickups[0].stallNumber, 'C-7', 'the rider needs the stall number to walk to');

  // The general order list must show it too — that is where the fix was needed.
  const list = await api().get('/api/orders').set(auth(rider.accessToken));
  assert.equal(list.body.data.length, 1);
});

test('a rider walks the stalls and the last one sends the order out', async () => {
  const customer = await authenticatedUser('customer');
  const rider = await authenticatedUser('delivery');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market, { stallNumber: 'C-7' });

  await api()
    .post('/api/rider/location')
    .set(auth(rider.accessToken))
    .send({ lat: 17.3851, lng: 78.4868 });
  await api().patch('/api/rider/duty').set(auth(rider.accessToken)).send({ dutyStatus: 'online' });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  const orderId = created.body.data.id;

  await api()
    .post(`/api/stalls/orders/${orderId}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });
  await sourcing.settlePending();

  const accepted = await api().post(`/api/rider/orders/${orderId}/accept`).set(auth(rider.accessToken));
  assert.equal(accepted.status, 200);

  // The stall bags it.
  const packed = await api().post(`/api/stalls/orders/${orderId}/pack`).set(auth(shop.accessToken)).send({});
  assert.equal(packed.status, 200);
  assert.equal((await Order.findById(orderId)).fulfillment.status, 'collecting');

  const collected = await api()
    .post(`/api/rider/orders/${orderId}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: shop.stall._id.toHexString() });

  assert.equal(collected.status, 200);
  assert.equal(collected.body.data.dispatched, true);

  const fresh = await Order.findById(orderId);
  assert.equal(fresh.fulfillment.status, 'dispatched');
  assert.equal(fresh.status, 'Out for Delivery');

  // A market order is closed out through the market flow, not by hand.
  const byHand = await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(rider.accessToken))
    .send({ status: 'Delivered' });
  assert.equal(byHand.status, 409);

  const done = await api().post(`/api/rider/orders/${orderId}/deliver`).set(auth(rider.accessToken));
  assert.equal(done.status, 200);
  assert.equal(done.body.data.fulfillment.status, 'delivered');
  assert.equal(done.body.data.status, 'Delivered');
  assert.equal(done.body.data.paymentStatus, 'paid', 'COD is collected at the door');
});

test('only the assigned rider can mark a market order delivered', async () => {
  const customer = await authenticatedUser('customer');
  const rider = await authenticatedUser('delivery');
  const other = await authenticatedUser('delivery');
  const market = await seedMarket();
  const tomato = await seedProduct();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  const shop = await seedStallWithOwner(market, { stallNumber: 'C-7' });

  await api().post('/api/rider/location').set(auth(rider.accessToken)).send({ lat: 17.3851, lng: 78.4868 });
  await api().patch('/api/rider/duty').set(auth(rider.accessToken)).send({ dutyStatus: 'online' });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 1 }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });

  const orderId = created.body.data.id;
  await api()
    .post(`/api/stalls/orders/${orderId}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [created.body.data.items[0].lineId] });
  await sourcing.settlePending();

  await api().post(`/api/rider/orders/${orderId}/accept`).set(auth(rider.accessToken));
  await api().post(`/api/stalls/orders/${orderId}/pack`).set(auth(shop.accessToken)).send({});
  await api()
    .post(`/api/rider/orders/${orderId}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: shop.stall._id.toHexString() });

  const stolen = await api().post(`/api/rider/orders/${orderId}/deliver`).set(auth(other.accessToken));
  assert.equal(stolen.status, 404, 'another agent must not be able to close this delivery');
  assert.equal((await Order.findById(orderId)).fulfillment.status, 'dispatched');
});

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

test('nearby markets come back nearest first with their open stall count', async () => {
  const customer = await authenticatedUser('customer');
  const near = await seedMarket({ name: 'Near', lng: 78.4867, lat: 17.385 });
  const far = await seedMarket({ name: 'Far', lng: 78.55, lat: 17.42 });

  await seedStallWithOwner(near, { stallNumber: 'A-1' });
  await seedStallWithOwner(near, { stallNumber: 'A-2' });

  const res = await api()
    .get('/api/markets/nearby?lat=17.385&lng=78.4867&radius=20000')
    .set(auth(customer.accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.data[0].name, 'Near');
  assert.equal(res.body.data[0].openStalls, 2);
  assert.equal(res.body.data[1].name, 'Far');
  assert.ok(res.body.data[1].distanceMeters > res.body.data[0].distanceMeters);
});

test("a market catalog shows only what that market sells, at its own price", async () => {
  const market = await seedMarket({ name: 'Rythu Bazaar' });
  const [tomato, okra] = await Promise.all([seedProduct('Tomato', 9900), seedProduct('Okra', 5000)]);
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });
  // Okra is in the catalog but not on this market's sheet.

  const res = await api().get(`/api/markets/${market._id.toHexString()}/catalog`);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].name, 'Tomato');
  assert.equal(res.body.data[0].pricePaise, 4000);
  assert.equal(res.body.data[0].marketName, 'Rythu Bazaar', 'the card shows the market name too');
  assert.ok(!res.body.data.some((p) => p.name === 'Okra'));
});
