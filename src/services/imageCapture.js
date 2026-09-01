/**
 * Turning a phone camera photo into something small enough to send.
 *
 * A modern phone produces a 3–6 MB JPEG. The upload route accepts 120 KB. So
 * this is not an optimisation — without it every upload fails, and the fix has
 * to happen before the bytes reach the network, not after.
 *
 * The server enforces the same limit again on arrival. This runs in the
 * browser, where anyone can change it.
 */

/** Long edge, in pixels. Enough to see whether a tomato is bruised. */
const MAX_EDGE = 800;

/** Matches config.freshPhoto.maxBytes on the server. */
const MAX_BYTES = 120_000;

/** Tried in order until one fits. Below 0.4 a photo of vegetables turns to mud. */
const QUALITY_STEPS = [0.7, 0.6, 0.5, 0.4];

/**
 * Decode a File into something drawable.
 *
 * `createImageBitmap` is the fast path and handles EXIF orientation on modern
 * browsers; the <img> fallback covers older Safari.
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* Fall through — some browsers refuse certain encodings here. */
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file could not be read as an image.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** How many bytes a base64 data URI actually decodes to. */
function decodedBytes(dataUri) {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Downscale and compress a camera file to a JPEG data URI under the limit.
 *
 * Always re-encodes, even for an already-small file. That is deliberate: going
 * through a canvas drops the EXIF block, and EXIF on a phone photo carries GPS
 * coordinates. A shopkeeper photographing their own stall should not be
 * publishing its exact location to every customer who views the product.
 *
 * @param {File} file
 * @returns {Promise<string>} `data:image/jpeg;base64,…`
 * @throws {Error} when the file is not an image, or will not compress enough
 */
export async function toUploadableJpeg(file) {
  if (!file || !file.type?.startsWith('image/')) {
    throw new Error('Choose a photo to upload.');
  }

  const source = await decode(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;

  if (!width || !height) throw new Error('That photo could not be read.');

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext('2d');
  // A JPEG has no alpha channel, so anything transparent would encode black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  if (typeof source.close === 'function') source.close();

  for (const quality of QUALITY_STEPS) {
    const dataUri = canvas.toDataURL('image/jpeg', quality);
    if (decodedBytes(dataUri) <= MAX_BYTES) return dataUri;
  }

  /**
   * Four passes at 800px and it still will not fit — which in practice means
   * the canvas produced a PNG because the browser does not support JPEG
   * encoding here. Failing loudly beats sending something the server will
   * reject with a less useful message.
   */
  throw new Error('That photo is too detailed to upload. Try taking it again.');
}

/** Roughly how large the encoded photo is, for a size hint in the UI. */
export function approximateKb(dataUri) {
  return Math.round(decodedBytes(dataUri) / 1024);
}

// --- Profile pictures ------------------------------------------------------

/** Square edge, in pixels. It renders in a 112px circle at most. */
const AVATAR_EDGE = 320;

/** Matches config.avatar.maxBytes on the server. */
const AVATAR_MAX_BYTES = 40_000;

/**
 * Centre-crop and compress a chosen file into a square JPEG data URI.
 *
 * Cropped here rather than left to CSS: `object-fit: cover` would hide the
 * excess in the circle while every byte of it was still stored and sent, and a
 * 4:3 photo squeezed into the cap would lose the quality to margins nobody
 * sees.
 *
 * Re-encoding through a canvas also drops the EXIF block, which on a phone
 * photo carries GPS coordinates — the same reason `toUploadableJpeg` always
 * re-encodes.
 *
 * @param {File} file
 * @returns {Promise<string>} `data:image/jpeg;base64,…`
 */
export async function toAvatarJpeg(file) {
  if (!file || !file.type?.startsWith('image/')) {
    throw new Error('Choose a photo to upload.');
  }

  const source = await decode(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) throw new Error('That photo could not be read.');

  const edge = Math.min(width, height);
  const sx = (width - edge) / 2;
  const sy = (height - edge) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_EDGE;
  canvas.height = AVATAR_EDGE;

  const ctx = canvas.getContext('2d');
  // A JPEG has no alpha channel, so anything transparent would encode black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_EDGE, AVATAR_EDGE);
  ctx.drawImage(source, sx, sy, edge, edge, 0, 0, AVATAR_EDGE, AVATAR_EDGE);

  if (typeof source.close === 'function') source.close();

  for (const quality of [0.8, 0.7, 0.6, 0.5]) {
    const dataUri = canvas.toDataURL('image/jpeg', quality);
    if (decodedBytes(dataUri) <= AVATAR_MAX_BYTES) return dataUri;
  }

  throw new Error('That photo is too detailed to upload. Try a different one.');
}
