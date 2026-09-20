'use strict';

/**
 * Settlement paying out from the share policy, not a flat commission.
 *
 * `services/settlement.js` used to withhold a single `commissionBps` from a
 * seller's gross and stop there. Now the whole gross is split into five
 * buckets by `services/sharePolicy.js` — platform, shopkeeper, delivery,
 * market owner, customer incentive — and each non-shopkeeper bucket is
 * written to its own ledger: `PlatformEarning` for the platform's cut,
 * `SharePayout` for the rider's and the market owner's (hold-then-release,
 * exactly like a `StallEarning`), and `OrderIncentive` as an accounting row
 * for the customer's cashback pool.
 *
 * These tests cover the split arithmetic landing in the right collections,
 * not the hold/release mechanics themselves — `settlement.test.js` and
 * `shopSettlement.test.js` already prove those generically and keep working
 * unchanged because the default policy (commissionBps 0, everything else 0)
 * reduces to the old shape.
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
  verifyVendor,
  stallPickupCode,
  shopPickupCode,
  deliveryCode,
} = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const MarketPrice = require('../models/MarketPrice');
const Stall = require('../models/Stall');
const StallEarning = require('../models/StallEarning');
const PlatformEarning = require('../models/PlatformEarning');
const SharePayout = require('../models/SharePayout');
const OrderIncentive = require('../models/OrderIncentive');
const PlatformSharePolicy = require('../models/PlatformSharePolicy');
const User = require('../models/User');
const sourcing = require('../services/sourcing');
const settlement = require('../services/settlement');
const sharePolicy = require('../services/sharePolicy');
const wallet = require('../services/wallet');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/** Set every bucket explicitly, exactly as an admin PUT would. */
async function setGlobalPolicy(bps) {
  await sharePolicy.ensureGlobalPolicy();
  await PlatformSharePolicy.updateOne({}, { $set: bps });
}

// ---------------------------------------------------------------------------
// Market order fixtures — mirrors settlement.test.js's completeDelivery, but
// split so a policy override can be applied between packing and delivery.
// ---------------------------------------------------------------------------

async function seedMarketProduct(pricePaise = 4000) {
  return Product.create({ sku: `SKU-${uniq()}`, categoryId: 1, name: 'Tomato', pricePaise, stock: 500 });
}

async function seedMarket(owner = null) {
  return Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
    owner: owner ? owner.user._id : null,
  });
}

async function seedStallWithOwner(market, stallNumber = 'A-1') {
  const session = await authenticatedUser('shopkeeper');
  const stall = await Stall.create({
    market: market._id,
    stallNumber,
    name: `Stall ${stallNumber}`,
    owner: session.user._id,
    status: 'approved',
  });
  return { ...session, stall };
}

async function seedRider(market) {
  const session = await authenticatedUser('delivery');
  await User.updateOne(
    { _id: session.user._id },
    {
      $set: {
        'rider.dutyStatus': 'online',
        'rider.lastLocation': { type: 'Point', coordinates: market.location.coordinates },
        'rider.lastLocationAt': new Date(),
      },
    }
  );
  return session;
}

/** Place, claim, source, accept and pack — stops one step short of delivery. */
async function setupMarketOrderReadyToDeliver({ unitPricePaise = 4000, quantity = 2, marketOwner = null } = {}) {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket(marketOwner);
  const product = await seedMarketProduct(unitPricePaise);
  await MarketPrice.create({ market: market._id, product: product._id, pricePaise: unitPricePaise });

  const shop = await seedStallWithOwner(market);
  const rider = await seedRider(market);

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity }],
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });
  const orderId = created.body.data.id;
  const lines = created.body.data.items;

  await api()
    .post(`/api/stalls/orders/${orderId}/claim`)
    .set(auth(shop.accessToken))
    .send({ lineIds: [lines[0].lineId] });
  await sourcing.settlePending();

  await api().post(`/api/rider/orders/${orderId}/accept`).set(auth(rider.accessToken));
  await api().post(`/api/stalls/orders/${orderId}/pack`).set(auth(shop.accessToken)).send({});
  await api()
    .post(`/api/rider/orders/${orderId}/collect`)
    .set(auth(rider.accessToken))
    .send({ stallId: shop.stall._id.toHexString(), code: await stallPickupCode(orderId, shop.accessToken) })
    .expect(200);

  return { orderId, customer, market, shop, rider };
}

async function deliverMarketOrder({ orderId, customer, rider }) {
  await api()
    .post(`/api/rider/orders/${orderId}/deliver`)
    .set(auth(rider.accessToken))
    .send({ code: await deliveryCode(orderId, customer.accessToken) })
    .expect(200);
}

async function completeMarketDelivery(opts) {
  const ctx = await setupMarketOrderReadyToDeliver(opts);
  await deliverMarketOrder(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// Independent shop fixture — mirrors shopSettlement.test.js's buyAndDeliver.
// ---------------------------------------------------------------------------

async function seedShop({ name = 'Ravi Vegetables' } = {}) {
  const shop = await authenticatedUser('shopkeeper');
  await verifyVendor(shop.user);
  await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ lat: 17.385, lng: 78.4867, name, address: '12 Main Road' });
  return shop;
}

async function buyAndDeliverShop({ pricePaise = 10000, quantity = 1 } = {}) {
  const shop = await seedShop();
  const product = await Product.create({
    sku: `SKU-${uniq()}`,
    categoryId: 1,
    name: 'Tomato',
    pricePaise,
    stock: 500,
    owner: shop.user._id,
  });
  const customer = await authenticatedUser('customer');
  const rider = await authenticatedUser('delivery');

  await wallet.credit({
    userId: customer.user._id,
    amountPaise: 500000,
    reason: 'promotional_credit',
    idempotencyKey: `seed:${uniq()}`,
  });

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: [{ productId: product._id.toHexString(), quantity }],
      address: '12 Test Lane',
      paymentMethod: 'wallet',
      shopId: shop.user._id.toHexString(),
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const orderId = created.body.data.id;

  await api()
    .patch(`/api/orders/${orderId}/status`)
    .set(auth(shop.accessToken))
    .send({ status: 'Preparing' });
  await api().post(`/api/orders/${orderId}/claim`).set(auth(rider.accessToken)).expect(200);
  await api()
    .post(`/api/orders/${orderId}/verify-pickup`)
    .set(auth(rider.accessToken))
    .send({ code: await shopPickupCode(orderId, shop.accessToken) })
    .expect(200);
  await api()
    .post(`/api/orders/${orderId}/verify-delivery`)
    .set(auth(rider.accessToken))
    .send({ code: await deliveryCode(orderId, customer.accessToken) })
    .expect(200);

  return { shop, customer, rider, orderId, pricePaise, quantity };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('market delivery splits per global policy', async () => {
  await setGlobalPolicy({
    platformBps: 1000,
    shopkeeperBps: 7000,
    deliveryBps: 1000,
    marketOwnerBps: 500,
    customerIncentiveBps: 500,
  });

  const marketOwner = await authenticatedUser('market_owner');
  const { orderId, market, shop, rider } = await completeMarketDelivery({
    unitPricePaise: 4000,
    quantity: 2,
    marketOwner,
  });

  const gross = 8000; // 2 × ₹40

  const earning = await StallEarning.findOne({ order: orderId });
  assert.ok(earning, 'the seller is still paid');
  assert.equal(earning.grossPaise, gross);
  assert.equal(earning.netPaise, 5600, '70% of gross to the shopkeeper');
  assert.equal(earning.commissionPaise, gross - earning.netPaise, 'withheld = everything not net');

  const platformEarning = await PlatformEarning.findOne({ order: orderId });
  assert.ok(platformEarning, 'the platform bucket is recorded');
  assert.equal(platformEarning.amountPaise, 800, '10% of gross');
  assert.equal(String(platformEarning.market), String(market._id));

  const payouts = await SharePayout.find({ order: orderId }).sort({ bucket: 1 }).lean();
  assert.equal(payouts.length, 2, 'one payout for the rider, one for the market owner');

  const deliveryPayout = payouts.find((p) => p.bucket === 'delivery');
  const marketOwnerPayout = payouts.find((p) => p.bucket === 'marketOwner');
  assert.ok(deliveryPayout);
  assert.ok(marketOwnerPayout);
  assert.equal(deliveryPayout.amountPaise, 800, '10% of gross to the rider');
  assert.equal(String(deliveryPayout.recipient), String(rider.user._id));
  assert.equal(deliveryPayout.status, 'pending');
  assert.equal(marketOwnerPayout.amountPaise, 400, '5% of gross to the market owner');
  assert.equal(String(marketOwnerPayout.recipient), String(marketOwner.user._id));
  assert.equal(marketOwnerPayout.status, 'pending');

  const incentive = await OrderIncentive.findOne({ order: orderId });
  assert.ok(incentive, 'the customer incentive is earmarked even though nothing is paid yet');
  assert.equal(incentive.amountPaise, 400, '5% of gross');
  assert.equal(incentive.promosEnabled, true, 'the global default');

  // Nothing here is money in anyone's wallet yet — settlement only records the
  // obligation and starts the hold, same as the flat-commission path did.
  assert.equal(await wallet.getBalancePaise(shop.user._id), 0);
  assert.equal(await wallet.getBalancePaise(rider.user._id), 0);
  assert.equal(await wallet.getBalancePaise(marketOwner.user._id), 0);

  // Re-running settlement on the same order must not duplicate anything: every
  // bucket has its own unique index guarding this.
  await settlement.recordDelivery(orderId);
  assert.equal(await StallEarning.countDocuments({ order: orderId }), 1);
  assert.equal(await PlatformEarning.countDocuments({ order: orderId }), 1);
  assert.equal(await SharePayout.countDocuments({ order: orderId }), 2);
  assert.equal(await OrderIncentive.countDocuments({ order: orderId }), 1);
});

test('market with promosEnabled false still splits money; incentive row records flag', async () => {
  await setGlobalPolicy({
    platformBps: 1000,
    shopkeeperBps: 7000,
    deliveryBps: 1000,
    marketOwnerBps: 500,
    customerIncentiveBps: 500,
  });
  const developer = await authenticatedUser('developer');
  const marketOwner = await authenticatedUser('market_owner');

  const ctx = await setupMarketOrderReadyToDeliver({
    unitPricePaise: 4000,
    quantity: 2,
    marketOwner,
  });

  const put = await api()
    .put(`/api/admin/markets/${ctx.market._id}/share-policy`)
    .set(auth(developer.accessToken))
    .send({ promosEnabled: false });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  await deliverMarketOrder(ctx);

  const incentive = await OrderIncentive.findOne({ order: ctx.orderId });
  assert.ok(incentive, 'the row is written regardless of the flag');
  assert.equal(incentive.promosEnabled, false, 'it records what was actually in force, not the global default');
  assert.equal(incentive.amountPaise, 400, 'the pool still accrues — the flag only gates paying it out later');

  // Money still moves for everyone else.
  const earning = await StallEarning.findOne({ order: ctx.orderId });
  assert.ok(earning);
  assert.equal(earning.netPaise, 5600);
  assert.ok(await PlatformEarning.findOne({ order: ctx.orderId }));
  assert.equal(await SharePayout.countDocuments({ order: ctx.orderId }), 2);
});

test('shop order forces marketOwner paise into platform', async () => {
  await setGlobalPolicy({
    platformBps: 1000,
    shopkeeperBps: 7000,
    deliveryBps: 1000,
    marketOwnerBps: 500,
    customerIncentiveBps: 500,
  });

  const { shop, rider, orderId } = await buyAndDeliverShop({ pricePaise: 10000, quantity: 1 });
  const gross = 10000;

  const earning = await StallEarning.findOne({ order: orderId });
  assert.ok(earning);
  assert.equal(String(earning.shop), shop.user._id.toHexString());
  assert.equal(earning.stall, null, 'a shop sale has no stall');
  assert.equal(earning.netPaise, 7000, 'the shopkeeper share is unaffected by forceNoMarketOwner');

  const platformEarning = await PlatformEarning.findOne({ order: orderId });
  assert.ok(platformEarning);
  assert.equal(
    platformEarning.amountPaise,
    1500,
    'platform absorbs the folded-in marketOwner share: 10% + 5% of gross'
  );
  assert.equal(platformEarning.market, null);

  const marketOwnerPayout = await SharePayout.findOne({ order: orderId, bucket: 'marketOwner' });
  assert.equal(marketOwnerPayout, null, 'a shop order has no market owner to pay');

  const deliveryPayout = await SharePayout.findOne({ order: orderId, bucket: 'delivery' });
  assert.ok(deliveryPayout, 'the rider is still paid their own share');
  assert.equal(deliveryPayout.amountPaise, 1000);
  assert.equal(String(deliveryPayout.recipient), String(rider.user._id));

  const incentive = await OrderIncentive.findOne({ order: orderId });
  assert.ok(incentive);
  assert.equal(incentive.amountPaise, 500);

  assert.equal(gross, earning.netPaise + earning.commissionPaise, 'sanity: nothing lost');
});

test('a delivery with no assigned rider skips the delivery payout without failing settlement', async () => {
  await setGlobalPolicy({
    platformBps: 8000,
    shopkeeperBps: 1000,
    deliveryBps: 1000,
    marketOwnerBps: 0,
    customerIncentiveBps: 0,
  });

  const { shop, orderId } = await buyAndDeliverShop({ pricePaise: 10000, quantity: 1 });

  // The rider carried this one, so a payout already exists — clear it and the
  // assignment to simulate an order that reached "Delivered" with nobody on
  // record (the developer override path in routes/orders.js, for instance).
  await Order.updateOne({ _id: orderId }, { $set: { assignedTo: null, 'fulfillment.settledAt': null } });
  await SharePayout.deleteMany({ order: orderId });
  await StallEarning.deleteMany({ order: orderId });
  await PlatformEarning.deleteMany({ order: orderId });
  await OrderIncentive.deleteMany({ order: orderId });

  const result = await settlement.recordDelivery(orderId);
  assert.equal(result.recorded, 1, 'the seller is still paid regardless of the rider');

  assert.equal(await SharePayout.countDocuments({ order: orderId, bucket: 'delivery' }), 0);
  const earning = await StallEarning.findOne({ order: orderId });
  assert.ok(earning);
  assert.equal(String(earning.shop), shop.user._id.toHexString());
});
