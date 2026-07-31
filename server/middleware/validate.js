'use strict';

const { z } = require('zod');
const { ApiError } = require('./errors');

/**
 * Schema validation for request input.
 *
 * Every schema is built from z.object({...}).strict(), so unknown keys are a
 * hard error rather than being silently ignored. That is what stops mass
 * assignment: a request that smuggles `role` or `paymentStatus` into a body is
 * rejected outright instead of being partially trusted.
 */

function formatIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * @param {{ body?: z.ZodType, params?: z.ZodType, query?: z.ZodType }} schemas
 */
function validate(schemas) {
  return function validateMiddleware(req, _res, next) {
    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (!result.success) {
        return next(
          new ApiError(400, 'The submitted data is not valid.', 'VALIDATION_ERROR', formatIssues(result.error))
        );
      }

      // Express 5 exposes req.query via a getter, so it cannot be reassigned.
      // Parsed output is attached to req.valid instead of overwriting req.*.
      req.valid = req.valid || {};
      req.valid[source] = result.data;
    }
    return next();
  };
}

// --- Reusable primitives ---------------------------------------------------

/** Rejects anything that is not a plain string, which also blocks `{$ne: null}`. */
const nonEmptyString = (max = 200) =>
  z.string({ error: 'Expected a string.' }).trim().min(1).max(max);

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id.');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Must be a valid email address.'))
  .pipe(z.string().max(254));

/**
 * Indian mobile: an optional +91 / 91 / 0 prefix, then a 10-digit number
 * starting 6-9. Normalised to the bare 10 digits.
 *
 * The prefix is stripped by LENGTH, not by pattern. Stripping a leading "91"
 * unconditionally corrupts every valid number that merely starts with those
 * digits — 9111111111 is a real mobile, not a country code plus eight digits —
 * and since the phone number is now the sign-in credential, that turns into
 * "this person cannot log in" rather than a cosmetic glitch.
 */
const phone = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, '').replace(/^\+/, ''))
  .transform((value) => {
    if (value.length === 12 && value.startsWith('91')) return value.slice(2);
    if (value.length === 11 && value.startsWith('0')) return value.slice(1);
    return value;
  })
  .refine((value) => /^[6-9]\d{9}$/.test(value), 'Must be a valid 10-digit mobile number.');

/**
 * Whatever the user typed into the single sign-in box: a mobile number or an
 * email address, normalised by whichever branch matches.
 *
 * Order matters. `email` is tried first because it fails fast on a digit string,
 * whereas `phone` would strip separators from an address before rejecting it and
 * report a confusing error.
 */
const identifier = z.union([email, phone], {
  error: 'Enter a valid mobile number or email address.',
});

const otpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Verification code must be 6 digits.');

const positiveInt = (max) =>
  z.number().int().positive().max(max);

module.exports = {
  validate,
  z,
  fields: { nonEmptyString, objectId, email, phone, identifier, otpCode, positiveInt },
};
