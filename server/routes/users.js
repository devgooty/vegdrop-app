'use strict';

const express = require('express');
const User = require('../models/User');
const { ROLES } = require('../models/User');
const UserAvatar = require('../models/UserAvatar');
const config = require('../config/env');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { revokeAllForUser } = require('../services/tokens');

const router = express.Router();

/**
 * Roles that may administer other accounts.
 *
 * `market_owner` used to be in here, and that was too much authority for what
 * the role actually is. A market owner is a business partner who runs a
 * marketplace, not platform staff:
 *
 *  - `PATCH /:id/role` accepts any value in ROLES, and self-modification is the
 *    only thing blocked. So a market owner could promote a second account they
 *    control to `developer` and inherit everything `developer` bypasses — every
 *    order in the system with its customer's name, phone and address, every
 *    market's price sheet, and the vendor KYC gate.
 *  - `GET /` returns `toPublicJSON()`, which carries `email` and `phone`. That
 *    handed every market owner the entire customer table, which is precisely
 *    the competitor-to-competitor leak `visibilityFilter` in routes/orders.js
 *    was rewritten to close. Scoping orders while leaving the user list open
 *    closed the window and left the door.
 *
 * Nothing is lost by narrowing it. A market owner administers markets and
 * stalls, and already has every market-scoped view they need: the stall-request
 * queue carries each applicant's name and number, `/:id/stalls` lists their
 * traders, and `/:id/analytics` reports how each is performing. Account-level
 * authority — promoting, suspending, deleting a person — is platform staff's.
 * The client agrees already: `registeredUsers` is only ever rendered by
 * DeveloperPanel, which only mounts for `developer`.
 */
const ADMIN_ROLES = ['developer'];

/**
 * User administration.
 *
 * Previously every route here was unauthenticated: GET /api/users dumped the
 * whole table and DELETE /api/users/:idOrEmail let anyone permanently remove any
 * account by guessing an email.
 */

router.get(
  '/',
  requireAuth,
  requireRole(ADMIN_ROLES),
  validate({
    query: z
      .object({
        role: z.enum(ROLES).optional(),
        status: z.enum(['active', 'suspended', 'deleted']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .strict(),
  }),
  async (req, res) => {
    const { role, status, limit } = req.valid.query;

    const filter = {};
    if (role) filter.role = role;
    filter.status = status || { $ne: 'deleted' };

    const users = await User.find(filter).sort({ createdAt: -1 }).limit(limit);
    return res.json({ data: users.map((u) => u.toPublicJSON()) });
  }
);

router.get(
  '/:id',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const isSelf = req.valid.params.id === req.user._id.toHexString();
    if (!isSelf && !ADMIN_ROLES.includes(req.user.role)) {
      throw new ApiError(404, 'User not found.', 'NOT_FOUND');
    }

    const user = await User.findById(req.valid.params.id);
    if (!user || user.status === 'deleted') throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    return res.json({ data: user.toPublicJSON() });
  }
);

/**
 * Update a profile. `role` and `status` are deliberately absent from the schema
 * — .strict() turns an attempt to include them into a 400 rather than a silent
 * escalation. Role changes go through the dedicated endpoint below.
 *
 * `phone` is absent too, and that one is load-bearing. Sign-in is passwordless,
 * so the phone number IS the credential: whoever receives its codes owns the
 * account. Letting a session rewrite it here would mean a stolen session could
 * be converted into permanent ownership, with nothing left to stop it now that
 * there is no password. Phone changes go through POST /api/auth/phone/start,
 * which proves control of the NEW number before anything is written.
 */
router.patch(
  '/:id',
  requireAuth,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        name: fields.nonEmptyString(120).optional(),
        /**
         * `email` is accepted here. `phone` still is not, and the difference is
         * the whole point.
         *
         * This field was refused for a while, because a login code was copied
         * to a verified address: any address a session could set was a way in,
         * and a stolen session could point it at the attacker and receive every
         * future code. Nothing is delivered to an email now, so setting one
         * grants nothing — it is where a stall notice goes, and that is all.
         *
         * `phone` stays out. It IS the credential, so changing it is changing
         * who owns the account; that goes through POST /api/auth/phone/start,
         * which proves control of the new number first.
         */
        email: fields.email.optional(),
      })
      .strict()
      .refine((data) => Object.keys(data).length > 0, { message: 'No fields to update.' }),
  }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    const isSelf = targetId === req.user._id.toHexString();
    if (!isSelf && !ADMIN_ROLES.includes(req.user.role)) {
      throw new ApiError(404, 'User not found.', 'NOT_FOUND');
    }

    const update = { ...req.valid.body };

    const user = await User.findOneAndUpdate(
      { _id: targetId, status: { $ne: 'deleted' } },
      { $set: update },
      { returnDocument: 'after', runValidators: true }
    );
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    return res.json({ data: user.toPublicJSON() });
  }
);

// ---------------------------------------------------------------------------
// Profile picture
// ---------------------------------------------------------------------------

/**
 * A body parser for the upload route alone.
 *
 * The app-wide limit is 100 KB (see server/app.js), which is right for JSON but
 * too small once base64 has inflated an image by a third. Widening the global
 * limit to suit one route would raise the ceiling on every endpoint, so this is
 * scoped here — exactly as routes/stalls.js scopes its own photo parser.
 */
const avatarBody = express.json({ limit: '256kb' });

/** `data:image/jpeg;base64,…` → the parts, or null if it is not one. */
function parseDataUri(value) {
  const match = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return null;

  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  // Round-trip check: a truncated or padded string decodes without complaint
  // and would be stored as an image that never renders.
  if (buffer.length === 0 || buffer.toString('base64') !== base64) return null;

  return { mimeType, base64, bytes: buffer.length };
}

/** Self or an admin. Mirrors the check on GET /:id and PATCH /:id. */
function assertMayEdit(req, targetId) {
  const isSelf = targetId === req.user._id.toHexString();
  if (!isSelf && !ADMIN_ROLES.includes(req.user.role)) {
    throw new ApiError(404, 'User not found.', 'NOT_FOUND');
  }
}

/**
 * The uploaded photo's bytes, which `toPublicJSON` deliberately omits.
 *
 * Behind auth and scoped to self-or-admin like the rest of this file. An avatar
 * is not sensitive in itself, but it is only ever rendered for the signed-in
 * account, so there is no reason to make one addressable by anybody holding an
 * id.
 */
router.get(
  '/:id/avatar',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    assertMayEdit(req, targetId);

    const avatar = await UserAvatar.findOne({ user: targetId });
    if (!avatar) throw new ApiError(404, 'No photo has been uploaded.', 'NOT_FOUND');

    return res.json({ data: { image: avatar.dataUri, bytes: avatar.bytes } });
  }
);

/**
 * Set the picture — either one of the built-in avatars, or an uploaded photo.
 *
 * ONE endpoint for both on purpose. The two are mutually exclusive, and putting
 * the preset on `PATCH /:id` instead would split that rule across two handlers
 * that each have to remember to undo the other. Here it is a single write.
 *
 * The format allow-list is jpeg and webp, and the exclusions matter more than
 * the inclusions: SVG is a script container and this file is rendered back into
 * a page, and PNG is lossless so it would blow the size cap on any real photo.
 */
router.put(
  '/:id/avatar',
  requireAuth,
  avatarBody,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z
      .object({
        /**
         * Not validated against a list of known avatars — see the note on
         * `avatar.preset` in models/User.js. A slug pattern is enforced so the
         * field can never hold anything but a key.
         */
        preset: z
          .string()
          .trim()
          .regex(/^[a-z0-9-]{1,24}$/, 'Not a valid avatar.')
          .optional(),
        /**
         * The person avatars' two editable parts, validated as slugs for the
         * same reason and against no list for the same reason. Meaningful only
         * alongside a preset — sent with an image they would describe a face
         * that is not being drawn.
         */
        skinTone: z
          .string()
          .trim()
          .regex(/^[a-z0-9-]{1,24}$/, 'Not a valid skin tone.')
          .optional(),
        hair: z
          .string()
          .trim()
          .regex(/^[a-z0-9-]{1,24}$/, 'Not a valid hair colour.')
          .optional(),
        image: z.string().min(32).max(400_000).optional(),
      })
      .strict()
      .refine(
        (data) => Boolean(data.preset) !== Boolean(data.image),
        { message: 'Send either a preset or an image, not both.' }
      )
      .refine(
        (data) => !data.image || (!data.skinTone && !data.hair),
        { message: 'A skin tone and hair colour belong to an avatar, not a photo.' }
      ),
  }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    assertMayEdit(req, targetId);

    const { preset, skinTone, hair, image } = req.valid.body;
    const update = {};

    if (preset) {
      // Picking a built-in avatar discards the upload it replaces, rather than
      // leaving orphaned bytes behind for a photo nothing can now display.
      await UserAvatar.deleteOne({ user: targetId });
      update['avatar.preset'] = preset;
      // Always written, never merged: an avatar with nothing to edit has to
      // clear whatever the previous one was wearing, or a tomato inherits the
      // skin tone of the face it replaced.
      update['avatar.skinTone'] = skinTone || null;
      update['avatar.hair'] = hair || null;
      update['avatar.photoUpdatedAt'] = null;
    } else {
      const parsed = parseDataUri(image);
      if (!parsed) {
        throw new ApiError(400, 'Send a JPEG or WebP photo as a data URI.', 'UNSUPPORTED_IMAGE');
      }
      if (parsed.bytes > config.avatar.maxBytes) {
        throw new ApiError(
          413,
          `That photo is ${Math.round(parsed.bytes / 1024)} KB. The limit is ${Math.round(config.avatar.maxBytes / 1024)} KB.`,
          'PHOTO_TOO_LARGE'
        );
      }

      await UserAvatar.findOneAndUpdate(
        { user: targetId },
        { $set: { image: parsed.base64, mimeType: parsed.mimeType, bytes: parsed.bytes } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      update['avatar.preset'] = null;
      update['avatar.skinTone'] = null;
      update['avatar.hair'] = null;
      update['avatar.photoUpdatedAt'] = new Date();
    }

    const user = await User.findOneAndUpdate(
      { _id: targetId, status: { $ne: 'deleted' } },
      { $set: update },
      { returnDocument: 'after', runValidators: true }
    );
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    return res.json({ data: user.toPublicJSON() });
  }
);

/** Back to initials. Clears both halves, whichever one was in use. */
router.delete(
  '/:id/avatar',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    assertMayEdit(req, targetId);

    await UserAvatar.deleteOne({ user: targetId });

    const user = await User.findOneAndUpdate(
      { _id: targetId, status: { $ne: 'deleted' } },
      {
        $set: {
          'avatar.preset': null,
          'avatar.skinTone': null,
          'avatar.hair': null,
          'avatar.photoUpdatedAt': null,
        },
      },
      { returnDocument: 'after' }
    );
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    return res.json({ data: user.toPublicJSON() });
  }
);

/** Role assignment. The one place a privilege level can change. */
router.patch(
  '/:id/role',
  requireAuth,
  requireRole(ADMIN_ROLES),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ role: z.enum(ROLES) }).strict(),
  }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    const { role } = req.valid.body;

    // Refuse self-modification: an admin demoting themselves can lock everyone
    // out, and self-promotion should never be a single-actor operation.
    if (targetId === req.user._id.toHexString()) {
      throw new ApiError(403, 'You cannot change your own role.', 'FORBIDDEN');
    }

    const user = await User.findOne({ _id: targetId, status: { $ne: 'deleted' } });
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    if (user.role === role) {
      return res.json({ data: user.toPublicJSON() });
    }

    user.role = role;
    // Invalidate every session so the old role cannot be used for its remaining
    // access-token lifetime.
    user.tokenVersion += 1;

    try {
      await user.save();
    } catch (err) {
      /**
       * This identity already holds the target role, on a DIFFERENT account.
       *
       * Uniqueness on User is per `(contact, role)` now, not per contact — see
       * models/User.js — because one phone or email may back a customer, a
       * shopkeeper and a delivery account at once. Promoting THIS document into
       * a role its own phone or email already owns elsewhere would collide with
       * that other account rather than merge into it; there is no merge here,
       * only two documents that cannot both claim the same (contact, role) pair.
       * Surfaced plainly rather than as a raw 500, since it is a legitimate
       * outcome an admin needs to know: pick the other account instead, or
       * change this one's role to something not already spoken for.
       */
      if (err?.code === 11000) {
        throw new ApiError(
          409,
          'This phone or email already has an account with that role.',
          'ROLE_ALREADY_HELD'
        );
      }
      throw err;
    }

    await revokeAllForUser(user._id);

    console.warn('[audit] role changed', {
      actor: req.user._id.toHexString(),
      actorRole: req.user.role,
      target: user._id.toHexString(),
      newRole: role,
    });

    return res.json({ data: user.toPublicJSON() });
  }
);

router.patch(
  '/:id/status',
  requireAuth,
  requireRole(ADMIN_ROLES),
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ status: z.enum(['active', 'suspended']) }).strict(),
  }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    if (targetId === req.user._id.toHexString()) {
      throw new ApiError(403, 'You cannot change your own status.', 'FORBIDDEN');
    }

    const user = await User.findOne({ _id: targetId, status: { $ne: 'deleted' } });
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    user.status = req.valid.body.status;
    if (user.status === 'suspended') {
      user.tokenVersion += 1;
      await revokeAllForUser(user._id);
    }
    await user.save();

    return res.json({ data: user.toPublicJSON() });
  }
);

/**
 * Soft delete. Hard deletion would orphan order history and ledger entries that
 * reference this user, and is unrecoverable if performed in error.
 */
router.delete(
  '/:id',
  requireAuth,
  requireRole(ADMIN_ROLES),
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    if (targetId === req.user._id.toHexString()) {
      throw new ApiError(403, 'You cannot delete your own account here.', 'FORBIDDEN');
    }

    const user = await User.findOne({ _id: targetId, status: { $ne: 'deleted' } });
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    user.status = 'deleted';
    user.tokenVersion += 1;
    // Release the unique identifiers so the person can register again later.
    // Both are sparse-unique now, so clearing them frees the values outright —
    // no tombstone string needed, and no risk of one colliding.
    user.email = undefined;
    user.phone = undefined;
    user.pendingPhone = undefined;
    user.phoneVerifiedAt = null;
    await user.save();
    await revokeAllForUser(user._id);

    console.warn('[audit] user soft-deleted', {
      actor: req.user._id.toHexString(),
      target: targetId,
    });

    return res.status(204).end();
  }
);

module.exports = router;
