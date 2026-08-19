'use strict';

/**
 * Standing orders.
 *
 * The customer app has had a scheduling calendar since it was written, held
 * entirely in React state: nothing was sent anywhere, no model existed, and a
 * reload cleared it while the screen said "schedule created successfully".
 * These cover the record and the machinery that replaced it — and above all the
 * two properties a recurring charge has to have: it must place exactly one
 * order per occurrence, and it must never silently stop.
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

const ScheduledOrder = require('../models/ScheduledOrder');
const { computeNextRunFor } = require('../models/ScheduledOrder');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const scheduler = require('../services/scheduler');
const wallet = require('../services/wallet');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function seedProduct(name = 'Tomato', pricePaise = 4000) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name, pricePaise, stock: 500 });
}

async function seedMarket() {
  return Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
  });
}

function scheduleBody(product, overrides = {}) {
  return {
    items: [{ productId: product._id.toHexString(), quantity: 2 }],
    address: '12 Banjara Hills, Hyderabad',
    paymentMethod: 'cod',
    frequency: 'daily',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// When the next run falls
// ---------------------------------------------------------------------------

test('a daily schedule runs tomorrow at the chosen hour', () => {
  const from = new Date('2026-03-10T12:00:00');
  const next = computeNextRunFor({ frequency: 'daily', hour: 8, daysOfWeek: [], daysOfMonth: [] }, from);

  assert.equal(next.getDate(), 11, 'noon is past 8am, so the next one is tomorrow');
  assert.equal(next.getHours(), 8);
});

test('a daily schedule set before its hour runs the same day', () => {
  const from = new Date('2026-03-10T06:00:00');
  const next = computeNextRunFor({ frequency: 'daily', hour: 8, daysOfWeek: [], daysOfMonth: [] }, from);

  assert.equal(next.getDate(), 10);
  assert.equal(next.getHours(), 8);
});

test('a weekly schedule lands on the next chosen weekday', () => {
  // 2026-03-10 is a Tuesday.
  const from = new Date('2026-03-10T12:00:00');
  // Friday only.
  const next = computeNextRunFor({ frequency: 'weekly', hour: 7, daysOfWeek: [5], daysOfMonth: [] }, from);

  assert.equal(next.getDay(), 5);
  assert.equal(next.getDate(), 13);
});

/**
 * The reason this walks the calendar instead of doing arithmetic: not every
 * month has a 31st, and a schedule asking only for it must skip the months that
 * do not rather than landing on the 1st of the next one.
 */
test('a monthly schedule on the 31st skips months that have none', () => {
  const from = new Date('2026-01-31T12:00:00');
  const next = computeNextRunFor({ frequency: 'monthly', hour: 8, daysOfWeek: [], daysOfMonth: [31] }, from);

  assert.equal(next.getDate(), 31);
  assert.equal(next.getMonth(), 2, 'February has no 31st, so March');
});

test('days that never come round yield no next run rather than looping', () => {
  const next = computeNextRunFor({ frequency: 'weekly', hour: 8, daysOfWeek: [], daysOfMonth: [] }, new Date());
  assert.equal(next, null);
});

// ---------------------------------------------------------------------------
// Creating and managing
// ---------------------------------------------------------------------------

test('a customer can create a schedule, and it stores intent rather than prices', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const res = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));

  assert.equal(res.status, 201);
  assert.equal(res.body.data.frequency, 'daily');
  assert.equal(res.body.data.status, 'active');
  assert.ok(res.body.data.nextRunAt);

  const stored = await ScheduledOrder.findById(res.body.data.id).lean();
  assert.equal(stored.items[0].quantity, 2);
  // A basket ordered weeks ahead must be priced on the morning it ships.
  assert.equal(stored.totalAmountPaise, undefined, 'a schedule must not carry a total');
});

/**
 * A basket line's `id` is not a product id, and this is the boundary that says so.
 *
 * `packLineId` (src/services/packs.mjs) makes `<catalogId>-x4` for any size above
 * the base pack, and the client must translate that back to `originalId` with the
 * quantity multiplied by `units` before posting. `handleScheduleCart` did not —
 * it sent `item.id` and the raw quantity — so every standing order containing a
 * sized line was refused outright, and because zod validates the array as a unit,
 * that one line blocked the whole basket from being scheduled. The customer saw
 * only "The submitted data is not valid."
 *
 * Asserted here rather than trusted: the refusal is what makes the untranslated
 * shape a loud failure instead of a schedule that quietly delivers a quarter of
 * what was asked for, every run, forever.
 */
test('a pack-variant key is not a product id, and the schedule route refuses it', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const body = scheduleBody(tomato);
  body.items = [{ productId: `${tomato._id.toHexString()}-x4`, quantity: 1 }];

  const res = await api().post('/api/schedules').set(auth(customer.accessToken)).send(body);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');

  // And the translated shape the client now sends is accepted: four packs.
  const translated = scheduleBody(tomato);
  translated.items = [{ productId: tomato._id.toHexString(), quantity: 4 }];

  const ok = await api().post('/api/schedules').set(auth(customer.accessToken)).send(translated);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const stored = await ScheduledOrder.findById(ok.body.data.id).lean();
  assert.equal(stored.items[0].quantity, 4, 'the pack multiplier has to survive into the schedule');
});

test('a weekly schedule with no weekday chosen is refused', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const res = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato, { frequency: 'weekly' }));

  assert.equal(res.status, 400);
});

test('a schedule for a product that does not exist is refused now, not at 6am', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();
  await Product.updateOne({ _id: tomato._id }, { $set: { isActive: false } });

  const res = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PRODUCT_UNAVAILABLE');
});

test('razorpay is not an option, because nobody is there to pay', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const res = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato, { paymentMethod: 'razorpay' }));

  assert.equal(res.status, 400);
});

test('a customer sees only their own schedules', async () => {
  const mine = await authenticatedUser('customer');
  const theirs = await authenticatedUser('customer');
  const tomato = await seedProduct();

  await api().post('/api/schedules').set(auth(mine.accessToken)).send(scheduleBody(tomato));
  await api().post('/api/schedules').set(auth(theirs.accessToken)).send(scheduleBody(tomato));

  const res = await api().get('/api/schedules').set(auth(mine.accessToken));
  assert.equal(res.body.data.length, 1);
});

test('another customer cannot pause or cancel a schedule that is not theirs', async () => {
  const owner = await authenticatedUser('customer');
  const stranger = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(owner.accessToken))
    .send(scheduleBody(tomato));
  const id = created.body.data.id;

  const paused = await api()
    .patch(`/api/schedules/${id}`)
    .set(auth(stranger.accessToken))
    .send({ status: 'paused' });
  assert.equal(paused.status, 404, 'scoped in the filter, so it is not found rather than refused');

  const deleted = await api().delete(`/api/schedules/${id}`).set(auth(stranger.accessToken));
  assert.equal(deleted.status, 404);

  const untouched = await ScheduledOrder.findById(id).lean();
  assert.equal(untouched.status, 'active');
});

/**
 * A schedule paused for a fortnight comes back due immediately if its old
 * `nextRunAt` is restored, and places an order the customer did not expect the
 * moment they resume it.
 */
test('resuming recomputes the next run rather than restoring an overdue one', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));
  const id = created.body.data.id;

  await api().patch(`/api/schedules/${id}`).set(auth(customer.accessToken)).send({ status: 'paused' });
  await ScheduledOrder.updateOne(
    { _id: id },
    { $set: { nextRunAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } }
  );

  const resumed = await api()
    .patch(`/api/schedules/${id}`)
    .set(auth(customer.accessToken))
    .send({ status: 'active' });

  assert.equal(resumed.status, 200);
  assert.ok(new Date(resumed.body.data.nextRunAt) > new Date(), 'must not come back already overdue');
});

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Make a schedule due right now. */
async function makeDue(id) {
  await ScheduledOrder.updateOne({ _id: id }, { $set: { nextRunAt: new Date(Date.now() - 60000) } });
  return ScheduledOrder.findById(id);
}

test('a due schedule places a real order priced from the catalog', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct('Tomato', 4000);

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));

  await makeDue(created.body.data.id);
  const result = await scheduler.runDueSchedules();

  assert.equal(result.placed, 1);

  const orders = await Order.find({ customer: customer.user._id }).lean();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].items[0].unitPricePaise, 4000, 'priced at run time, from the catalog');
  assert.equal(orders[0].subtotalPaise, 8000);
  assert.equal(String(orders[0].schedule), created.body.data.id, 'the order knows what asked for it');
});

/**
 * The property the whole design rests on. Every instance sweeps, so two ticks
 * landing together must not produce two deliveries.
 */
test('two sweepers running at once place exactly one order', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));
  await makeDue(created.body.data.id);

  const [a, b] = await Promise.all([scheduler.runDueSchedules(), scheduler.runDueSchedules()]);

  assert.equal(a.placed + b.placed, 1, 'exactly one of the two wins the claim');
  const orders = await Order.countDocuments({ customer: customer.user._id });
  assert.equal(orders, 1);
});

test('running advances the schedule so the next tick does not fire again', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));
  await makeDue(created.body.data.id);

  await scheduler.runDueSchedules();
  await scheduler.runDueSchedules();

  assert.equal(await Order.countDocuments({ customer: customer.user._id }), 1);

  const after = await ScheduledOrder.findById(created.body.data.id).lean();
  assert.ok(after.nextRunAt > new Date(), 'moved on to its next occurrence');
  assert.equal(after.runCount, 1);
});

test('a paused schedule is never run', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));
  await makeDue(created.body.data.id);
  await ScheduledOrder.updateOne({ _id: created.body.data.id }, { $set: { status: 'paused' } });

  const result = await scheduler.runDueSchedules();

  assert.equal(result.placed, 0);
  assert.equal(await Order.countDocuments({ customer: customer.user._id }), 0);
});

/**
 * The failure a customer most needs told about: a schedule that stops paying is
 * discovered by the vegetables not arriving.
 */
test('a wallet schedule that cannot pay records why, and does not place the order', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato, { paymentMethod: 'wallet' }));
  await makeDue(created.body.data.id);

  const result = await scheduler.runDueSchedules();

  assert.equal(result.placed, 0);
  assert.equal(await Order.countDocuments({ customer: customer.user._id }), 0);

  const after = await ScheduledOrder.findById(created.body.data.id).lean();
  assert.ok(after.lastFailure.at, 'the reason is kept');
  assert.match(after.lastFailure.message, /balance|fund|short/i);

  // And it is reported to the customer rather than only logged.
  const list = await api().get('/api/schedules').set(auth(customer.accessToken));
  assert.ok(list.body.data[0].lastFailure);
});

test('a funded wallet schedule pays from the ledger', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct('Tomato', 4000);

  await wallet.credit({
    userId: customer.user._id,
    amountPaise: 50000,
    reason: 'razorpay_topup',
    idempotencyKey: `test:${uniq()}`,
  });

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato, { paymentMethod: 'wallet' }));
  await makeDue(created.body.data.id);

  const result = await scheduler.runDueSchedules();
  assert.equal(result.placed, 1);

  const order = await Order.findOne({ customer: customer.user._id }).lean();
  assert.equal(order.paymentStatus, 'paid');

  const balance = await wallet.getBalancePaise(customer.user._id);
  assert.equal(balance, 50000 - order.totalAmountPaise, 'charged exactly once, at run-time prices');
});

test('a market schedule is priced from that market sheet, not the catalog', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct('Tomato', 4000);
  const market = await seedMarket();
  await MarketPrice.create({ market: market._id, product: tomato._id, pricePaise: 5500 });

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato, { marketId: market._id.toHexString() }));
  await makeDue(created.body.data.id);

  await scheduler.runDueSchedules();

  const order = await Order.findOne({ customer: customer.user._id }).lean();
  assert.equal(order.items[0].unitPricePaise, 5500, "the market's own price wins");
  assert.equal(String(order.market), market._id.toHexString());
});

/**
 * A server down overnight must not wake up and place yesterday's groceries.
 */
test('a schedule missed by more than the grace window is skipped, not back-filled', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));

  await ScheduledOrder.updateOne(
    { _id: created.body.data.id },
    { $set: { nextRunAt: new Date(Date.now() - 48 * 60 * 60 * 1000) } }
  );

  const result = await scheduler.runDueSchedules();

  assert.equal(result.placed, 0);
  assert.equal(result.missed, 1);
  assert.equal(await Order.countDocuments({ customer: customer.user._id }), 0);

  const after = await ScheduledOrder.findById(created.body.data.id).lean();
  assert.equal(after.lastFailure.code, 'MISSED');
  assert.ok(after.nextRunAt > new Date(), 'moved forward rather than left overdue for ever');
});

test('a cancelled schedule disappears from the list but keeps its history', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));
  await makeDue(created.body.data.id);
  await scheduler.runDueSchedules();

  const deleted = await api()
    .delete(`/api/schedules/${created.body.data.id}`)
    .set(auth(customer.accessToken));
  assert.equal(deleted.status, 204);

  const list = await api().get('/api/schedules').set(auth(customer.accessToken));
  assert.equal(list.body.data.length, 0);

  // The row survives, so the order it placed still has something to point at.
  const row = await ScheduledOrder.findById(created.body.data.id).lean();
  assert.equal(row.status, 'cancelled');
  assert.ok(row.lastOrder);
});

test('a cancelled schedule is never run again', async () => {
  const customer = await authenticatedUser('customer');
  const tomato = await seedProduct();

  const created = await api()
    .post('/api/schedules')
    .set(auth(customer.accessToken))
    .send(scheduleBody(tomato));
  await api().delete(`/api/schedules/${created.body.data.id}`).set(auth(customer.accessToken));
  await ScheduledOrder.updateOne(
    { _id: created.body.data.id },
    { $set: { nextRunAt: new Date(Date.now() - 60000) } }
  );

  const result = await scheduler.runDueSchedules();
  assert.equal(result.placed, 0);
  assert.equal(await Order.countDocuments({ customer: customer.user._id }), 0);
});

test('a shopkeeper cannot create a standing order', async () => {
  const shop = await authenticatedUser('shopkeeper');
  const tomato = await seedProduct();

  const res = await api().post('/api/schedules').set(auth(shop.accessToken)).send(scheduleBody(tomato));
  assert.equal(res.status, 403);
});
