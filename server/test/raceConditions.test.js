'use strict';

/**
 * Two writers, one order.
 *
 * Each test here pins a race that was real: a handler read a document, checked
 * it in JavaScript, and wrote later — so a concurrent writer that landed in
 * between was either overwritten or double-counted. Timing-based tests of that
 * shape pass by luck, so the order-status ones use `afterNextRead` to put the
 * competing write exactly between the route's read and its write, every run.
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
const WalletTransaction = require('../models/WalletTransaction');
const wallet = require('../services/wallet');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/**
 * Run `interleave` after the next `Model.findOne` resolves and before its
 * caller sees the result — i.e. inside the caller's read-then-write window.
 */
function afterNextRead(Model, interleave) {
  const original = Model.findOne;
  Model.findOne = function patched(...args) {
    Model.findOne = original;
    const query = original.apply(this, args);
    const exec = query.exec.bind(query);
    query.exec = async (...rest) => {
      const doc = await exec(...rest);
      await interleave(doc);
      return doc;
    };
    return query;
  };
  return () => {
    Model.findOne = original;
  };
}

/** A wallet-paid order addressed to an independent shop. */
async function shopOrder({ status = 'Pending', paymentMethod = 'wallet' } = {}) {
  const customer = await authenticatedUser('customer');
  const shop = await authenticatedUser('shopkeeper');
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise: 4000,
    stock: 10,
  });

  const order = await Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer.user._id,
    customerName: customer.user.name,
    phone: customer.user.phone,
    address: '12 Test Lane',
    items: [{ product: product._id, name: 'Tomato', unitPricePaise: 4000, quantity: 2, lineTotalPaise: 8000 }],
    subtotalPaise: 8000,
    totalAmountPaise: 8000,
    paymentMethod,
    paymentStatus: paymentMethod === 'wallet' ? 'paid' : 'pending',
    status,
    shop: shop.user._id,
    shopName: 'Test Shop',
  });

  return { customer, shop, product, order };
}

const refundsFor = (order) => WalletTransaction.countDocuments({ idempotencyKey: `refund:${order._id.toHexString()}` });
const stockOf = async (product) => (await Product.findById(product._id).lean()).stock;

// ---------------------------------------------------------------------------
// PATCH /orders/:id/status
// ---------------------------------------------------------------------------

test('a cancel that read "Out for Delivery" cannot overwrite a delivery that landed meanwhile', async () => {
  const { shop, product, order } = await shopOrder({ status: 'Out for Delivery' });

  // The rider types the customer's code while the shopkeeper's cancel is in flight.
  const restore = afterNextRead(Order, () =>
    Order.updateOne({ _id: order._id }, { $set: { status: 'Delivered' } })
  );
  let res;
  try {
    res = await api()
      .patch(`/api/orders/${order._id}/status`)
      .set(auth(shop.accessToken))
      .send({ status: 'Cancelled' });
  } finally {
    restore();
  }

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ORDER_CHANGED');

  const after = await Order.findById(order._id).lean();
  assert.equal(after.status, 'Delivered', 'the delivery must stand');
  assert.equal(after.paymentStatus, 'paid');
  assert.equal(await refundsFor(order), 0, 'the customer has the goods; no refund');
  assert.equal(await stockOf(product), 10, 'delivered goods are not restocked');
});

test('a customer cancel that read "Pending" loses to a shopkeeper accept that landed first', async () => {
  const { customer, order } = await shopOrder({ status: 'Pending' });

  const restore = afterNextRead(Order, () =>
    Order.updateOne({ _id: order._id }, { $set: { status: 'Preparing' } })
  );
  let res;
  try {
    res = await api()
      .patch(`/api/orders/${order._id}/status`)
      .set(auth(customer.accessToken))
      .send({ status: 'Cancelled' });
  } finally {
    restore();
  }

  assert.equal(res.status, 409);
  const after = await Order.findById(order._id).lean();
  assert.equal(after.status, 'Preparing');
  assert.equal(after.paymentStatus, 'paid');
  assert.equal(await refundsFor(order), 0, 'an accepted order must not be refunded and then fulfilled');
});

test('two concurrent cancels refund once and restock once', async () => {
  const { customer, product, order } = await shopOrder({ status: 'Pending' });
  const balanceBefore = await wallet.getBalancePaise(customer.user._id);

  const results = await Promise.all([
    api().patch(`/api/orders/${order._id}/status`).set(auth(customer.accessToken)).send({ status: 'Cancelled' }),
    api().patch(`/api/orders/${order._id}/status`).set(auth(customer.accessToken)).send({ status: 'Cancelled' }),
  ]);

  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await stockOf(product), 12, 'stock comes back exactly once');
  assert.equal(await refundsFor(order), 1);
  assert.equal(await wallet.getBalancePaise(customer.user._id), balanceBefore + 8000);

  const after = await Order.findById(order._id).lean();
  assert.equal(after.status, 'Cancelled');
  assert.equal(after.paymentStatus, 'refunded');
});

test('cancelling a cash-on-delivery order restocks it too', async () => {
  // Checkout decrements stock for every payment method, so cancelling must give
  // it back for every payment method — it used to only for wallet-paid orders.
  const { customer, product, order } = await shopOrder({ status: 'Pending', paymentMethod: 'cod' });

  const res = await api()
    .patch(`/api/orders/${order._id}/status`)
    .set(auth(customer.accessToken))
    .send({ status: 'Cancelled' });

  assert.equal(res.status, 200);
  assert.equal(await stockOf(product), 12);
  assert.equal(await refundsFor(order), 0, 'nothing was paid, so nothing is refunded');
});

// ---------------------------------------------------------------------------
// Auto-accept and declared stall stock
// ---------------------------------------------------------------------------

test('an auto-accept stall is never committed past its declared stock', async () => {
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
  // Enough for one order of 2, not two.
  await StallInventory.create({ stall: stall._id, market: market._id, product: tomato._id, stock: 2 });

  const place = async () => {
    const customer = await authenticatedUser('customer');
    await wallet.credit({
      userId: customer.user._id,
      amountPaise: 100000,
      reason: 'razorpay_topup',
      idempotencyKey: `seed:${uniq()}`,
    });
    return api()
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
  };

  // Hold each order's stall ranking until both have read the inventory, so both
  // plans are made against the same 2 units — the race, every run.
  const realAggregate = StallInventory.aggregate;
  let arrived = 0;
  let release;
  const bothPlanned = new Promise((resolve) => {
    release = resolve;
  });
  StallInventory.aggregate = function patched(...args) {
    const agg = realAggregate.apply(this, args);
    const exec = agg.exec.bind(agg);
    agg.exec = async (...rest) => {
      const rows = await exec(...rest);
      arrived += 1;
      if (arrived === 2) release();
      await Promise.race([bothPlanned, new Promise((resolve) => setTimeout(resolve, 3000))]);
      return rows;
    };
    return agg;
  };

  let placed;
  try {
    placed = await Promise.all([place(), place()]);
  } finally {
    StallInventory.aggregate = realAggregate;
  }
  assert.equal(arrived, 2, 'both orders must have been ranked against the same snapshot');
  assert.ok(placed.every((r) => r.status === 201), JSON.stringify(placed.map((r) => r.body)));

  const orders = await Order.find({ market: market._id }).lean();
  const autoClaimed = orders.filter((o) => o.items.every((i) => String(i.claim?.stall) === String(stall._id)));
  assert.equal(autoClaimed.length, 1, 'only one order may be auto-claimed against 2 units');

  // The other is asked, not assumed: offered to the same stall for a human to decide.
  const other = orders.find((o) => o !== autoClaimed[0]);
  assert.ok(other.items.every((i) => !i.claim?.stall));
  assert.ok(other.items.every((i) => String(i.offer?.stall) === String(stall._id)));

  const inventory = await StallInventory.findOne({ stall: stall._id }).lean();
  assert.equal(inventory.stock, 0, 'drawn down exactly once');
});
