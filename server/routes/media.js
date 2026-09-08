'use strict';

const express = require('express');
const crypto = require('crypto');
const { ApiError } = require('../middleware/errors');
const { validate, z } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireVerifiedVendor } = require('../middleware/vendorVerified');
const { stallActionLimiter } = require('../middleware/rateLimit');
const { requirePhotoDataUri } = require('../services/imagePayload');
const media = require('../services/cloudinary');

const router = express.Router();

/**
 * Binary image uploads for roles that are allowed to take photos.
 *
 * Customers never reach these routes. Shopkeepers upload listing photos;
 * delivery proof lives on /api/orders/:id/delivery-proof instead.
 */

const photoBody = express.json({ limit: '1mb' });

/**
 * Shopkeeper listing / catalogue image.
 *
 * Returns a Cloudinary HTTPS URL the client puts on Product.image — the product
 * create/update schemas already require a URL, never a data URI.
 */
router.post(
  '/product-image',
  requireAuth,
  requireRole('shopkeeper'),
  requireVerifiedVendor,
  stallActionLimiter,
  photoBody,
  validate({
    body: z.object({ image: z.string().min(32).max(2_000_000) }).strict(),
  }),
  async (req, res) => {
    const parsed = requirePhotoDataUri(req.valid.body.image);
    const uploaded = await media.uploadImage({
      folder: `vegdrop/catalog/${req.user._id.toHexString()}`,
      dataUri: parsed.dataUri,
      publicId: crypto.randomUUID(),
    });

    return res.status(201).json({
      data: { url: uploaded.url, bytes: parsed.bytes },
    });
  }
);

/** Anything else under /media is refused — keeps the surface intentional. */
router.use((_req, _res, next) => {
  next(new ApiError(404, 'Not found.', 'NOT_FOUND'));
});

module.exports = router;
