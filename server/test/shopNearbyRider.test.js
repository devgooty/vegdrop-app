'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, api, auth, authenticatedUser } = require('./helpers');

const Market = require('../models/Market');
const Stall = require('../models/Stall');
const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

// Hyderabad. Roughly 1 km north is +0.009 latitude; 30 km is +0.27.
const HYD = { lat: 17.385, lng: 78.4867 };
const FAR_AWAY = { lat: HYD.lat + 0.27, lng: HYD.lng };

async function seedIndependentShop({ lat = HYD.lat, lng = HYD.lng } = {}) {
  const shop = await authenticatedUser('shopkeeper');
  const res = await api()
    .put('/api/shops/me/location')
    .set(auth(shop.accessToken))
    .send({ lat, lng, name: 'Ravi Vegetables', address: '12 Main Road' });
  assert.equal(res.status, 200, 'shop location should save');
  return shop;
}

async function seedStallShopkeeper({ lat = HYD.lat, lng = HYD.lng } = {}) {
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Rythu Bazaar',
    slug: `mkt-${uniq()}`,
    address: 'Hyderabad',
    location: { type: 'Point', coordinates: [lng, lat] },
    owner: owner.user._id,
  });

  const shop = await authenticatedUser('shopkeeper');
  await Stall.create({
    market: market._id,
    stallNumber: `A-${uniq()}`,
    name: 'Stall A',
    owner: shop.user._id,
    status: 'approved',
    isActive: true,
  });
  return shop;
}

async function seedRider({ lat, lng, online = true, ageSeconds = 0 } = {}) {
  const rider = await authenticatedUser('delivery');
  if (online) {
    const res = await api().patch('/api/rider/duty').set(auth(rider.accessToken)).send({ dutyStatus: 'online' });
    assert.equal(res.status, 200, 'rider should be able to go online');
  }
  if (lat != null && lng != null) {
    if (ageSeconds > 0) {
      await User.updateOne(
        { _id: rider.user._id },
        {
          $set: {
            'rider.lastLocation': { type: 'Point', coordinates: [lng, lat] },
            'rider.lastLocationAt': new Date(Date.now() - ageSeconds * 1000),
          },
        }
      );
    } else {
      const res = await api().post('/api/rider/location').set(auth(rider.accessToken)).send({ lat, lng });
      assert.equal(res.status, 200, 'rider should be able to post a location');
    }
  }
  return rider;
}

const nearbyRider = (token) => api().get('/api/shops/me/nearby-rider').set(auth(token));

test('an independent shop sees the nearest online rider through its own pin', async () => {
  const shop = await seedIndependentShop();
  await seedRider({ lat: HYD.lat + 0.005, lng: HYD.lng });

  const res = await nearbyRider(shop.accessToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.data, 'a nearby online rider should be reported');
  assert.ok(res.body.data.distanceMeters < 5000, 'the rider is well under the 5 km radius');
});

test('a stall shopkeeper sees the nearest rider through their market\'s pin, not their own', async () => {
  const shop = await seedStallShopkeeper();
  await seedRider({ lat: HYD.lat + 0.005, lng: HYD.lng });

  const res = await nearbyRider(shop.accessToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.data, 'the stall has no pin of its own, but the market does');
  assert.ok(res.body.data.distanceMeters < 5000);
});

test('is null when the shopkeeper has no location on file at all', async () => {
  const shop = await authenticatedUser('shopkeeper');
  await seedRider({ lat: HYD.lat, lng: HYD.lng });

  const res = await nearbyRider(shop.accessToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);
});

test('is null when the nearest rider is outside the 5 km radius', async () => {
  const shop = await seedIndependentShop();
  await seedRider(FAR_AWAY);

  const res = await nearbyRider(shop.accessToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null, '30 km away is not "nearby"');
});

test('an offline rider is not counted, however close', async () => {
  const shop = await seedIndependentShop();
  await seedRider({ lat: HYD.lat, lng: HYD.lng, online: false });

  const res = await nearbyRider(shop.accessToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null, 'offline means not actually available');
});

test('a stale fix is not counted, whatever duty status claims', async () => {
  const shop = await seedIndependentShop();
  await seedRider({ lat: HYD.lat, lng: HYD.lng, ageSeconds: 10 * 60 });

  const res = await nearbyRider(shop.accessToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null, 'a ten-minute-old fix must read as gone');
});

test('a customer cannot read this endpoint', async () => {
  const customer = await authenticatedUser('customer');
  const res = await nearbyRider(customer.accessToken);
  assert.equal(res.status, 403);
});
