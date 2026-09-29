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
const MarketSharePolicy = require('../models/MarketSharePolicy');
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
  await PlatformSharePolicy.updateOne(
    { scope: sharePolicy.GLOBAL_PLATFORM_POLICY_SCOPE },
    { $set: bps }
  );
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

/**
 * Two stalls, uneven grosses (₹90 and ₹40), ready for `allocateShopkeeperAcrossStalls`
 * to actually have something to allocate proportionally rather than trivially.
 */
async function setupTwoStallOrderReadyToDeliver({ marketOwner = null } = {}) {
  const customer = await authenticatedUser('customer');
  const market = await seedMarket(marketOwner);
  const rider = await seedRider(market);

  const stallSpecs = [
    { stallNumber: 'A-1', pricePaise: 3000, quantity: 3 }, // gross 9000
    { stallNumber: 'A-2', pricePaise: 4000, quantity: 1 }, // gross 4000
  ];

  const products = [];
  const stalls = [];
  for (const spec of stallSpecs) {
    const product = await seedMarketProduct(spec.pricePaise);
    await MarketPrice.create({ market: market._id, product: product._id, pricePaise: spec.pricePaise });
    products.push(product);
    stalls.push(await seedStallWithOwner(market, spec.stallNumber));
  }

  const created = await api()
    .post('/api/orders')
    .set(auth(customer.accessToken))
    .send({
      items: stallSpecs.map((spec, i) => ({ productId: products[i]._id.toHexString(), quantity: spec.quantity })),
      address: '12 Test Lane',
      paymentMethod: 'cod',
      marketId: market._id.toHexString(),
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const orderId = created.body.data.id;
  const lines = created.body.data.items;

  for (let i = 0; i < stalls.length; i += 1) {
    await api()
      .post(`/api/stalls/orders/${orderId}/claim`)
      .set(auth(stalls[i].accessToken))
      .send({ lineIds: [lines[i].lineId] })
      .expect(200);
  }
  await sourcing.settlePending();

  await api().post(`/api/rider/orders/${orderId}/accept`).set(auth(rider.accessToken)).expect(200);
  for (const stall of stalls) {
    await api().post(`/api/stalls/orders/${orderId}/pack`).set(auth(stall.accessToken)).send({}).expect(200);
  }
  for (const stall of stalls) {
    await api()
      .post(`/api/rider/orders/${orderId}/collect`)
      .set(auth(rider.accessToken))
      .send({ stallId: stall.stall._id.toHexString(), code: await stallPickupCode(orderId, stall.accessToken) })
      .expect(200);
  }

  return { orderId, customer, market, stalls, rider };
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

test('market analytics reports the platform bucket as commission, not everything withheld from stalls', async () => {
  // deliveryBps and marketOwnerBps both above zero — the exact condition under
  // which StallEarning.commissionPaise (withheld = platform + delivery +
  // marketOwner + customerIncentive) diverges from PlatformEarning.amountPaise
  // (the platform's own cut alone).
  await setGlobalPolicy({
    platformBps: 1000,
    shopkeeperBps: 7000,
    deliveryBps: 1000,
    marketOwnerBps: 500,
    customerIncentiveBps: 500,
  });

  const marketOwner = await authenticatedUser('market_owner');
  const { market } = await completeMarketDelivery({
    unitPricePaise: 4000,
    quantity: 2,
    marketOwner,
  });

  const res = await api()
    .get(`/api/markets/${market._id}/analytics`)
    .set(auth(marketOwner.accessToken));

  assert.equal(res.status, 200, JSON.stringify(res.body));

  const platformEarning = await PlatformEarning.findOne({ market: market._id });
  assert.ok(platformEarning, 'sanity: the platform bucket was actually recorded');

  // gross 8000; withheld-from-stall (StallEarning.commissionPaise) is 2400
  // (everything but the 70% shopkeeper share); the platform's own cut is 800
  // (10%). The endpoint must report the latter.
  assert.equal(
    res.body.data.sales.commissionPaise,
    platformEarning.amountPaise,
    "reports the platform's own bucket"
  );
  assert.equal(res.body.data.sales.commissionPaise, 800, '10% of gross, not 30% withheld-from-stall');
  assert.notEqual(
    res.body.data.sales.commissionPaise,
    res.body.data.sales.byStall.reduce((sum, row) => sum + row.commissionPaise, 0),
    'must not equal the sum of everything withheld from stalls — that bundles in the rider and market owner shares'
  );
});

test('a stall that lost its owner is not marked settled', async () => {
  const ctx = await setupMarketOrderReadyToDeliver({ unitPricePaise: 4000, quantity: 2 });
  await Stall.collection.updateOne({ _id: ctx.shop.stall._id }, { $unset: { owner: 1 } });

  await deliverMarketOrder(ctx);

  const result = await settlement.recordDelivery(ctx.orderId);
  assert.equal(result.reason, 'STALL_OWNER_MISSING');
  assert.equal(await StallEarning.countDocuments({ order: ctx.orderId }), 0);
  assert.equal(
    await Order.findById(ctx.orderId).then((o) => o.fulfillment.settledAt),
    null,
    'left unsettled so a later backfill can pay the stall once it has an owner'
  );
});

test('a share-policy edit between a partial settlement and its retry is refused rather than mixed', async () => {
  await setGlobalPolicy({
    platformBps: 1000,
    shopkeeperBps: 7000,
    deliveryBps: 1000,
    marketOwnerBps: 500,
    customerIncentiveBps: 500,
  });

  const marketOwner = await authenticatedUser('market_owner');
  const { orderId } = await completeMarketDelivery({
    unitPricePaise: 4000,
    quantity: 2,
    marketOwner,
  });

  // Simulate a crash after the shopkeeper and platform buckets were written but
  // before the rider/market-owner payouts and the incentive row were reached.
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.settledAt': null } });
  await SharePayout.deleteMany({ order: orderId });
  await OrderIncentive.deleteMany({ order: orderId });

  const beforeEarning = await StallEarning.findOne({ order: orderId }).lean();
  const beforePlatform = await PlatformEarning.findOne({ order: orderId }).lean();

  // An admin edits the policy before the retry runs.
  await setGlobalPolicy({
    platformBps: 2000,
    shopkeeperBps: 6000,
    deliveryBps: 1000,
    marketOwnerBps: 500,
    customerIncentiveBps: 500,
  });

  const result = await settlement.recordDelivery(orderId);
  assert.equal(result.reason, 'POLICY_MISMATCH', 'the mismatch against already-recorded buckets is detected');
  assert.equal(result.recorded, 0, 'nothing new is written under the changed policy');

  // Nothing already committed was touched, and nothing new was created under
  // the new (inconsistent) split.
  const afterEarning = await StallEarning.findOne({ order: orderId }).lean();
  assert.equal(afterEarning.netPaise, beforeEarning.netPaise, 'the original shopkeeper share is untouched');
  const afterPlatform = await PlatformEarning.findOne({ order: orderId }).lean();
  assert.equal(afterPlatform.amountPaise, beforePlatform.amountPaise, 'the original platform bucket is untouched');
  assert.equal(await SharePayout.countDocuments({ order: orderId }), 0, 'no payout written under the new split');
  assert.equal(await OrderIncentive.countDocuments({ order: orderId }), 0, 'no incentive row written under the new split');
  assert.equal(await Order.findById(orderId).then((o) => o.fulfillment.settledAt), null, 'left unsettled for manual reconciliation');
});

/**
 * The drift refusal: a stored market override merged against a LATER global can
 * be invalid — a partial override's rebalanced shopkeeper share goes negative.
 * The admin API refuses edits that would create this state, but settlement
 * cannot trust that (out-of-band edits, older data), so it must refuse to
 * write ANY bucket from an invalid split rather than committing more paise
 * than the order grossed and crash-looping on the incentive row's `min: 0`.
 */
test('settlement refuses an invalid effective policy outright, and settles once it is fixed', async () => {
  await setGlobalPolicy({
    platformBps: 1000,
    shopkeeperBps: 9000,
    deliveryBps: 0,
    marketOwnerBps: 0,
    customerIncentiveBps: 0,
  });

  const ctx = await setupMarketOrderReadyToDeliver({ unitPricePaise: 4000, quantity: 2 });

  // A partial override, valid under the current global: shopkeeper rebalances
  // to 10000 - (1000 + 2000) = 7000.
  await MarketSharePolicy.create({ market: ctx.market._id, deliveryBps: 2000 });

  // The drift, written through the model directly — the admin route now refuses
  // exactly this. Merged for the market: platform 9000 + delivery 2000 leaves
  // shopkeeper at -1000.
  await setGlobalPolicy({ platformBps: 9000, shopkeeperBps: 1000 });

  await deliverMarketOrder(ctx);

  // The refusal is total: not one bucket is written from the invalid split.
  assert.equal(await StallEarning.countDocuments({ order: ctx.orderId }), 0);
  assert.equal(await PlatformEarning.countDocuments({ order: ctx.orderId }), 0);
  assert.equal(await SharePayout.countDocuments({ order: ctx.orderId }), 0);
  assert.equal(await OrderIncentive.countDocuments({ order: ctx.orderId }), 0);

  const result = await settlement.recordDelivery(ctx.orderId);
  assert.equal(result.reason, 'POLICY_INVALID');
  assert.equal(
    await Order.findById(ctx.orderId).then((o) => o.fulfillment.settledAt),
    null,
    'left unsettled for the backfill sweep'
  );

  // Fixing the policy lets the very same order settle cleanly on the next sweep.
  await setGlobalPolicy({ platformBps: 1000, shopkeeperBps: 9000 });
  const retried = await settlement.recordDelivery(ctx.orderId);
  assert.equal(retried.recorded, 1);

  const earning = await StallEarning.findOne({ order: ctx.orderId }).lean();
  // 8000 gross, platform 10%, delivery 20% (override), shopkeeper 70%.
  assert.equal(earning.netPaise, 5600);
  const platform = await PlatformEarning.findOne({ order: ctx.orderId }).lean();
  assert.equal(platform.amountPaise, 800);
  const deliveryPayout = await SharePayout.findOne({ order: ctx.orderId, bucket: 'delivery' }).lean();
  assert.equal(deliveryPayout.amountPaise, 1600);
});

test('multi-stall market order allocates the shopkeeper bucket proportionally, remainder to the last stall', async () => {
  await setGlobalPolicy({
    platformBps: 1000,
    shopkeeperBps: 7000,
    deliveryBps: 1500,
    marketOwnerBps: 0,
    customerIncentiveBps: 500,
  });

  const { orderId, customer, stalls, rider } = await setupTwoStallOrderReadyToDeliver();
  await deliverMarketOrder({ orderId, customer, rider });

  const gross = 13000; // 9000 + 4000

  const earnings = await StallEarning.find({ order: orderId }).sort({ stallNumber: 1 }).lean();
  assert.equal(earnings.length, 2);

  const stallA = earnings.find((e) => e.stallNumber === 'A-1');
  const stallB = earnings.find((e) => e.stallNumber === 'A-2');
  assert.ok(stallA && stallB);

  // shopkeeperPaise = floor(13000 * 0.7) = 9100, split 9000:4000 → 6300:2800
  // (remainder lands on the last stall, per allocateShopkeeperAcrossStalls).
  assert.equal(stallA.grossPaise, 9000);
  assert.equal(stallA.netPaise, 6300);
  assert.equal(stallA.commissionPaise, stallA.grossPaise - stallA.netPaise, 'commissionPaise = gross - net');

  assert.equal(stallB.grossPaise, 4000);
  assert.equal(stallB.netPaise, 2800);
  assert.equal(stallB.commissionPaise, stallB.grossPaise - stallB.netPaise, 'commissionPaise = gross - net');

  const platformEarning = await PlatformEarning.findOne({ order: orderId });
  assert.equal(platformEarning.amountPaise, 1300, '10% of 13000');

  const deliveryPayout = await SharePayout.findOne({ order: orderId, bucket: 'delivery' });
  assert.equal(deliveryPayout.amountPaise, 1950, '15% of 13000');
  assert.equal(String(deliveryPayout.recipient), String(rider.user._id));

  const marketOwnerPayout = await SharePayout.findOne({ order: orderId, bucket: 'marketOwner' });
  assert.equal(marketOwnerPayout, null, 'no market owner on this fixture');

  const incentive = await OrderIncentive.findOne({ order: orderId });
  assert.equal(incentive.amountPaise, 650, 'remainder bucket: 13000 - 1300 - 9100 - 1950 - 0');

  const totalNet = stallA.netPaise + stallB.netPaise;
  assert.equal(
    totalNet + platformEarning.amountPaise + deliveryPayout.amountPaise + incentive.amountPaise,
    gross,
    'sanity: every bucket sums back to gross'
  );
});
