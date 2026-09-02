'use strict';

const express = require('express');
const User = require('../models/User');
const { ROLES } = require('../models/User');
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

/** Self or an admin. Mirrors the check on GET /:id and PATCH /:id. */
function assertMayEdit(req, targetId) {
  const isSelf = targetId === req.user._id.toHexString();
  if (!isSelf && !ADMIN_ROLES.includes(req.user.role)) {
    throw new ApiError(404, 'User not found.', 'NOT_FOUND');
  }
}

/**
 * Set the picture: one of the built-in avatars.
 *
 * UPLOADED PHOTOS ARE GONE, AND THIS ROUTE IS WHERE THEY WOULD COME BACK.
 *
 * There was a second answer here — a jpeg or webp data URI, stored in its own
 * `UserAvatar` collection and fetched by a companion `GET /:id/avatar`. All of
 * it is removed: the collection, that route, the size cap, the format
 * allow-list, the scoped 256kb body parser, and `avatar.photoUpdatedAt` on the
 * user record. `db/migrations.js` drops the stored bytes on boot.
 *
 * What the deletion took with it is worth stating, because each of these is a
 * cost that COMES BACK with the feature rather than something to re-derive:
 * user-supplied bytes rendered back into a page (which is why SVG was refused -
 * it is a script container), a body limit an order of magnitude above every
 * other route's, EXIF stripping performed in the browser where it cannot be
 * relied on, and a second collection to keep in step with the user record. A
 * drawn avatar has none of them: it is a slug the client renders.
 *
 * It stays a PUT on its own path rather than folding into `PATCH /:id`, which
 * still refuses `avatar` under `.strict()`. One writer for the picture is the
 * rule that kept the two answers from undoing each other, and it costs nothing
 * to keep now that there is one.
 */
router.put(
  '/:id/avatar',
  requireAuth,
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
          .regex(/^[a-z0-9-]{1,24}$/, 'Not a valid avatar.'),
        /**
         * The person avatars' two editable parts, validated as slugs for the
         * same reason and against no list for the same reason. Optional
         * because most of the roster has neither — a tomato has no hair.
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
      })
      .strict(),
  }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    assertMayEdit(req, targetId);

    const { preset, skinTone, hair } = req.valid.body;

    const update = {
      'avatar.preset': preset,
      /**
       * Always written, never merged: an avatar with nothing to edit has to
       * clear whatever the previous one was wearing, or a tomato inherits the
       * skin tone of the face it replaced.
       */
      'avatar.skinTone': skinTone || null,
      'avatar.hair': hair || null,
    };

    const user = await User.findOneAndUpdate(
      { _id: targetId, status: { $ne: 'deleted' } },
      { $set: update },
      { returnDocument: 'after', runValidators: true }
    );
    if (!user) throw new ApiError(404, 'User not found.', 'NOT_FOUND');

    return res.json({ data: user.toPublicJSON() });
  }
);

/** Back to initials. */
router.delete(
  '/:id/avatar',
  requireAuth,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const targetId = req.valid.params.id;
    assertMayEdit(req, targetId);

    const user = await User.findOneAndUpdate(
      { _id: targetId, status: { $ne: 'deleted' } },
      {
        $set: {
          'avatar.preset': null,
          'avatar.skinTone': null,
          'avatar.hair': null,
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
