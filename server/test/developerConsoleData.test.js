'use strict';

/**
 * The Developer Console against a database that is NOT empty.
 *
 * `developer.test.js` walks every endpoint and asserts a 200, which is why a
 * whole cluster of bugs lived here undetected: each of them needed a real row
 * to surface. On an empty database a filter naming a field the schema does not
 * have still returns [], a populate of a non-path is never executed, and a
 * status value outside the enum matches nothing whether or not it is spelled
 * correctly. Every assertion below therefore seeds the row first.
 *
 * What was wrong, and what each test pins:
 *
 *  - `/shopkeepers` filtered `Stall.find({ shopkeeper })`. Stall's user
 *    reference is `owner`. With `strictQuery` on, the unknown path is dropped
 *    rather than rejected, so the filter collapsed to {} and returned every
 *    stall in the database; the mapping then read `.shopkeeper` off one and
 *    threw. The route 500ed as soon as a single Stall document existed.
 *  - `/alerts` populated 'shopkeeper' on Stall, raising StrictPopulateError.
 *  - `/alerts` and `/overview` counted VendorKyc `status: 'pending'`, which is
 *    not a member of the enum (draft | penny_sent | verified | rejected).
 *  - `/alerts` looked for unassigned orders by `status: 'Placed'` (not an
 *    ORDER_STATUSES member) and `deliveryAgent` (not a field on Order).
 *  - `/overview` summed lifetime sales over a status list containing 'Placed'
 *    and omitting 'Pending', so orders not yet picked up were left out.
 */

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
const VendorKyc = require('../models/VendorKyc');
const Order = require('../models/Order');
const Product = require('../models/Product');
const StallEarning = require('../models/StallEarning');
const WalletTransaction = require('../models/WalletTransaction');
const { startOfMarketDay } = require('../utils/marketDay');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `t${(seq += 1)}x${Math.floor(Math.random() * 1e6)}`;

/** `createUser` hands back `{ user }`; every fixture here wants the document. */
const mkUser = async (opts) => (await createUser(opts)).user;

async function seedMarket(owner, name) {
  return Market.create({
    name,
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
    owner: owner._id,
  });
}

async function seedStall({ market, owner, name, stallNumber, status = 'approved' }) {
  return Stall.create({ market: market._id, owner: owner._id, name, stallNumber, status });
}

async function seedKyc(user, status) {
  return VendorKyc.create({
    user: user._id,
    legalName: user.name,
    bankName: 'HDFC Bank',
    ifsc: 'HDFC0001234',
    upiVpa: `vendor${uniq()}@okhdfcbank`,
    ...VendorKyc.buildSecrets({ bankAccount: '123456789012' }),
    status,
  });
}

async function seedOrder(customer, { status, assignedTo = null, totalPaise = 25000 }) {
  return Order.create({
    orderNumber: `VB${uniq().toUpperCase()}`,
    customer: customer._id,
    customerName: customer.name,
    phone: customer.phone,
    address: '12 Test Lane',
    items: [
      {
        // Any ObjectId: nothing in these assertions resolves the product ref.
        product: customer._id,
        name: 'Tomatoes',
        unitPricePaise: totalPaise,
        quantity: 1,
        lineTotalPaise: totalPaise,
      },
    ],
    subtotalPaise: totalPaise,
    totalAmountPaise: totalPaise,
    paymentMethod: 'cod',
    status,
    assignedTo,
  });
}

async function seedProducts(count, stock) {
  return Product.insertMany(
    Array.from({ length: count }, (_, i) => ({
      sku: `SKU-${uniq()}-${i}`,
      categoryId: 2,
      name: `Vegetable ${i}`,
      weight: '1kg',
      pricePaise: 4000 + i,
      stock,
      owner: null,
    }))
  );
}

// ---------------------------------------------------------------------------
// /developer/shopkeepers
// ---------------------------------------------------------------------------

test('shopkeeper directory survives a database that contains stalls', async () => {
  const developer = await authenticatedUser('developer');
  const owner = await mkUser({ role: 'market_owner' });
  const shopkeeper = await mkUser({ role: 'shopkeeper' });
  const market = await seedMarket(owner, 'Mehdipatnam Rythu Bazaar');
  await seedStall({ market, owner: shopkeeper, name: 'Ravi Vegetables', stallNumber: 'A-7' });

  const res = await api().get('/api/developer/shopkeepers').set(auth(developer.accessToken));

  // Before the fix this was a 500: st.shopkeeper was undefined, .toString() threw.
  assert.equal(res.status, 200);
  const row = res.body.data.find((r) => r.id === shopkeeper._id.toString());
  assert.ok(row, 'the shopkeeper should appear in the directory');
  assert.equal(row.stallName, 'Ravi Vegetables');
  assert.equal(row.marketName, 'Mehdipatnam Rythu Bazaar');
  assert.equal(row.stallStatus, 'approved');
});

test('each shopkeeper is matched to their OWN stall, not whichever came first', async () => {
  /**
   * The specific consequence of the dropped filter path. Collapsed to {}, the
   * query returned both stalls and the Map was keyed on an undefined id, so
   * this pairing is the assertion a bare 200 cannot make.
   */
  const developer = await authenticatedUser('developer');
  const owner = await mkUser({ role: 'market_owner' });
  const ravi = await mkUser({ role: 'shopkeeper', name: 'Ravi' });
  const anand = await mkUser({ role: 'shopkeeper', name: 'Anand' });
  const north = await seedMarket(owner, 'North Bazaar');
  const south = await seedMarket(owner, 'South Bazaar');
  await seedStall({ market: north, owner: ravi, name: 'Ravi Vegetables', stallNumber: 'A-1' });
  await seedStall({ market: south, owner: anand, name: 'Anand Greens', stallNumber: 'B-2' });

  const res = await api().get('/api/developer/shopkeepers').set(auth(developer.accessToken));
  assert.equal(res.status, 200);

  const byId = new Map(res.body.data.map((r) => [r.id, r]));
  assert.equal(byId.get(ravi._id.toString()).stallName, 'Ravi Vegetables');
  assert.equal(byId.get(ravi._id.toString()).marketName, 'North Bazaar');
  assert.equal(byId.get(anand._id.toString()).stallName, 'Anand Greens');
  assert.equal(byId.get(anand._id.toString()).marketName, 'South Bazaar');
});

test('a shopkeeper with no stall is reported, not dropped', async () => {
  const developer = await authenticatedUser('developer');
  const shopkeeper = await mkUser({ role: 'shopkeeper' });

  const res = await api().get('/api/developer/shopkeepers').set(auth(developer.accessToken));
  assert.equal(res.status, 200);
  const row = res.body.data.find((r) => r.id === shopkeeper._id.toString());
  assert.ok(row);
  assert.equal(row.stallStatus, 'No Stall');
  assert.equal(row.kycStatus, 'not_submitted');
});

// ---------------------------------------------------------------------------
// /developer/alerts
// ---------------------------------------------------------------------------

test('a pending stall application raises an alert naming the applicant', async () => {
  const developer = await authenticatedUser('developer');
  const owner = await mkUser({ role: 'market_owner' });
  const shopkeeper = await mkUser({ role: 'shopkeeper', name: 'Ramesh Kumar' });
  const market = await seedMarket(owner, 'Mehdipatnam Rythu Bazaar');
  await seedStall({
    market,
    owner: shopkeeper,
    name: 'Ramesh Vegetables',
    stallNumber: 'C-3',
    status: 'pending',
  });

  const res = await api().get('/api/developer/alerts').set(auth(developer.accessToken));

  // Before the fix: StrictPopulateError, because 'shopkeeper' is not a Stall path.
  assert.equal(res.status, 200);
  const alert = res.body.data.alerts.find((a) => a.type === 'stall');
  assert.ok(alert, 'a pending stall should raise a stall alert');
  assert.match(alert.description, /Ramesh Vegetables/);
  assert.match(alert.description, /Mehdipatnam Rythu Bazaar/);
});

test('a KYC record awaiting verification raises an alert', async () => {
  const developer = await authenticatedUser('developer');
  const shopkeeper = await mkUser({ role: 'shopkeeper', name: 'Sita Devi' });
  // 'penny_sent' is the real "awaiting the vendor's confirmation" state. The
  // route used to ask for 'pending', which the enum has never contained.
  await seedKyc(shopkeeper, 'penny_sent');

  const res = await api().get('/api/developer/alerts').set(auth(developer.accessToken));
  assert.equal(res.status, 200);
  const alert = res.body.data.alerts.find((a) => a.type === 'kyc');
  assert.ok(alert, 'a penny_sent KYC record should raise a kyc alert');
  assert.match(alert.description, /Sita Devi/);
});

test('a verified KYC record raises no alert', async () => {
  const developer = await authenticatedUser('developer');
  const shopkeeper = await mkUser({ role: 'shopkeeper' });
  await seedKyc(shopkeeper, 'verified');

  const res = await api().get('/api/developer/alerts').set(auth(developer.accessToken));
  assert.equal(res.status, 200);
  assert.equal(
    res.body.data.alerts.some((a) => a.type === 'kyc'),
    false
  );
});

test('the unassigned-order alert counts only orders with no rider', async () => {
  const developer = await authenticatedUser('developer');
  const customer = await mkUser({ role: 'customer' });
  const rider = await mkUser({ role: 'delivery' });

  await seedOrder(customer, { status: 'Pending' }); // unassigned
  await seedOrder(customer, { status: 'Preparing' }); // unassigned
  await seedOrder(customer, { status: 'Preparing', assignedTo: rider._id }); // has a rider
  await seedOrder(customer, { status: 'Delivered' }); // done

  const res = await api().get('/api/developer/alerts').set(auth(developer.accessToken));
  assert.equal(res.status, 200);
  const alert = res.body.data.alerts.find((a) => a.type === 'orders');
  assert.ok(alert, 'unassigned active orders should raise an alert');

  /**
   * Two, not three and not one. The old query asked for `status: 'Placed'`
   * (never a member of ORDER_STATUSES, so Pending was missed) and for
   * `deliveryAgent: { $exists: false }` - a field Order does not have, so
   * strictQuery dropped the clause and the assigned order was counted too.
   */
  assert.match(alert.title, /^2 Unassigned Active Orders/);
});

test('alert titles report the real count, not the page size', async () => {
  /**
   * Both of these summaries used to `.limit(10)` and then put `.length` in the
   * title, so a triage screen quoted its own page size as the size of the
   * problem: "10 Products Out of Stock" whether there were ten or ten thousand.
   * Twelve of each is the smallest number that tells the two apart.
   */
  const developer = await authenticatedUser('developer');
  const customer = await mkUser({ role: 'customer' });

  await seedProducts(12, 0);
  await seedProducts(2, 40); // in stock — must not be counted
  for (let i = 0; i < 12; i += 1) {
    await seedOrder(customer, { status: 'Pending' });
  }

  const res = await api().get('/api/developer/alerts').set(auth(developer.accessToken));
  assert.equal(res.status, 200);

  const stock = res.body.data.alerts.find((a) => a.type === 'inventory');
  assert.ok(stock, 'depleted stock should raise an inventory alert');
  assert.match(stock.title, /^12 Products Out of Stock/);
  // The names stay a sample; only the number is a count.
  assert.match(stock.description, /Items like .+ are currently depleted/);

  const orders = res.body.data.alerts.find((a) => a.type === 'orders');
  assert.ok(orders);
  assert.match(orders.title, /^12 Unassigned Active Orders/);
});

test('today is the market day, not the server clock', async () => {
  /**
   * The KPIs used `new Date(y, m, d)` — the SERVER's midnight. On the UTC host
   * this runs on, an order placed at 00:30 IST is 19:00 UTC the previous day,
   * so the first five and a half hours of every Indian trading day were filed
   * under yesterday and "Today's Orders" read zero through the market's busiest
   * hour. `utils/marketDay.js` is what answers this; its header describes
   * exactly this bug.
   */
  const developer = await authenticatedUser('developer');
  const customer = await mkUser({ role: 'customer' });

  const dayStart = startOfMarketDay(new Date());
  const justAfterMidnightIst = new Date(dayStart.getTime() + 30 * 60 * 1000);
  const justBeforeMidnightIst = new Date(dayStart.getTime() - 30 * 60 * 1000);

  const today = await seedOrder(customer, { status: 'Pending', totalPaise: 12300 });
  const yesterday = await seedOrder(customer, { status: 'Pending', totalPaise: 45600 });
  // `createdAt` is set by timestamps, so move it afterwards.
  await Order.collection.updateOne(
    { _id: today._id },
    { $set: { createdAt: justAfterMidnightIst } }
  );
  await Order.collection.updateOne(
    { _id: yesterday._id },
    { $set: { createdAt: justBeforeMidnightIst } }
  );

  const res = await api().get('/api/developer/overview').set(auth(developer.accessToken));
  assert.equal(res.status, 200);

  const { kpis } = res.body.data;
  assert.equal(kpis.todayOrders, 1, 'the 00:30 IST order belongs to today');
  assert.equal(kpis.todaySales, 123);
});

test('platform commission comes from the settlement ledger, not a flat 10%', async () => {
  /**
   * It was `Math.round(allTimeSales * 0.1)`. `config.settlement.commissionBps`
   * is the rate actually charged and it defaults to ZERO, so a deployment that
   * never set it saw a dashboard reporting a tenth of every sale as revenue the
   * platform had not taken. `StallEarning.commissionPaise` is what settlement
   * withheld — for market stalls and independent shops alike.
   */
  const developer = await authenticatedUser('developer');
  const customer = await mkUser({ role: 'customer' });
  const owner = await mkUser({ role: 'market_owner' });
  const shopkeeper = await mkUser({ role: 'shopkeeper' });
  const market = await seedMarket(owner, 'Commission Bazaar');
  const stall = await seedStall({ market, owner: shopkeeper, name: 'Ravi Veg', stallNumber: 'A-1' });

  const order = await seedOrder(customer, { status: 'Delivered', totalPaise: 100000 }); // ₹1000
  await StallEarning.create({
    // A StallEarning names exactly one seller: a market stall or a shop.
    stall: stall._id,
    stallNumber: stall.stallNumber,
    market: market._id,
    owner: shopkeeper._id,
    order: order._id,
    orderNumber: order.orderNumber,
    lines: [{ name: 'Tomatoes', quantity: 1, unitPricePaise: 100000, lineTotalPaise: 100000 }],
    grossPaise: 100000,
    commissionPaise: 2500, // ₹25 — deliberately not a tenth of ₹1000
    netPaise: 97500,
    status: 'pending',
    earnedAt: new Date(),
    releaseAt: new Date(Date.now() + 86400000),
  });

  const res = await api().get('/api/developer/overview').set(auth(developer.accessToken));
  assert.equal(res.status, 200);

  const { kpis } = res.body.data;
  assert.equal(kpis.allTimeSales, 1000);
  // Was 100 — a tenth of sales, invented.
  assert.equal(kpis.platformCommission, 25);
  assert.equal(kpis.todayCommission, 25);
});

test('the payments summary counts the whole ledger, not the page it shows', async () => {
  /**
   * `totalTransactions` was `transactions.length` behind a `.limit(100)`, while
   * the credit and debit figures came from an unlimited aggregate — so past a
   * hundred rows the screen read "₹X net flow across 100 recorded transactions"
   * and attributed a lifetime total to one page.
   */
  const developer = await authenticatedUser('developer');
  const customer = await mkUser({ role: 'customer' });

  await WalletTransaction.insertMany(
    Array.from({ length: 105 }, (_, i) => ({
      user: customer._id,
      type: 'credit',
      amountPaise: 100,
      balanceAfterPaise: 100 * (i + 1),
      seq: i + 1,
      reason: 'promotional_credit',
      idempotencyKey: `test:${uniq()}:${i}`,
    }))
  );

  const res = await api().get('/api/developer/payments').set(auth(developer.accessToken));
  assert.equal(res.status, 200);

  const { summary, transactions } = res.body.data;
  assert.equal(transactions.length, 100, 'the list itself stays a page');
  assert.equal(summary.shown, 100);
  // Was 100.
  assert.equal(summary.totalTransactions, 105);
  assert.equal(summary.totalCredits, 105);
});

test('the state dump reports prices and totals rather than undefined', async () => {
  /**
   * `/dump` read `p.price`, `p.category` and `o.total`. `price` and
   * `totalAmount` are virtuals and `.lean()` does not run them; `category` has
   * never been a field at all. So the one endpoint whose whole job is to show
   * what is in the database showed `undefined` for every price and every total.
   */
  const developer = await authenticatedUser('developer');
  const customer = await mkUser({ role: 'customer' });
  await seedProducts(1, 7);
  await seedOrder(customer, { status: 'Delivered', totalPaise: 25000 });

  const res = await api().get('/api/developer/dump').set(auth(developer.accessToken));
  assert.equal(res.status, 200);

  const { snapshot, sampled } = res.body.data;

  const product = snapshot.products[0];
  assert.equal(typeof product.pricePaise, 'number');
  assert.equal(product.price, product.pricePaise / 100);
  assert.equal(product.categoryId, 2);
  assert.ok(!('category' in product), 'there is no such field to report');

  const order = snapshot.orders[0];
  assert.equal(order.totalAmountPaise, 25000);
  assert.equal(order.total, 250);

  // Queried, counted and then dropped before.
  assert.ok(Array.isArray(snapshot.walletTransactions));
  // Renamed, because every query here is capped: these were never totals.
  assert.equal(sampled.products, 1);
  assert.ok(!('counts' in res.body.data));
});

// ---------------------------------------------------------------------------
// /developer/overview
// ---------------------------------------------------------------------------

test('overview counts KYC awaiting verification and excludes only cancelled sales', async () => {
  const developer = await authenticatedUser('developer');
  const customer = await mkUser({ role: 'customer' });
  const draftVendor = await mkUser({ role: 'shopkeeper' });
  const sentVendor = await mkUser({ role: 'shopkeeper' });
  await seedKyc(draftVendor, 'draft');
  await seedKyc(sentVendor, 'penny_sent');

  await seedOrder(customer, { status: 'Pending', totalPaise: 10000 }); // 100
  await seedOrder(customer, { status: 'Delivered', totalPaise: 25000 }); // 250
  await seedOrder(customer, { status: 'Cancelled', totalPaise: 99000 }); // excluded

  const res = await api().get('/api/developer/overview').set(auth(developer.accessToken));
  assert.equal(res.status, 200);

  const { kpis } = res.body.data;
  // Was 0: 'pending' is not a VendorKyc status.
  assert.equal(kpis.pendingKycs, 2);
  // Was 250: the old $in listed 'Placed' and omitted 'Pending', dropping the
  // order that had been placed but not yet picked up.
  assert.equal(kpis.allTimeSales, 350);
});
