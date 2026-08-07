'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
const kycRoutes = require('./routes/kyc');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const userRoutes = require('./routes/users');
const walletRoutes = require('./routes/wallet');
const whatsappRoutes = require('./routes/whatsapp');
const marketRoutes = require('./routes/markets');
const stallRoutes = require('./routes/stalls');
const riderRoutes = require('./routes/rider');
const shopRoutes = require('./routes/shops');

const WHATSAPP_WEBHOOK_PATH = '/api/whatsapp';
/**
 * Razorpay's payment webhook. Needs the raw bytes for the same reason WhatsApp
 * does — its HMAC covers exactly what was sent, and re-serialising the parsed
 * body does not reproduce those bytes.
 *
 * Unlike WhatsApp's, this one is mounted BELOW the database gate, on purpose:
 * it has to write to the ledger, so answering 503 while Mongo is down is
 * correct. Razorpay retries a failed webhook, which is exactly what should
 * happen to a credit we could not record.
 */
const RAZORPAY_WEBHOOK_PATH = '/api/wallet/webhook';

/**
 * The built client, when there is one.
 *
 * Present in a deployed container (the image runs `vite build`), absent in dev
 * and under test — where Vite serves the client on its own port and this
 * process is the API alone. Resolved once at load rather than stat-ing the
 * directory per request.
 */
const CLIENT_DIR = path.join(__dirname, '..', 'dist');
const CLIENT_INDEX = path.join(CLIENT_DIR, 'index.html');
const hasClient = fs.existsSync(CLIENT_INDEX);

/**
 * Content-Security-Policy for the JSON API.
 *
 * Nothing served under /api should ever execute or embed, so this stays as
 * restrictive as it has always been. It is now scoped to /api rather than
 * applied globally, because the same origin also serves the client (below) and
 * `script-src 'none'` would block the entire app.
 */
const API_CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'none'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
};

/**
 * Content-Security-Policy for the single-page client.
 *
 * Every entry is an origin the app actually reaches, kept as an explicit list
 * so that adding a third-party dependency is a deliberate edit here rather than
 * something that silently starts working.
 *
 *  - Razorpay Checkout injects its script at payment time and renders inside an
 *    iframe, so it needs script-src and frame-src, not just connect-src.
 *  - Geocoding and routing (Nominatim, Overpass, OSRM, BigDataCloud, the postal
 *    PIN lookup, Google geocoding) are fetch calls — connect-src only.
 *  - style-src allows inline because Leaflet positions map panes with inline
 *    style attributes and React components set style props; that is CSS
 *    injection surface only, far weaker than allowing inline script.
 *  - img-src allows any https origin: product imagery is operator-supplied by
 *    URL (see AdminModal), an image cannot execute, and enumerating every host
 *    a vendor might paste is not possible.
 */
const CLIENT_CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'"],
  workerSrc: ["'self'", 'blob:'],
  connectSrc: [
    "'self'",
    'https://api.razorpay.com',
    'https://lumberjack.razorpay.com',
    'https://nominatim.openstreetmap.org',
    'https://overpass-api.de',
    'https://router.project-osrm.org',
    'https://api.bigdatacloud.net',
    'https://api.postalpincode.in',
    'https://maps.googleapis.com',
  ],
  frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

function cspFor(directives) {
  return helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      ...directives,
      upgradeInsecureRequests: config.isProduction ? [] : null,
    },
  });
}

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
  //
  // CSP is set per surface instead of here, because this origin now serves two
  // very different things: a JSON API that must never execute anything, and the
  // client bundle that must. One policy cannot be correct for both.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    })
  );

  app.use('/api', cspFor(API_CSP_DIRECTIVES));

  // --- CORS ----------------------------------------------------------------
  // The old policy accepted any origin matching a private-network regex, so any
  // device on the same Wi-Fi could drive the API with credentials attached.
  const allowed = new Set(config.corsOrigins);
  /**
   * "Same-origin sends no Origin header" is not true for every request type.
   *
   * A `<script type="module">` fetch is always CORS-mode and sends Origin even
   * to its own host, as do stylesheet and worker fetches. Once this origin
   * started serving the client, that meant the app's own bundle failed the
   * allowlist and every asset came back 403 — the page loaded and then rendered
   * nothing.
   *
   * The request's own origin is therefore matched explicitly. Deriving it from
   * the request rather than requiring the deploy URL to be repeated in
   * CORS_ALLOWED_ORIGINS keeps this correct on any hostname the service answers
   * to. `req.protocol` reads X-Forwarded-Proto only because trust proxy is set
   * above, so it cannot be spoofed into claiming https off-platform.
   */
  const corsDelegate = (req, callback) => {
    const origin = req.headers.origin;
    const selfOrigin = `${req.protocol}://${req.get('host')}`;
    // Non-browser clients send no Origin at all.
    const ok = !origin || origin === selfOrigin || allowed.has(origin);

    if (!ok) return callback(new Error('CORS_ORIGIN_DENIED'));

    return callback(null, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    });
  };
  app.use(cors(corsDelegate));

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
       * Retain the raw bytes for the signed webhooks only.
       *
       * Their HMACs cover exactly what the sender transmitted, and
       * re-serialising the parsed object does not reproduce those bytes (key
       * order and number formatting are not preserved). Scoped to the paths
       * that need it rather than buffering a second copy of every request body.
       */
      verify(req, _res, buf) {
        const url = req.originalUrl || '';
        if (url.startsWith(WHATSAPP_WEBHOOK_PATH) || url.startsWith(RAZORPAY_WEBHOOK_PATH)) {
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
  /**
   * Scoped to the API rather than the whole origin.
   *
   * The budget exists to protect database-backed endpoints, and the limiter
   * answers in JSON — neither fits a request for a hashed asset the browser
   * will cache for a year. Left global, simply loading the client would spend a
   * visitor's allowance on static files.
   */
  app.use('/api', globalLimiter);

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
  app.use('/api/kyc', kycRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/wallet', walletRoutes);

  // Markets, the stalls inside them, and the riders who empty them.
  app.use('/api/markets', marketRoutes);
  app.use('/api/stalls', stallRoutes);
  app.use('/api/rider', riderRoutes);
  // Shopkeepers who trade from their own premises rather than a market stall.
  app.use('/api/shops', shopRoutes);

  /**
   * The client, served from this same origin.
   *
   * Not a deployment convenience: services/apiClient.js calls a relative `/api`
   * and the refresh token is an httpOnly SameSite=Strict cookie, so a client on
   * a different host would reach the wrong path and never send the cookie.
   * Same-origin also means no CORS entry is needed for the app itself.
   *
   * Skipped entirely when there is no build, which is what keeps `npm run
   * server` and the test suite pure-API.
   */
  if (hasClient) {
    const clientCsp = cspFor(CLIENT_CSP_DIRECTIVES);
    const isApiPath = (req) => req.path === '/api' || req.path.startsWith('/api/');

    app.use((req, res, next) => (isApiPath(req) ? next() : clientCsp(req, res, next)));

    app.use(
      express.static(CLIENT_DIR, {
        index: false,
        setHeaders(res, filePath) {
          // Vite content-hashes everything under /assets, so a URL there can
          // never change meaning and is safe to pin. Files that keep their name
          // across deploys (logo, manifest, splash video) must not be.
          const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
          res.setHeader(
            'Cache-Control',
            hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
          );
        },
      })
    );

    /**
     * Anything left that is not the API is the app shell, so the client router
     * can own the path. Deliberately not a bare catch-all: an unknown /api route
     * has to keep returning the JSON 404 below, not an HTML page that a fetch
     * would then fail to parse.
     */
    app.use((req, res, next) => {
      if (isApiPath(req)) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(CLIENT_INDEX, (err) => (err ? next(err) : undefined));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
