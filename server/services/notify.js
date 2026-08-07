'use strict';

const config = require('../config/env');
const { renderOtpEmail, PURPOSE_ACTION } = require('./templates/otpEmail');

/**
 * Outbound message delivery.
 *
 * A single narrow interface with a development stub. Wiring a real provider
 * (Twilio/MSG91 for SMS, SES/SendGrid/SMTP for email) means implementing
 * `send` in a new transport and selecting it here — no caller changes.
 */

/**
 * @typedef {object} OtpDetails
 * @property {string} code      the plaintext code
 * @property {string} purpose   login (sign-up shares it) | phone_change
 * @property {number} ttlSeconds
 */

/**
 * @typedef {object} Transport
 * @property {string} name
 * @property {(msg: { channel: 'sms'|'email', to: string, subject?: string, text: string, html?: string, otp?: OtpDetails }) => Promise<void>} send
 *
 * `text` is a fully composed human-readable message, which is all a plain SMS or
 * email transport needs. `html` is set for email only and is always accompanied
 * by `text`, never a replacement for it: a transport that cannot send multipart
 * (or a client that will not render markup) still has something to show. `otp`
 * carries the same information structured, because
 * WhatsApp business-initiated messages must go through a pre-approved template
 * whose only variable is the code — that transport cannot parse it back out of
 * the prose. Transports that do not need it ignore it.
 */

/** @type {Transport} */
const consoleTransport = {
  name: 'console',
  /**
   * Printing a code is not delivering it.
   *
   * A send here succeeds, which is fine for a caller that only needs to know
   * nothing threw — but registration has to ask the user to type the code back,
   * and a code sitting in a server log never reached them. Flagged so that flow
   * can tell "sent" from "sent somewhere the user can see".
   */
  reachesRecipient: false,
  async send({ channel, to, subject, text }) {
    // Codes are printed only outside production, and production refuses to boot
    // on this transport (see resolveTransport), so this cannot leak live secrets.
    console.info(
      `\n──────── ${channel.toUpperCase()} (dev stub) ────────\n` +
        `to:      ${to}\n` +
        (subject ? `subject: ${subject}\n` : '') +
        `${text}\n` +
        '───────────────────────────────────────\n'
    );
  },
};

/** @type {Transport} */
const nullTransport = {
  name: 'null',
  reachesRecipient: false,
  async send() {
    /* Swallowed: used under test so suites do not spam stdout. */
  },
};

/**
 * Build the transport that delivers to PHONE destinations.
 *
 * Kept separate from the email transport because every real provider handles one
 * or the other, never both. Routing an email address into a phone transport used
 * to be possible and threw at send time — see resolveRegistry below.
 */
function resolvePhoneTransport() {
  if (config.notifyTransport === 'whatsapp') {
    // Required config is validated at boot in config/env.js, so reaching here
    // with incomplete credentials is impossible.
    const { createWhatsappTransport } = require('./transports/whatsapp');
    const wa = config.whatsapp;

    console.info(
      `[notify] transport=whatsapp template=${wa.templateName} locale=${wa.templateLocale} api=${wa.apiVersion}`
    );

    return createWhatsappTransport({
      phoneNumberId: wa.phoneNumberId,
      accessToken: wa.accessToken,
      apiVersion: wa.apiVersion,
      templateName: wa.templateName,
      templateLocale: wa.templateLocale,
      includeOtpButton: wa.includeOtpButton,
      buttonSubType: wa.buttonSubType,
      defaultCountryCode: wa.defaultCountryCode,
      timeoutMs: wa.timeoutMs,
    });
  }

  if (config.isProduction) {
    // Backstop only: config/env.js already refuses to boot production on the
    // console stub, because that writes verification codes to server logs
    // instead of delivering them.
    throw new Error(
      'No production notification transport is configured. Set WHATSAPP_* credentials or implement another transport in server/services/notify.js before deploying.'
    );
  }

  return consoleTransport;
}

/**
 * Build the transport that delivers to EMAIL destinations.
 *
 * A login code is addressed to the phone and *copied* here when the account has
 * a verified address (see services/otp.js). The phone remains the credential of
 * record: this channel is additive, and its failures are swallowed rather than
 * failing a sign-in.
 *
 * Kept separate from the phone transport for the reason in the registry note
 * below — one global transport once meant configuring WhatsApp broke sign-in for
 * every user who had an email address.
 */
function resolveEmailTransport() {
  const mail = config.email;

  if (mail.configured && mail.providers.length > 0) {
    const { createHttpEmailTransport } = require('./transports/httpEmail');
    const { createFailoverTransport } = require('./transports/failover');

    const transports = mail.providers.map((p) =>
      createHttpEmailTransport({
        provider: p.name,
        apiKey: p.apiKey,
        from: mail.from,
        timeoutMs: mail.timeoutMs,
      })
    );

    console.info(
      `[notify] email providers=${mail.providers.map((p) => p.name).join(' -> ')} from=${mail.from}`
    );

    // A single provider needs no chain, but keeping one costs nothing and means
    // adding a second key later changes no code path.
    return createFailoverTransport({ transports });
  }

  if (mail.configured && mail.smtp.host) {
    const { createEmailTransport } = require('./transports/email');
    const smtp = mail.smtp;

    console.info(`[notify] email transport=smtp host=${smtp.host} port=${smtp.port} secure=${smtp.secure}`);
    // Railway blocks outbound SMTP on Hobby and Trial; this will fail there with
    // ESOCKET before authenticating. Use a provider API key on those plans.
    if (!smtp.secure && smtp.port === 587) {
      console.info('[notify] if this fails with ESOCKET, the host is blocking SMTP — set BREVO_API_KEY instead.');
    }

    return createEmailTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      pass: smtp.pass,
      // The shared sender, not smtp.from — one address, one place to set it.
      from: mail.from,
      timeoutMs: smtp.timeoutMs,
    });
  }

  if (config.isProduction) {
    // Reached only if something addresses an email while SMTP is unconfigured.
    // Fan-out checks `configured` first, so this is a programming error, not a
    // deployment one — and it must not degrade to printing codes into a log.
    throw new Error(
      'No email transport is configured. Set EMAIL_FROM plus at least one provider key (BREVO_API_KEY, SENDGRID_API_KEY, MAILERSEND_API_KEY, MAILTRAP_API_TOKEN, PLUNK_API_KEY, RESEND_API_KEY), or SMTP_HOST and SMTP_FROM on a host that permits SMTP.'
    );
  }

  return consoleTransport;
}

/**
 * Transport per channel.
 *
 * WHY THIS IS KEYED BY CHANNEL
 *
 * Resolution is per channel and lazy, so an unconfigured channel only fails if
 * something actually addresses it. A single global transport used to mean that
 * configuring a phone provider (WhatsApp) broke sign-in for every user who had
 * an email address: the phone transport correctly refused the email, and the
 * refusal surfaced as a failed login.
 */
const registry = new Map();

function transportFor(channel) {
  // An explicitly installed transport wins, including under test — otherwise
  // setTransport below could never be observed, because the isTest check would
  // answer first and swallow every send.
  if (registry.has(channel)) return registry.get(channel);

  if (config.isTest) return nullTransport;

  registry.set(channel, channel === 'email' ? resolveEmailTransport() : resolvePhoneTransport());
  return registry.get(channel);
}

/** Test seam: swap the transport for every channel, or pass null to restore. */
function setTransport(next) {
  if (next === null) {
    registry.delete('email');
    registry.delete('sms');
    return;
  }
  registry.set('email', next);
  registry.set('sms', next);
}

/**
 * Will a code sent on this channel actually arrive somewhere the user can read?
 *
 * False for the dev stub, which prints to stdout, and for the null transport
 * used under test. Registration asks the user to type the code back, so it has
 * to skip a channel that cannot deliver one rather than show an input for a
 * message that was never sent. Absence of the flag means yes — a real transport
 * does not have to opt in.
 */
function reachesRecipient(channel) {
  return transportFor(channel).reachesRecipient !== false;
}

async function sendOtp({ channel, to, code, purpose, ttlSeconds, role, name }) {
  const minutes = Math.round(ttlSeconds / 60);

  /**
   * Email gets its own composition, including an HTML part.
   *
   * An inbox is not a notification shade: the message has to identify itself
   * among everything else in the list, which is why it carries a greeting, an
   * expiry and the "we will never ask for this" warning that the SMS line has no
   * room for. The plain-text alternative is built alongside it, so a client that
   * refuses HTML shows that same copy rather than an empty body.
   */
  if (channel === 'email') {
    const { subject, text, html } = renderOtpEmail({ code, purpose, minutes, role, name });

    await transportFor(channel).send({
      channel,
      to,
      subject,
      text,
      html,
      otp: { code, purpose, ttlSeconds },
    });
    return;
  }

  /**
   * One line, because the whole message is a notification preview.
   *
   * A shopkeeper signing in is asking for their merchant dashboard, not "your
   * account" — same code, same expiry, just named for the audience actually
   * reading it. WhatsApp ignores the prose entirely: its AUTHENTICATION-category
   * template takes only the code (see resolvePhoneTransport), so this text is
   * what the SMS console stub prints.
   *
   * The purpose→verb map is shared with the email template rather than copied,
   * so adding a purpose cannot leave one channel saying "verify".
   */
  const text =
    purpose === 'login' && role === 'shopkeeper'
      ? `${code} is your VegDrop merchant dashboard verification code. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.\n` +
        'Never share this code with anyone, including VegDrop staff.'
      : `${code} is your VegDrop verification code to ${PURPOSE_ACTION[purpose] || 'verify'} your account.\n` +
        `It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Do not share it with anyone.`;

  await transportFor(channel).send({
    channel,
    to,
    subject: 'Your VegDrop verification code',
    text,
    // Structured form for template-based transports; see the Transport typedef.
    otp: { code, purpose, ttlSeconds },
  });
}

/**
 * Send an ordinary message — not a one-time code.
 *
 * `sendOtp` above is deliberately not reusable for this: it composes from a
 * code, a purpose and a TTL, and its WhatsApp path routes through an
 * AUTHENTICATION-category template whose only variable is the code. A "someone
 * asked to join your market" notice has none of those things.
 *
 * NEVER THROWS. Every caller so far is telling somebody about a state change
 * that has already been committed, so a mail provider having a bad minute must
 * not turn a successful request into a failed one. The failure is logged and
 * swallowed; the underlying record is the source of truth and the recipient
 * will see it next time they open the app. Callers that genuinely need delivery
 * confirmed should not use this.
 */
async function sendNotice({ channel = 'email', to, subject, text, html = undefined }) {
  if (!to) return { sent: false, reason: 'no-destination' };

  try {
    await transportFor(channel).send({ channel, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    // The destination is not logged in full: these go to real people, and a log
    // line is a wider audience than the inbox was.
    console.error(`[notify] notice delivery failed: ${err?.message}`);
    return { sent: false, reason: 'delivery-failed' };
  }
}

module.exports = {
  sendOtp,
  sendNotice,
  reachesRecipient,
  setTransport,
  consoleTransport,
  nullTransport,
};
