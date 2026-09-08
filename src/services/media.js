/**
 * Image uploads — shopkeeper listing photos only.
 *
 * Bytes go to our API, which stores them on Cloudinary. Customers never call
 * this; delivery proof uses a separate orders endpoint.
 */

import { api } from './apiClient';

/**
 * @param {string} dataUri JPEG/WebP from imageCapture.toUploadableJpeg
 * @returns {Promise<{url: string, bytes: number}>}
 */
export async function uploadProductImage(dataUri) {
  const result = await api.post('/media/product-image', { image: dataUri });
  return result.data;
}
