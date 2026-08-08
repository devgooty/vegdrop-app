'use strict';

/**
 * Cancelling a market order must refund only when it actually cancels.
 *
 * The refund in cancelMarketOrder is issued BEFORE the guarded state change, on
 * the theory that a lost race is replayed by whoever won. That reasoning only
 * holds while the order is genuinely still cancellable — past the lock there is
 * no winner to replay it, so the credit lands and the order carries on.
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

const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const wallet = require('../services/wallet');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/**
 * A wallet-paid market order that has already locked, because a stall with
 * declared stock and auto-accept answered at checkout.
 */
async function lockedWalletOrder() {
  const customer = await authenticatedUser('customer');
  await wallet.credit({
    userId: customer.user._id,
    amountPaise: 100000,
    reason: 'razorpay_topup',
    idempotencyKey: `seed:${uniq()}`,
  });

  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
  });
  const tomato = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 500,
  });
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  const keeper = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber: 'A-1',
    name: 'Stall A-1',
    owner: keeper.user._id,
    autoAccept: true,
    status: 'approved',
  });
  await StallInventory.create({
    stall: stall._id,
    market: market._id,
    product: tomato._id,
    stock: 100,
  });

  const placed = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'wallet',
      marketId: market._id.toHexString(),
      lat: 17.385,
      lng: 78.4867,
    });

  assert.equal(placed.status, 201, JSON.stringify(placed.body));

  const order = await Order.findById(placed.body.data.id);
  assert.equal(order.fulfillment.status, 'packing', 'auto-accept should have locked the order');
  assert.equal(order.paymentStatus, 'paid');

  return { customer, order };
}

test('a refused cancel past the lock does not refund the customer', async () => {
  const { customer, order } = await lockedWalletOrder();

  const before = await wallet.getBalancePaise(customer.user._id);

  const res = await api()
    .patch(`/api/orders/${order._id}/status`)
    .set(auth(customer.accessToken))
    .send({ status: 'Cancelled' });

  assert.equal(res.status, 409, 'a locked order must not be cancellable by the customer');

  const after = await wallet.getBalancePaise(customer.user._id);
  assert.equal(
    after,
    before,
    `refused cancel still credited ₹${(after - before) / 100} — the customer keeps the goods AND the money`
  );

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.paymentStatus, 'paid', 'payment status must not move on a refused cancel');
  assert.equal(fresh.fulfillment.status, 'packing');
});

test('a cancel while still sourcing does refund', async () => {
  const customer = await authenticatedUser('customer');
  await wallet.credit({
    userId: customer.user._id,
    amountPaise: 100000,
    reason: 'razorpay_topup',
    idempotencyKey: `seed:${uniq()}`,
  });

  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
  });
  const tomato = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 500,
  });
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 4000 });

  const placed = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: tomato._id.toHexString(), quantity: 2 }],
      address: '12 Test Lane',
      paymentMethod: 'wallet',
      marketId: market._id.toHexString(),
    });

  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const orderId = placed.body.data.id;

  const before = await wallet.getBalancePaise(customer.user._id);

  const res = await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(customer.accessToken))
    .send({ status: 'Cancelled' });

  assert.equal(res.status, 200, JSON.stringify(res.body));

  const after = await wallet.getBalancePaise(customer.user._id);
  assert.equal(after - before, 8000 + 2500, 'a real cancel refunds the full order total');

  const fresh = await Order.findById(orderId);
  assert.equal(fresh.paymentStatus, 'refunded');
  assert.equal(fresh.fulfillment.status, 'cancelled');
});
