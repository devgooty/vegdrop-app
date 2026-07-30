'use strict';

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const config = require('./config/env');
const { isConnected } = require('./db/connect');
const { sanitizeRequest } = require('./middleware/sanitize');
const { errorHandler, notFoundHandler, ApiError } = require('./middleware/errors');
const { globalLimiter } = require('./middleware/rateLimit');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const userRoutes = require('./routes/users');
const walletRoutes = require('./routes/wallet');
const whatsappRoutes = require('./routes/whatsapp');

const WHATSAPP_WEBHOOK_PATH = '/api/whatsapp';

function createApp() {
  const app = express();

  // Rate limiting and cookie `secure` depend on the real client IP and scheme.
  // Left unset behind a proxy, every request appears to come from one address.
  if (config.trustProxy) {
    app.set('trust proxy', Number.isNaN(Number(config.trustProxy)) ? config.trustProxy : Number(config.trustProxy));
  }
  app.disable('x-powered-by');

  // --- Security headers ----------------------------------------------------
  // The previous configuration disabled CSP outright.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          // The API serves JSON only; nothing here should ever execute or embed.
          scriptSrc: ["'none'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    })
  );

  // --- CORS ----------------------------------------------------------------
  // The old policy accepted any origin matching a private-network regex, so any
  // device on the same Wi-Fi could drive the API with credentials attached.
  const allowed = new Set(config.corsOrigins);
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser clients send no Origin header.
        if (!origin) return callback(null, true);
        if (allowed.has(origin)) return callback(null, true);
        return callback(new Error('CORS_ORIGIN_DENIED'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );

  // --- Compression ---------------------------------------------------------
  // JSON compresses extremely well (a 100-product catalog is ~80% smaller), and
  // this is the single cheapest latency win on mobile networks.
  app.use(
    compression({
      // Below roughly one MTU the compression overhead outweighs the saving.
      threshold: 1024,
      filter(req, res) {
        // Honour an explicit opt-out, e.g. for streaming endpoints.
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
      },
    })
  );

  // --- Parsing -------------------------------------------------------------
  // An explicit cap: without one, a single large body can exhaust memory.
  app.use(
    express.json({
      limit: '100kb',
      /**
       * Retain the raw bytes for the WhatsApp webhook only.
       *
       * Its X-Hub-Signature-256 HMAC covers exactly what Meta sent, and
       * re-serialising the parsed object does not reproduce those bytes (key
       * order and number formatting are not preserved). Scoped to the one path
       * that needs it rather than buffering a second copy of every request body.
       */
      verify(req, _res, buf) {
        if (req.originalUrl && req.originalUrl.startsWith(WHATSAPP_WEBHOOK_PATH)) {
          req.rawBody = buf;
        }
      },
    })
  );
  app.use(cookieParser());

  // --- Request correlation -------------------------------------------------
  app.use((req, _res, next) => {
    req.id = crypto.randomUUID();
    next();
  });

  app.use(sanitizeRequest);
  app.use(globalLimiter);

  /**
   * Caching policy: private by default, public strictly opt-in.
   *
   * Almost every response here is scoped to one identity (orders, wallet,
   * profile). If a shared cache or a proxy stored one of those, it could serve
   * one user's data to another. Routes that are genuinely public — currently
   * only the catalog — override this explicitly.
   */
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // --- Health (must not require the database) ------------------------------
  app.get('/api/health', (_req, res) => {
    const dbUp = isConnected();
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ok' : 'degraded',
      database: dbUp ? 'connected' : 'disconnected',
      timestamp: Date.now(),
    });
  });

  /**
   * WhatsApp webhook — mounted above the database gate.
   *
   * It only reads delivery statuses out of the payload and logs them, so it needs
   * no database. Answering 503 while Mongo is down would make Meta retry, and
   * repeated failures get a webhook disabled.
   */
  app.use(WHATSAPP_WEBHOOK_PATH, whatsappRoutes);

  // --- Database gate -------------------------------------------------------
  app.use('/api', (req, res, next) => {
    if (isConnected()) return next();
    // 503 signals "retry later". The client must treat this as a failure, never
    // as permission to fall back to local authentication.
    return next(new ApiError(503, 'Service temporarily unavailable. Please try again shortly.', 'DB_UNAVAILABLE'));
  });

  // --- Routes --------------------------------------------------------------
  app.use('/api/auth', authRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/wallet', walletRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
