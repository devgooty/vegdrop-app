'use strict';

/**
 * Cloudinary-backed media uploads.
 *
 * Shopkeepers may upload listing photos; customers may not. Delivery proof is
 * covered separately once an order is out for delivery.
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
} = require('./helpers');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const jpegUri = () => `data:image/jpeg;base64,${TINY_JPEG}`;

test('a verified shopkeeper can upload a product image URL', async () => {
  const shop = await authenticatedUser('shopkeeper');
  await verifyVendor(shop.user);

  const res = await api()
    .post('/api/media/product-image')
    .set(auth(shop.accessToken))
    .send({ image: jpegUri() });

  assert.equal(res.status, 201);
  assert.match(res.body.data.url, /^https:\/\//);
  assert.ok(res.body.data.bytes > 0);
});

test('a customer cannot upload product images', async () => {
  const customer = await authenticatedUser('customer');

  const res = await api()
    .post('/api/media/product-image')
    .set(auth(customer.accessToken))
    .send({ image: jpegUri() });

  assert.equal(res.status, 403);
});

test('a delivery agent cannot use the shopkeeper product-image route', async () => {
  const rider = await authenticatedUser('delivery');

  const res = await api()
    .post('/api/media/product-image')
    .set(auth(rider.accessToken))
    .send({ image: jpegUri() });

  assert.equal(res.status, 403);
});
