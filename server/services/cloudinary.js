'use strict';

const { v2: cloudinary } = require('cloudinary');
const config = require('../config/env');
const { ApiError } = require('../middleware/errors');

/**
 * Image hosting for stall photos, shop listing shots, and delivery proof.
 *
 * Credentials stay on the server. Clients send a compressed data URI to our
 * API; we upload and store only the resulting URL + publicId in Mongo.
 *
 * Under test (or when deliberately unconfigured outside production), a local
 * mock returns stable HTTPS-shaped URLs so suites never call Cloudinary.
 */

let configured = false;

if (config.cloudinary.configured) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true,
  });
  configured = true;
}

function assertAvailable() {
  if (configured) return;
  if (config.isTest || config.cloudinary.allowMock) return;
  throw new ApiError(
    503,
    'Image uploads are not available right now.',
    'MEDIA_UNCONFIGURED'
  );
}

/**
 * Upload a JPEG/WebP data URI. Returns the delivery URL (with f_auto,q_auto)
 * and the public id for later destroy.
 */
async function uploadImage({ folder, dataUri, publicId }) {
  assertAvailable();

  if (!configured) {
    const id = publicId || `mock/${folder}/${Date.now()}`;
    return {
      url: `https://res.cloudinary.com/mock/image/upload/f_auto,q_auto/${id}.jpg`,
      publicId: id,
      bytes: Math.ceil((dataUri.length * 3) / 4),
      mimeType: dataUri.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg',
    };
  }

  try {
    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      public_id: publicId || undefined,
      overwrite: Boolean(publicId),
      resource_type: 'image',
      // Refuse SVG etc. at the provider as well as at our parser.
      allowed_formats: ['jpg', 'jpeg', 'webp'],
    });

    const optimized = cloudinary.url(result.public_id, {
      secure: true,
      fetch_format: 'auto',
      quality: 'auto',
    });

    return {
      url: optimized,
      publicId: result.public_id,
      bytes: result.bytes || 0,
      mimeType: result.format === 'webp' ? 'image/webp' : 'image/jpeg',
    };
  } catch (err) {
    console.error('[cloudinary] upload failed', {
      message: err?.message,
      http_code: err?.http_code,
    });
    throw new ApiError(
      502,
      'Could not store that photo. Please try again in a moment.',
      'MEDIA_UPLOAD_FAILED'
    );
  }
}

/** Best-effort delete. Failures are logged; callers should not fail the user action. */
async function destroyImage(publicId) {
  if (!publicId) return;
  if (!configured) return;

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch (err) {
    console.warn('[cloudinary] destroy failed', {
      publicId,
      message: err?.message,
    });
  }
}

module.exports = {
  uploadImage,
  destroyImage,
  isConfigured: () => configured,
  isMock: () => !configured && (config.isTest || config.cloudinary.allowMock),
};
