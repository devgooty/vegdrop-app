'use strict';

const config = require('../config/env');
const User = require('../models/User');
const tokens = require('./tokens');

/**
 * The pieces of sign-in that more than one route needs.
 *
 * These lived inside routes/auth.js while it was the only thing that signed
 * anyone in. Reverse OTP (routes/reverseOtp.js) mints sessions too, and a second
 * copy of "which roles may this app resolve" or "how is a session established"
 * is exactly how two flows drift apart — one gets a fix, the other keeps the
 * bug. They are shared from here instead.
 *
 * Nothing about the rules changed in the move; the commentary explaining them
 * moved with them.
 */

/** Fallback display name when someone signs up without supplying one. */
function placeholderName(phone) {
  return `Customer ${String(phone).slice(-4)}`;
}

function isEmailIdentifier(identifier) {
  return String(identifier).includes('@');
}

/**
 * Which accounts a given app is willing to sign in.
 *
 * One phone or email can now back several accounts — one per role, since
 * `User`'s uniqueness moved from `(email)` to `(email, role)` (see the long
 * comment on models/User.js). That makes "find the account for this
 * identifier" ambiguous unless the caller also says which app is asking: the
 * shopkeeper app must never resolve to the customer account of someone who
 * also shops here, and the customer app must never hand a stranger's session
 * to their shopkeeper identity by accident.
 *
 * `market_owner` and `developer` are never self-registered — they only ever
 * arrive by promoting one of these three accounts via PATCH /api/users/:id/role
 * — and neither has a dedicated app of its own; both sign in through the
 * customer app, where `App.jsx` renders their extra panels inline. So they are
 * folded into the customer scope rather than given their own.
 */
const APP_ROLE_SCOPE = Object.freeze({
  customer: ['customer', 'market_owner', 'developer'],
  shopkeeper: ['shopkeeper', 'developer'],
  delivery: ['delivery', 'developer'],
});

/**
 * Apps that may turn an unrecognised phone number into a brand new account.
 *
 * Only the customer app. A shopkeeper or delivery account is minted solely
 * through its own dual-OTP registration, which proves an email as well as a
 * phone — see the long comment at /otp/start in routes/auth.js. Without this
 * distinction, someone typing their number into the delivery app's sign-in box
 * for the first time would silently receive a customer account they can never
 * see from that app.
 */
const ACCOUNT_CREATING_APPS = Object.freeze(['customer']);

function appMayCreateAccount(app) {
  return !app || ACCOUNT_CREATING_APPS.includes(app);
}

/**
 * Resolve an account from whatever was typed into the single sign-in box.
 *
 * `pendingPhone` is matched too. Someone who registered while WhatsApp was down
 * knows only the number they typed; not matching it would tell them no account
 * exists, send them back through registration, and fail on the email already
 * being taken. They are found here and signed in through their verified email —
 * the unproven number still receives nothing.
 *
 * `roles`, when given, narrows the match to `APP_ROLE_SCOPE` for the calling
 * app — see there for why. Omitted entirely rather than defaulted to "every
 * role", because every caller is updated to pass it; a caller that forgets would
 * otherwise resolve across apps silently, which is the one failure mode worth
 * refusing to default away.
 */
async function findByIdentifier(identifier, roles) {
  const scope = roles ? { role: { $in: roles } } : {};

  if (isEmailIdentifier(identifier)) {
    return User.findOne({ email: identifier, status: { $ne: 'deleted' }, ...scope });
  }
  return User.findOne({
    $or: [{ phone: identifier }, { pendingPhone: identifier }],
    status: { $ne: 'deleted' },
    ...scope,
  });
}

function sessionPayload(user, accessToken) {
  return {
    accessToken,
    expiresIn: config.jwt.accessTtlSeconds,
    user: user.toPublicJSON(),
  };
}

async function establishSession(user, req, res) {
  const accessToken = tokens.signAccessToken(user);
  const refresh = await tokens.issueRefreshToken(user, req);
  tokens.setRefreshCookie(res, refresh.token, refresh.expiresAt);
  return sessionPayload(user, accessToken);
}

module.exports = {
  placeholderName,
  isEmailIdentifier,
  APP_ROLE_SCOPE,
  appMayCreateAccount,
  findByIdentifier,
  sessionPayload,
  establishSession,
};
