'use strict';

/**
 * The profile picture: a built-in avatar, or nothing.
 *
 * UPLOADS WERE REMOVED, AND HALF OF WHAT THIS FILE PROVES IS THAT THEY STAYED
 * REMOVED. Deleting the tab and the handler is the easy part; what rots is the
 * shape of the request. `PUT /:id/avatar` is `.strict()`, so an `image` field is
 * refused rather than ignored — and "ignored" is the failure that would let a
 * client go on believing it had uploaded something. There is likewise no
 * endpoint left that serves photo bytes, which is asserted rather than assumed
 * because a route quietly surviving its feature is exactly the sort of thing
 * nobody notices until it is holding data.
 *
 * The rest is the ordinary contract: a preset is stored and reported, a face
 * carries its tone and hair, and an avatar with nothing to edit clears what the
 * last one wore.
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

const User = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/**
 * The smallest real JPEG that exists — a 1x1 pixel, base64. Kept although
 * nothing accepts it any more: the point of the tests below is that a real,
 * well-formed image is refused on its shape, not because the bytes were junk.
 */
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const jpegUri = `data:image/jpeg;base64,${TINY_JPEG}`;

test('an account starts with no picture at all', async () => {
  const { user } = await authenticatedUser('customer');
  const stored = await User.findById(user._id);

  assert.equal(stored.avatar.preset, null);
  assert.equal(stored.avatar.skinTone, null);
  assert.equal(stored.avatar.hair, null);
});

test('a preset is stored on the user and reported by the profile read', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'carrot' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.avatar.preset, 'carrot');
});

/**
 * The whole picture travels on the profile read now. An uploaded photo needed a
 * second request keyed on a timestamp; three slugs do not, and the client draws
 * the avatar the moment the user record lands.
 */
test('the profile read carries the whole picture and no photo pointer', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'female', skinTone: 'deep', hair: 'auburn' });

  const res = await api().get(`/api/users/${user._id}`).set(auth(accessToken));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.avatar, {
    preset: 'female',
    skinTone: 'deep',
    hair: 'auburn',
  });
});

test('a person avatar carries its skin tone and hair colour', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'female', skinTone: 'deep', hair: 'auburn' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.avatar.preset, 'female');
  assert.equal(res.body.data.avatar.skinTone, 'deep');
  assert.equal(res.body.data.avatar.hair, 'auburn');
});

/**
 * The clearing half, which is the one that can rot quietly: a vegetable that
 * inherited a skin tone renders identically today, and reads as a deliberate
 * choice the day anything starts drawing one.
 */
test('an avatar with nothing to edit clears the tone the last one wore', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'male', skinTone: 'light', hair: 'grey' });

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'tomato' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.avatar.preset, 'tomato');
  assert.equal(res.body.data.avatar.skinTone, null);
  assert.equal(res.body.data.avatar.hair, null);
});

/* ── The upload, and that it is gone ──────────────────────────────────────── */

/**
 * REFUSED, not ignored. `.strict()` is doing the work: without it an unknown
 * `image` would be stripped and the write would succeed, so a client sending a
 * photo would be told 200 and store nothing — the one outcome worse than an
 * error, because nobody would find out.
 */
test('an image is refused: there is no upload any more', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ image: jpegUri });

  assert.equal(res.status, 400);

  const stored = await User.findById(user._id);
  assert.equal(stored.avatar.preset, null);
});

test('an image alongside a valid preset is refused too', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'carrot', image: jpegUri });

  assert.equal(res.status, 400);

  // The preset must not have landed either. A partially-honoured write is how a
  // rejected request still changes something.
  const stored = await User.findById(user._id);
  assert.equal(stored.avatar.preset, null);
});

/**
 * The route that served an uploaded photo's bytes is gone, not merely unused.
 * A read endpoint outliving its feature is how deleted data stays reachable.
 */
test('nothing serves photo bytes any more', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api().get(`/api/users/${user._id}/avatar`).set(auth(accessToken));
  assert.equal(res.status, 404);
});

/**
 * `photoUpdatedAt` is not merely absent from the response — it cannot be
 * created. Mongoose will not write an undeclared field, and this is what says
 * so, because the field's absence is what `migrateRemovedAvatarPhotos` relies
 * on to be a one-way cleanup rather than a race it loses on the next write.
 */
test('a photo timestamp cannot be reintroduced through the model', async () => {
  const { user } = await authenticatedUser('customer');

  await User.updateOne({ _id: user._id }, { $set: { 'avatar.photoUpdatedAt': new Date() } });

  const stored = await User.findById(user._id).lean();
  assert.equal(stored.avatar.photoUpdatedAt, undefined);
});

/* ── The rest of the contract ─────────────────────────────────────────────── */

test('sending nothing is refused', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api().put(`/api/users/${user._id}/avatar`).set(auth(accessToken)).send({});
  assert.equal(res.status, 400);
});

test('a preset that is not a slug is refused', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  const res = await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: '../../etc/passwd' });

  assert.equal(res.status, 400);
});

test('removing the picture clears every part of it', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  await api()
    .put(`/api/users/${user._id}/avatar`)
    .set(auth(accessToken))
    .send({ preset: 'male', skinTone: 'light', hair: 'grey' });

  const res = await api().delete(`/api/users/${user._id}/avatar`).set(auth(accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data.avatar.preset, null);
  assert.equal(res.body.data.avatar.skinTone, null);
  assert.equal(res.body.data.avatar.hair, null);
});

test('one customer cannot set or remove another customer picture', async () => {
  const mine = await authenticatedUser('customer');
  const theirs = await authenticatedUser('customer');

  await api()
    .put(`/api/users/${theirs.user._id}/avatar`)
    .set(auth(theirs.accessToken))
    .send({ preset: 'tomato' });

  const write = await api()
    .put(`/api/users/${theirs.user._id}/avatar`)
    .set(auth(mine.accessToken))
    .send({ preset: 'carrot' });
  assert.equal(write.status, 404);

  const removal = await api()
    .delete(`/api/users/${theirs.user._id}/avatar`)
    .set(auth(mine.accessToken));
  assert.equal(removal.status, 404);

  // The refusals were real, not merely reported.
  const stored = await User.findById(theirs.user._id);
  assert.equal(stored.avatar.preset, 'tomato');
});

test('an anonymous caller cannot set a picture', async () => {
  const { user } = await authenticatedUser('customer');

  const res = await api().put(`/api/users/${user._id}/avatar`).send({ preset: 'carrot' });
  assert.equal(res.status, 401);
});

test('the picture cannot be set through the ordinary profile PATCH', async () => {
  const { accessToken, user } = await authenticatedUser('customer');

  /**
   * `.strict()` is what makes this a 400 rather than a silent no-op. One writer
   * for the picture is the rule that kept the preset and the upload from
   * undoing each other; it is kept now that there is one, so that a second door
   * cannot open the next time somebody adds a field here.
   */
  const res = await api()
    .patch(`/api/users/${user._id}`)
    .set(auth(accessToken))
    .send({ avatar: { preset: 'carrot' } });

  assert.equal(res.status, 400);
});
