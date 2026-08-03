'use strict';

const crypto = require('crypto');
const config = require('../config/env');

/**
 * Authenticated field-level encryption for financial identifiers.
 *
 * PAN and bank account numbers are stored encrypted rather than in the clear.
 * The threat this addresses is a database dump: hashing is not an option because
 * the values must be readable again to submit them to the payout provider, and a
 * plain column would hand an attacker a ready-made identity-theft dataset.
 *
 * AES-256-GCM, not CBC: GCM authenticates the ciphertext, so a tampered record
 * fails to decrypt instead of silently yielding attacker-chosen plaintext.
 *
 * Two derived keys, both from KYC_ENCRYPTION_KEY via HKDF with distinct `info`
 * labels. Reusing one key for both encryption and fingerprinting would let the
 * deterministic fingerprint leak information about the encryption key's domain.
 */

const ENC_KEY = crypto.hkdfSync('sha256', Buffer.from(config.kyc.encryptionKey), Buffer.alloc(0), 'vegbazzar:kyc:aead:v1', 32);
const FP_KEY = crypto.hkdfSync('sha256', Buffer.from(config.kyc.encryptionKey), Buffer.alloc(0), 'vegbazzar:kyc:fingerprint:v1', 32);

const VERSION = 'v1';

/**
 * @param {string} plaintext
 * @returns {string} `v1.<iv>.<tag>.<ciphertext>`, all base64url
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('encrypt() requires a non-empty string.');
  }

  // 12 bytes is the GCM-recommended nonce size, and a fresh random one per call
  // means encrypting the same PAN twice never produces the same ciphertext.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY), iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * @param {string} packed a value produced by encrypt()
 * @returns {string} the original plaintext
 * @throws {Error} if the record was tampered with or the key has changed
 */
function decrypt(packed) {
  if (typeof packed !== 'string') throw new TypeError('decrypt() requires a string.');

  const [version, iv, tag, ciphertext] = packed.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Encrypted field is malformed or uses an unsupported version.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENC_KEY), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Deterministic, non-reversible fingerprint used for uniqueness checks.
 *
 * Encryption is randomised, so two records holding the same PAN produce
 * different ciphertext and a unique index over that column would never fire.
 * This gives the index something stable to key on without storing the PAN in a
 * recoverable form. Keyed (HMAC) rather than a bare hash, because the PAN
 * keyspace is small enough to brute-force an unkeyed digest.
 *
 * @param {string} value
 * @returns {string} hex digest
 */
function fingerprint(value) {
  return crypto
    .createHmac('sha256', Buffer.from(FP_KEY))
    .update(String(value).trim().toUpperCase())
    .digest('hex');
}

module.exports = { encrypt, decrypt, fingerprint };
