'use strict';

/**
 * Password hashing.
 *
 * Primary algorithm is scrypt from node:crypto — memory-hard and natively
 * implemented. The project previously used bcryptjs (a pure-JS bcrypt), which is
 * both slower per unit of security and capped at 72 bytes of input.
 *
 * Existing bcrypt hashes still verify, and any successful bcrypt verification
 * reports needsRehash so the caller can transparently upgrade the stored hash.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { ApiError } = require('../middleware/errors');

// 128 * N * r bytes of memory = 32 MiB at these parameters.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAXMEM = 96 * 1024 * 1024;

const BCRYPT_PATTERN = /^\$2[aby]\$/;

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

/** Produce a self-describing hash string: scrypt$N$r$p$salt$key (base64url). */
async function hash(password) {
  assertPasswordShape(password);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * @returns {Promise<{ valid: boolean, needsRehash: boolean }>}
 */
async function verify(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || stored.length === 0) {
    return { valid: false, needsRehash: false };
  }

  if (BCRYPT_PATTERN.test(stored)) {
    const valid = await bcrypt.compare(password, stored);
    return { valid, needsRehash: valid };
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return { valid: false, needsRehash: false };
  }

  const [, n, r, p, saltB64, keyB64] = parts;
  let expected;
  let salt;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(keyB64, 'base64url');
  } catch {
    return { valid: false, needsRehash: false };
  }

  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM },
      (err, out) => (err ? reject(err) : resolve(out))
    );
  }).catch(() => null);

  if (!derived || derived.length !== expected.length) {
    return { valid: false, needsRehash: false };
  }

  const valid = crypto.timingSafeEqual(derived, expected);
  const outdated = Number(n) !== SCRYPT_N || Number(r) !== SCRYPT_R || Number(p) !== SCRYPT_P;
  return { valid, needsRehash: valid && outdated };
}

/**
 * Structural password rules. Deliberately length-first rather than a maze of
 * character-class requirements, which push users toward predictable patterns.
 * @throws {ApiError} 400 WEAK_PASSWORD when the password is unacceptable.
 */
function assertPasswordShape(password) {
  const min = config.auth.minPasswordLength;
  const problems = [];

  if (typeof password !== 'string') {
    problems.push('Password must be a string.');
  } else {
    if (password.length < min) problems.push(`Password must be at least ${min} characters.`);
    if (password.length > 200) problems.push('Password must be at most 200 characters.');
    if (/^\s|\s$/.test(password)) problems.push('Password must not start or end with whitespace.');
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      problems.push('That password is too common. Choose something less predictable.');
    }
    if (/^(.)\1+$/.test(password)) problems.push('Password must not be a single repeated character.');
  }

  if (problems.length > 0) {
    throw new ApiError(400, problems.join(' '), 'WEAK_PASSWORD');
  }
}

// Small denylist covering the credentials this codebase previously shipped plus
// the usual suspects. A production deployment should back this with a breach
// corpus (e.g. Have I Been Pwned's k-anonymity range API).
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789',
  '1234567890', 'qwertyuiop', 'letmein123', 'welcome123', 'admin12345',
  'iloveyou123', 'changeme123', 'vegbazzar', 'vegbazzar123', 'customer123',
]);

module.exports = { hash, verify, assertPasswordShape };
