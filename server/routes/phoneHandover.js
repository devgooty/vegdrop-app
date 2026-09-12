'use strict';

const express = require('express');
const qrcodeGen = require('../vendor/qrcode-generator');
const config = require('../config/env');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const {
  reverseOtpStartLimiter,
  handoverScanLimiter,
  handoverPairLimiter,
  handoverPollLimiter,
} = require('../middleware/rateLimit');
const reverseOtp = require('../services/reverseOtp');
const { channelsForCode } = require('../services/reverseOtpChannels');
const phoneHandover = require('../services/phoneHandover');
const {
  APP_ROLE_SCOPE,
  findByIdentifier,
} = require('../services/authSession');

const router = express.Router();

const PURPOSES = ['login', 'registration', 'vendor_registration', 'delivery_registration'];

/**
 * Server-side so the helper page needs no CDN script to draw the QR.
 * Error level M (15%) survives a phone camera at an angle on a glossy screen.
 */
function renderQrSvg(text) {
  const qr = qrcodeGen(0, 'M');
  qr.addData(String(text));
  qr.make();
  // NOT scalable:true — an SVG with only a viewBox collapses to 0×0 in an
  // inline-block container (invisible under a caption telling you to scan it).
  return qr
    .createSvgTag({ cellSize: 6, margin: 4 })
    .replace('<svg ', '<svg style="max-width:100%;height:auto;display:block" ');
}

/**
 * Helper URL must land on the CLIENT origin (Vercel / Caddy), not the API host
 * when they differ. `clientOrigin` is validated against the CORS allowlist.
 */
function resolveClientOrigin(requested) {
  const allowed = new Set(config.corsOrigins || []);
  if (requested && allowed.has(requested)) return requested;
  // Dev convenience: Vite on :3000 when CORS list is the default.
  if (!config.requireRealServices && requested && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requested)) {
    return requested;
  }
  if (allowed.size === 1) return [...allowed][0];
  throw new ApiError(
    400,
    'Could not determine where to open the phone helper. Refresh and try again.',
    'HANDOVER_ORIGIN_REQUIRED'
  );
}

function handoverSigninUrl(clientOrigin, sessionId) {
  return `${clientOrigin.replace(/\/$/, '')}/verify-phone.html#${sessionId}`;
}

function requireHeaderToken(req, headerName, missingMessage) {
  const value = String(req.get(headerName) || '').trim();
  if (!value) {
    throw new ApiError(400, missingMessage, 'VALIDATION_ERROR');
  }
  return value;
}

const sessionIdBody = z.object({ sessionId: fields.nonEmptyString(64) }).strict();
const sessionIdQuery = z.object({ sessionId: fields.nonEmptyString(64) }).strict();

// Start — browser. Bound phone, no reverse code yet.
router.post(
  '/start',
  reverseOtpStartLimiter,
  validate({
    body: z
      .object({
        phone: fields.phone,
        purpose: z.enum(PURPOSES),
        app: z.enum(['customer', 'shopkeeper', 'delivery', 'developer', 'market_owner']).optional(),
        name: fields.nonEmptyString(120).optional(),
        clientOrigin: fields.nonEmptyString(200).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { phone, purpose, app = null, name, clientOrigin } = req.valid.body;
    const origin = resolveClientOrigin(clientOrigin);
    const user =
      purpose === 'login' ? await findByIdentifier(phone, app ? APP_ROLE_SCOPE[app] : undefined) : null;

    const started = await phoneHandover.startSession({
      phone,
      purpose,
      app,
      user,
      payload: user ? null : { name: name || null },
    });

    const signinUrl = handoverSigninUrl(origin, started.sessionId);

    return res.status(201).json({
      sessionId: started.sessionId,
      claimToken: started.claimToken,
      signinUrl,
      qrSvg: renderQrSvg(signinUrl),
      expiresAt: started.expiresAt,
      expiresInSeconds: started.expiresInSeconds,
    });
  }
);

// Scan — phone helper. First open wins; returns pair number only.
router.post(
  '/scan',
  handoverScanLimiter,
  validate({ body: sessionIdBody }),
  async (req, res) => {
    return res.json(await phoneHandover.scanSession(req.valid.body.sessionId));
  }
);

// Pair — browser. Claim token BEFORE digits; then mint reverse OTP.
router.post(
  '/pair',
  handoverPairLimiter,
  validate({
    body: z
      .object({
        sessionId: fields.nonEmptyString(64),
        claimToken: fields.nonEmptyString(80),
        pairNumber: z.string().regex(/^\d{4}$/),
      })
      .strict(),
  }),
  async (req, res) => {
    const { sessionId, claimToken, pairNumber } = req.valid.body;
    const paired = await phoneHandover.pairSession({
      sessionId,
      claimToken,
      pairNumber,
      issueChallenge: reverseOtp.issueChallenge,
    });

    return res.json({
      token: paired.token,
      code: paired.code,
      expiresAt: paired.expiresAt,
      channels: await channelsForCode(paired.code),
    });
  }
);

// Status polls — separate tokens; never mint a session from a GET.
router.get(
  '/status',
  handoverPollLimiter,
  validate({ query: sessionIdQuery }),
  async (req, res) => {
    const claimToken = requireHeaderToken(req, 'x-handover-claim-token', 'Missing claim token.');
    return res.json(
      await phoneHandover.browserStatus({
        sessionId: req.valid.query.sessionId,
        claimToken,
      })
    );
  }
);

router.get(
  '/phone-status',
  handoverPollLimiter,
  validate({ query: sessionIdQuery }),
  async (req, res) => {
    const phoneToken = requireHeaderToken(req, 'x-handover-phone-token', 'Missing phone token.');
    return res.json(
      await phoneHandover.phoneStatus({
        sessionId: req.valid.query.sessionId,
        phoneToken,
      })
    );
  }
);

module.exports = router;
