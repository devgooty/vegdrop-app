'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { startTestServer, stopTestServer, resetDatabase, createUser } = require('./helpers');

const config = require('../config/env');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const dispatch = require('../services/dispatch');
const sweeper = require('../services/sweeper');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function newUser(role) {
  const { user } = await createUser({ role });
  return user;
}

/** A shopkeeper with a pinned location, the way routes/shops.js sets one up. */
async function seedShop({ lng = 78.4867, lat = 17.385 } = {}) {
  const owner = await newUser('shopkeeper');
  await User.updateOne(
    { _id: owner._id },
    {
      $set: {
        'shop.name': 'Test Shop',
        'shop.address': 'Test Address',
        'shop.location': { type: 'Point', coordinates: [lng, lat] },
        'shop.locationUpdatedAt': new Date(),
      },
    }
  );
  return User.findById(owner._id);
}

/** A rider standing at a given offset from the shop, on duty and freshly pinged. */
async function seedRider({ shop, metresEast = 0, dutyStatus = 'online', ageSeconds = 0 }) {
  const rider = await newUser('delivery');
  const [lng, lat] = shop.shop.location.coordinates;
  const offsetDeg = metresEast / (111320 * Math.cos((lat * Math.PI) / 180));

  await User.updateOne(
    { _id: rider._id },
    {
      $set: {
        'rider.dutyStatus': dutyStatus,
        'rider.lastLocation': { type: 'Point', coordinates: [lng + offsetDeg, lat] },
        'rider.lastLocationAt': new Date(Date.now() - ageSeconds * 1000),
      },
    }
  );

  return rider;
}

/** A confirmed (`Preparing`) order placed against an independent shop. */
async function seedShopOrder({ shop, customer } = {}) {
  const buyer = customer || (await newUser('customer'));
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
    items: [
      {
        product: product._id,
        name: product.name,
        unitPricePaise: 4000,
        quantity: 1,
        lineTotalPaise: 4000,
      },
    ],
    subtotalPaise: 4000,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Preparing',
    shop: shop._id,
    shopName: shop.shop.name,
  });

  return Order.findById(order._id);
}

// ---------------------------------------------------------------------------
// Choosing a rider
// ---------------------------------------------------------------------------

test('a confirmed shop order is assigned to the rider nearest the shop', async () => {
  const shop = await seedShop();
  const far = await seedRider({ shop, metresEast: 3000 });
  const near = await seedRider({ shop, metresEast: 200 });

  const order = await seedShopOrder({ shop });

  const result = await dispatch.offerShopOrderToNearestRider(order._id);

  assert.equal(result.assigned, true);
  assert.equal(String(result.rider._id), String(near._id), 'the closer rider should be picked');
  assert.notEqual(String(result.rider._id), String(far._id));

  const after = await Order.findById(order._id);
  assert.equal(String(after.assignedTo), String(near._id), 'assignedTo is what hides it from every other rider');
});

test('assigning removes the order from the pool other riders would otherwise see', async () => {
  const shop = await seedShop();
  const near = await seedRider({ shop, metresEast: 100 });
  const other = await seedRider({ shop, metresEast: 5000 });

  const order = await seedShopOrder({ shop });
  await dispatch.offerShopOrderToNearestRider(order._id);

  // The open-pool clause in visibilityFilter only matches assignedTo: null.
  const stillOpen = await Order.countDocuments({
    _id: order._id,
    assignedTo: null,
    shop: { $ne: null },
    status: { $in: ['Preparing', 'Out for Delivery'] },
  });
  assert.equal(stillOpen, 0);

  const mine = await Order.countDocuments({ _id: order._id, assignedTo: near._id });
  assert.equal(mine, 1);
  void other;
});

test('an off-duty rider is never assigned a shop order', async () => {
  const shop = await seedShop();
  await seedRider({ shop, metresEast: 100, dutyStatus: 'offline' });

  const order = await seedShopOrder({ shop });
  const result = await dispatch.offerShopOrderToNearestRider(order._id);

  assert.equal(result.assigned, false);
  assert.equal(result.reason, 'NO_RIDER_AVAILABLE');
});

test('a rider whose position has gone stale is treated as gone', async () => {
  const shop = await seedShop();
  await seedRider({
    shop,
    metresEast: 100,
    ageSeconds: config.marketplace.riderStaleLocationSeconds + 60,
  });

  const order = await seedShopOrder({ shop });
  const result = await dispatch.offerShopOrderToNearestRider(order._id);

  assert.equal(result.assigned, false, 'a killed app never gets to say it went offline');
});

test('an order for a shop with no pinned location cannot be dispatched', async () => {
  // Deliberately no `shop.location` set, unlike seedShop() above.
  const owner = await newUser('shopkeeper');
  const rider = await newUser('delivery');
  await User.updateOne(
    { _id: rider._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: [78.4867, 17.385] },
        'rider.lastLocationAt': new Date(),
      },
    }
  );

  const order = await seedShopOrder({ shop: owner });
  const result = await dispatch.offerShopOrderToNearestRider(order._id);

  assert.equal(result.assigned, false);
  assert.equal(result.reason, 'SHOP_HAS_NO_LOCATION');
});

// ---------------------------------------------------------------------------
// The timeout cascade
// ---------------------------------------------------------------------------

test('a missed handoff moves the order to the next nearest rider', async () => {
  const shop = await seedShop();
  const near = await seedRider({ shop, metresEast: 100 });
  const next = await seedRider({ shop, metresEast: 900 });

  const order = await seedShopOrder({ shop });
  const first = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(String(first.rider._id), String(near._id));

  // Force the deadline shut rather than waiting out the real timeout.
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer.expiresAt': new Date(Date.now() - 1000) } }
  );

  const result = await dispatch.expireShopOrderAssignment(order._id);
  assert.equal(result.action, 'reoffered');
  assert.equal(result.next.assigned, true);

  const after = await Order.findById(order._id);
  assert.equal(String(after.assignedTo), String(next._id));
  assert.ok(
    after.fulfillment.riderOffer.declinedBy.some((id) => String(id) === String(near._id)),
    'the rider who missed it must not be handed it again'
  );
});

test('the cascade gives up after enough missed handoffs and opens the order to anyone', async () => {
  const shop = await seedShop();
  await seedRider({ shop, metresEast: 100 });

  const order = await seedShopOrder({ shop });

  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        'fulfillment.riderOffer.count': config.marketplace.riderMaxOffers,
        'fulfillment.riderOffer.rider': null,
        'fulfillment.riderOffer.expiresAt': null,
        assignedTo: null,
      },
    }
  );

  const result = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(result.reason, 'OPEN_POOL');

  const after = await Order.findById(order._id);
  assert.equal(after.fulfillment.riderOffer.openPool, true);
  assert.equal(after.assignedTo, null, 'the pool is only reachable once assignedTo is cleared');
});

test('a shop order with nobody online yet is not pooled prematurely', async () => {
  const shop = await seedShop();
  const order = await seedShopOrder({ shop });

  const result = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(result.reason, 'NO_RIDER_AVAILABLE');

  const after = await Order.findById(order._id).lean();
  assert.equal(after.fulfillment.riderOffer.openPool, false);

  const rider = await seedRider({ shop, metresEast: 100 });
  const offered = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(offered.assigned, true);
  assert.equal(String(offered.rider._id), String(rider._id));
});

test('an assignment still short of its deadline is left alone', async () => {
  const shop = await seedShop();
  const near = await seedRider({ shop, metresEast: 100 });

  const order = await seedShopOrder({ shop });
  await dispatch.offerShopOrderToNearestRider(order._id);

  const result = await dispatch.expireShopOrderAssignment(order._id);
  assert.equal(result.action, 'skipped');

  const after = await Order.findById(order._id);
  assert.equal(String(after.assignedTo), String(near._id), 'still assigned; the deadline has not passed');
});

// ---------------------------------------------------------------------------
// The sweeper
// ---------------------------------------------------------------------------

test('the sweeper assigns a rider that came online after confirmation, then cascades on timeout', async () => {
  const shop = await seedShop();
  const order = await seedShopOrder({ shop });

  let fresh = await Order.findById(order._id);
  assert.equal(fresh.assignedTo, null);

  const rider = await seedRider({ shop, metresEast: 100 });
  await sweeper.sweepShopOrderAssignments();

  fresh = await Order.findById(order._id);
  assert.equal(String(fresh.assignedTo), String(rider._id));

  const second = await seedRider({ shop, metresEast: 900 });
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'fulfillment.riderOffer.expiresAt': new Date(Date.now() - 1000) } }
  );

  await sweeper.sweepShopOrderAssignments();
  fresh = await Order.findById(order._id);
  assert.equal(String(fresh.assignedTo), String(second._id));
});

test('a market order is never touched by the shop-order sweep', async () => {
  // A shop-order function reaching into a market order would corrupt the
  // sourcing engine's own state machine; the `shop` field is what keeps them
  // apart, so this is the guard that matters most.
  const owner = await newUser('customer');
  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: owner._id,
    customerName: owner.name,
    phone: owner.phone,
    address: '12 Test Lane',
    items: [
      {
        product: new mongoose.Types.ObjectId(),
        name: 'Tomato',
        unitPricePaise: 4000,
        quantity: 1,
        lineTotalPaise: 4000,
      },
    ],
    subtotalPaise: 4000,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Preparing',
  });

  const result = await dispatch.offerShopOrderToNearestRider(order._id);
  assert.equal(result.assigned, false);
  assert.equal(result.reason, 'NOT_SHOP_ORDER');
});
