'use strict';

const config = require('../config/env');

/** An error that is safe to surface to the client verbatim. */
class ApiError extends Error {
  constructor(statusCode, message, code = 'ERROR', details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

function notFoundHandler(req, _res, next) {
  next(new ApiError(404, `No route matches ${req.method} ${req.path}.`, 'NOT_FOUND'));
}

/**
 * Terminal error handler.
 *
 * Anything not explicitly marked safe is reported as a generic 500. Mongo driver
 * errors, stack traces, and unexpected exceptions frequently embed schema
 * details, connection strings, or key material, so they never reach the client.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
function errorHandler(err, req, res, _next) {
  // Default to 500 and only narrow for errors we recognise. Trusting an
  // arbitrary err.statusCode lets a third-party SDK (the Razorpay client, for
  // one) turn its own upstream 4xx into a client-facing 4xx, which misreports a
  // server-side integration failure as the caller's mistake.
  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong. Please try again.';
  let details;

  if (err instanceof ApiError || err.expose === true) {
    statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    code = err.code || 'ERROR';
    message = err.message;
    details = err.details;
  } else if (err?.name === 'ValidationError' && err?.errors) {
    // Mongoose schema validation — the field names are ours, so they are safe.
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'The submitted data is not valid.';
    details = Object.keys(err.errors).map((field) => ({ field, message: err.errors[field].message }));
  } else if (err?.code === 11000) {
    statusCode = 409;
    code = 'DUPLICATE';
    message = 'That record already exists.';
  } else if (err?.type === 'entity.parse.failed') {
    statusCode = 400;
    code = 'MALFORMED_JSON';
    message = 'Request body is not valid JSON.';
  } else if (err?.message === 'CORS_ORIGIN_DENIED') {
    statusCode = 403;
    code = 'CORS_DENIED';
    message = 'Origin is not permitted.';
  }

  if (statusCode >= 500) {
    console.error('[error]', {
      method: req.method,
      path: req.path,
      requestId: req.id,
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
  }

  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  if (req.id) body.error.requestId = req.id;
  // Stack traces are a development affordance only.
  if (!config.isProduction && statusCode >= 500 && err?.stack) {
    body.error.stack = err.stack.split('\n').slice(0, 8);
  }

  res.status(statusCode).json(body);
}

module.exports = { ApiError, errorHandler, notFoundHandler };
