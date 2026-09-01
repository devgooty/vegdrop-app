'use strict';

/**
 * The profile picture: a built-in avatar, an uploaded photo, or neither.
 *
 * Three things are being proved here, and the third is the one that would rot
 * silently. First, that the two ways of picturing an account are genuinely
 * exclusive — picking either really discards the other, rather than leaving a
 * stale row nothing can display. Second, that the upload gate refuses what it
 * says it refuses. Third, that the profile read carries a POINTER and never the
 * bytes: the whole reason UserAvatar is its own collection is that
 * middleware/auth.js re-reads the User document on every authenticated request,
 * and an assertion is the only thing that stops someone "simplifying" the image
 * onto the user record later.
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

const config = require('../config/env');
const User = require('../models/User');
const UserAvatar = require('../models/UserAvatar');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/**
 * The smallest real JPEG that exists — a 1x1 pixel, base64.
 *
 * Real bytes rather than a made-up string, because the route decodes and
 * re-encodes to verify the payload round-trips.
 */
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const jpegUri = `data:image/jpeg;base64,${TINY_JPEG}`;

/** A JPEG data URI whose decoded size is at least `bytes`. */
function oversizedJpeg(bytes) {
  return `data:image/jpeg;base64,${Buffer.alloc(bytes, 0x41).toString('base64')}`;
}

test('an account starts with no picture at all', async () => {
  const { user } = await authenticatedUser('customer');
  const stored = await User.findById(user._id);

  assert.equal(stored.avatar.preset, null);
  assert.equal(stored.avatar.photoUpdatedAt, null);
});

test('a preset is stored on the user and reported by the profile read', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'carrot' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.avatar.preset, 'carrot');
  assert.equal(res.body.data.avatar.photoUpdatedAt, null);
});

test('an uploaded photo is reported as a pointer, never as bytes', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ image: jpegUri });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.avatar.preset, null);
  assert.ok(res.body.data.avatar.photoUpdatedAt);

  /**
   * The load-bearing assertion. If the image ever migrates onto the User
   * document, this is what fails — and it fails here rather than as an
   * unexplained slowdown on every authenticated request in the system.
   */
  assert.ok(
    !JSON.stringify(res.body.data).includes(TINY_JPEG.slice(0, 40)),
    'the profile read must not carry the image bytes'
  );

  const bytes = await api().get(`/api/users/${user._id}/avatar`).set(auth(accessToken));
  assert.equal(bytes.status, 200);
  assert.equal(bytes.body.data.image, jpegUri);
});

test('choosing a preset deletes the photo it replaces', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({ image: jpegUri });
  await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({ preset: 'tomato' });

  // Not merely unreferenced — actually gone, or the collection accumulates a
  // row per replaced photo that nothing will ever read or prune.
  assert.equal(await UserAvatar.countDocuments({ user: user._id }), 0);

  const stored = await User.findById(user._id);
  assert.equal(stored.avatar.preset, 'tomato');
  assert.equal(stored.avatar.photoUpdatedAt, null);
});

test('uploading a photo clears the preset it replaces', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({ preset: 'tomato' });
  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ image: jpegUri });

  assert.equal(res.body.data.avatar.preset, null);
  assert.ok(res.body.data.avatar.photoUpdatedAt);
});

test('a second upload replaces the first rather than adding a row', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({ image: jpegUri });
  await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({ image: jpegUri });

  assert.equal(await UserAvatar.countDocuments({ user: user._id }), 1);
});

test('sending both a preset and an image is refused', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'carrot', image: jpegUri });

  assert.equal(res.status, 400);
});

test('sending neither is refused', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({});
  assert.equal(res.status, 400);
});

test('an SVG is refused, however it is dressed up', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString('base64');
  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ image: `data:image/svg+xml;base64,${svg}` });

  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code, 'UNSUPPORTED_IMAGE');
});

test('a photo over the cap is refused', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ image: oversizedJpeg(config.avatar.maxBytes + 1_000) });

  assert.equal(res.status, 413);
  assert.equal(res.body.error?.code, 'PHOTO_TOO_LARGE');
  assert.equal(await UserAvatar.countDocuments({ user: user._id }), 0);
});

test('removing the picture clears both halves and the stored bytes', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({ image: jpegUri });
  const res = await api().delete(`/api/users/${user._id}/avatar`).set(auth(accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.avatar.preset, null);
  assert.equal(res.body.data.avatar.photoUpdatedAt, null);
  assert.equal(await UserAvatar.countDocuments({ user: user._id }), 0);
});

test('one customer cannot set or read another customer picture', async () => {
  const mine = await authenticatedUser('customer');
  const theirs = await authenticatedUser('customer');

  await api()
    .put(`/api/users/${theirs.user._id}/avatar`)
    .set(auth(theirs.accessToken))
    .send({ image: jpegUri });

  const write = await api()
    .put(`/api/users/${theirs.user._id}/avatar`)
    .set(auth(mine.accessToken))
    .send({ preset: 'carrot' });
  assert.equal(write.status, 404);

  const read = await api()
    .get(`/api/users/${theirs.user._id}/avatar`)
    .set(auth(mine.accessToken));
  assert.equal(read.status, 404);

  const removal = await api()
    .delete(`/api/users/${theirs.user._id}/avatar`)
    .set(auth(mine.accessToken));
  assert.equal(removal.status, 404);

  // The refusals were real, not merely reported.
  const stored = await User.findById(theirs.user._id);
  assert.equal(stored.avatar.preset, null);
  assert.ok(stored.avatar.photoUpdatedAt);
});

test('an anonymous caller cannot read a picture', async () => {
  const { accessToken, user } = await authenticatedUser('customer');
  await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({ image: jpegUri });

  const res = await api().get(`/api/users/${user._id}/avatar`);
  assert.equal(res.status, 401);
});

test('the picture cannot be set through the ordinary profile PATCH', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  /**
   * `.strict()` is what makes this a 400 rather than a silent no-op. The two
   * halves have to be written together to stay exclusive, so PATCH must not
   * become a second door that only ever moves one of them.
   */
  const res = await api()
    .patch(`/api/users/${user._id}`)
    .set(auth(accessToken))
    .send({ avatar: { preset: 'carrot' } });

  assert.equal(res.status, 400);
});
