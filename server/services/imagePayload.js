'use strict';

const config = require('../config/env');
const { ApiError } = require('../middleware/errors');

/**
 * Parse and size-check a shopkeeper/delivery photo data URI.
 *
 * Shared by stall photos, product listing uploads, and delivery proof so every
 * upload path enforces the same allow-list (JPEG/WebP only — never SVG).
 */

/** `data:image/jpeg;base64,…` → parts, or null if it is not one. */
function parseDataUri(value) {
  const match = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return null;

  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  // Round-trip check: a truncated or padded string decodes without complaint
  // and would be stored as an image that never renders.
  if (buffer.length === 0 || buffer.toString('base64') !== base64) return null;

  return { mimeType, base64, bytes: buffer.length, dataUri: value };
}

/**
 * @param {string} value raw body.image
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ mimeType: string, base64: string, bytes: number, dataUri: string }}
 */
function requirePhotoDataUri(value, opts = {}) {
  const maxBytes = opts.maxBytes ?? config.freshPhoto.maxBytes;
  const parsed = parseDataUri(value);
  if (!parsed) {
    throw new ApiError(400, 'Send a JPEG or WebP photo as a data URI.', 'UNSUPPORTED_IMAGE');
  }
  if (parsed.bytes > maxBytes) {
    throw new ApiError(
      413,
      `That photo is ${Math.round(parsed.bytes / 1024)} KB. The limit is ${Math.round(maxBytes / 1024)} KB.`,
      'PHOTO_TOO_LARGE'
    );
  }
  return parsed;
}

module.exports = { parseDataUri, requirePhotoDataUri };
