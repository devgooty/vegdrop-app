'use strict';

const express = require('express');
const User = require('../models/User');
const { ROLES } = require('../models/User');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { revokeAllForUser } = require('../services/tokens');

const router = express.Router();

/** Roles that may administer other accounts. */
const ADMIN_ROLES = ['market_owner', 'developer'];

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

    // Changing the address invalidates its verified status. Email is not a
    // credential here — nothing is ever delivered to it — so an unverified one
    // is harmless; it is recorded as unverified rather than trusted.
    if (update.email) update.emailVerifiedAt = null;

    if (update.email) {
      const conflict = await User.findOne({ _id: { $ne: targetId }, email: update.email })
        .select('_id')
        .lean();
      if (conflict) {
        throw new ApiError(409, 'That email is already in use.', 'DUPLICATE');
      }
    }

    const user = await User.findOneAndUpdate(
      { _id: targetId, status: { $ne: 'deleted' } },
      { $set: update },
      { new: true, runValidators: true }
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
    await user.save();
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
    user.email = undefined;
    user.phone = `deleted:${user._id.toHexString()}`;
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
