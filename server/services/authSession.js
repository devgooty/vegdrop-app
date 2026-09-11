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
 * `market_owner` and `developer` sign in through the customer login box but
 * are redirected to their own apps (`#/market-owner`, `#/developer`) by the
 * client. Shopkeeper and delivery each have a dedicated app and scope.
 */
const APP_ROLE_SCOPE = Object.freeze({
  customer: ['customer', 'market_owner', 'developer'],
  shopkeeper: ['shopkeeper'],
  delivery: ['delivery'],
  developer: ['developer'],
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
 * `pendingPhone` is matched too, and is now the only reason a legacy account
 * with an unproven number is findable at all. It exists for people who
 * registered back when the email leg could carry a registration on its own; new
 * accounts always have a proven `phone`, because the phone is the only thing
 * registration proves. Not matching it would tell those users no account exists
 * and push them into a registration that then collides on the number.
 *
 * `roles`, when given, narrows the match to `APP_ROLE_SCOPE` for the calling
 * app — see there for why. Omitted entirely rather than defaulted to "every
 * role", because every caller is updated to pass it; a caller that forgets would
 * otherwise resolve across apps silently, which is the one failure mode worth
 * refusing to default away.
 */
async function findByIdentifier(identifier, roles) {
  const scope = roles ? { role: { $in: roles } } : {};

  /**
   * Phone only. An email address used to resolve an account here, back when a
   * code could be delivered to one; it no longer can, so matching an email
   * would find an account nobody can then prove they own.
   */
  const base = { status: { $ne: 'deleted' }, ...scope };

  /**
   * A PROVED number outranks an unproved one, and this is two queries rather
   * than one `$or` because an `$or` cannot express a preference.
   *
   * `phone` is the credential of record; `pendingPhone` is a number somebody
   * typed and nobody demonstrated control of. Matched together in one filter,
   * `findOne` returns whichever document the index reaches first — so which
   * account you sign into is decided by storage order. That is not theoretical:
   * one number on the live database carries a `market_owner` holding it in
   * `phone` and two `customer` rows holding it in `pendingPhone`, and the same
   * sign-in resolved to different accounts on different attempts. The user was
   * bounced out of the market owner app by a coin flip.
   *
   * The security half matters more than the confusion. `pendingPhone` is not
   * unique and never was — nothing stops two accounts claiming one number
   * unproven — so leaving the two ranks equal means an unproved claim can
   * capture a sign-in from the account that actually proved it.
   *
   * `createdAt` breaks the remaining tie so the answer is at least stable: among
   * equally-ranked rows the original account wins, not whichever was touched
   * last. Legacy data is the only place that tie can occur, because the
   * (phone, role) unique index makes it impossible once a number is proved.
   */
  const proved = await User.findOne({ phone: identifier, ...base }).sort({ createdAt: 1 });
  if (proved) return proved;

  return User.findOne({ pendingPhone: identifier, ...base }).sort({ createdAt: 1 });
}

/**
 * `features` carries deployment-wide switches, not per-user permissions.
 *
 * It rides on the session payload because every app already calls
 * `/auth/refresh` on mount, so this needs no extra request and no second
 * endpoint to keep in step. A client constant mirroring the server flag was the
 * alternative and was rejected: two copies of one truth is how a screen ends up
 * offering something the API then refuses.
 *
 * The client uses this to decide what to SHOW. The server enforces the same
 * flags independently at the routes that matter — a hidden button is a UX gate,
 * exactly as the role checks are.
 */
function featureFlags() {
  return {
    scheduledOrders: !config.scheduledOrdersLocked,
  };
}

function sessionPayload(user, accessToken) {
  return {
    accessToken,
    expiresIn: config.jwt.accessTtlSeconds,
    user: user.toPublicJSON(),
    features: featureFlags(),
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
  APP_ROLE_SCOPE,
  appMayCreateAccount,
  findByIdentifier,
  featureFlags,
  sessionPayload,
  establishSession,
};
