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
