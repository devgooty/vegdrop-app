'use strict';

/**
 * The one-time-code email.
 *
 * WHY THIS IS NOT IN notify.js
 *
 * A code goes to two very different places. On WhatsApp or SMS it is one terse
 * line, because the whole message is a notification preview and anything longer
 * is scrolled past. In an inbox it competes with everything else in the list and
 * has to say what it is for, how long it lasts, and that nobody will ever ask
 * for it. Composing both in one ternary is how the two drift apart.
 *
 * WHAT THE MARKUP DELIBERATELY AVOIDS
 *
 *  - No external stylesheet, image, font, or tracking pixel. Mail clients strip
 *    or block most of them, and a code that renders as a broken layout is worse
 *    than plain text. Everything is inline and self-contained.
 *  - Tables for layout, which is not a stylistic choice: Outlook's rendering
 *    engine ignores float and flex, and this is the one shape it lays out
 *    correctly.
 *  - Every email carries a plain-text part as well. Clients that refuse HTML
 *    fall back to it rather than to an empty message.
 */

/** Purpose → the verb that finishes "…verification code to __ your account". */
const PURPOSE_ACTION = Object.freeze({
  login: 'sign in to',
  registration: 'create',
  phone_change: 'move',
  email_change: 'add an email address to',
});

/**
 * Escape before interpolating anything a user controls.
 *
 * `name` comes from a profile field, so a display name containing markup would
 * otherwise be injected into the message body. The code itself is digits from
 * crypto.randomInt and cannot carry markup, but it is escaped too rather than
 * relying on that remaining true.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "5 minutes" / "1 minute" — the unit has to agree with the number. */
function plural(minutes) {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Build the email for a one-time code.
 *
 * @param {object} args
 * @param {string} args.code        the plaintext code
 * @param {string} args.purpose     login | registration | phone_change | email_change
 * @param {number} args.minutes     how long the code remains valid
 * @param {string} [args.role]      the recipient's role, when they already have one
 * @param {string} [args.name]      display name, when the account exists
 * @returns {{ subject: string, text: string, html: string }}
 */
function renderOtpEmail({ code, purpose, minutes, role = null, name = null }) {
  // A shopkeeper signing in is opening their merchant dashboard, not "your
  // account" — same code, named for whoever is actually reading it.
  const isMerchantLogin = purpose === 'login' && role === 'shopkeeper';

  const intro = isMerchantLogin
    ? 'Use this code to sign in to your VegDrop merchant dashboard:'
    : `Use this code to ${PURPOSE_ACTION[purpose] || 'verify'} your VegDrop account:`;

  // First name only: a full legal name in a greeting reads like a form letter.
  const firstName = String(name ?? '').trim().split(/\s+/)[0] || '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  // The code leads the subject so it is readable from a notification preview
  // without opening the message.
  const subject = `${code} is your VegDrop verification code`;

  const text = [
    greeting,
    '',
    intro,
    '',
    code,
    '',
    `This code expires in ${plural(minutes)} and can only be used once.`,
    '',
    'VegDrop support will never ask you for this code. If you did not request',
    'it, you can ignore this email — your account stays secure as long as you',
    'do not share the code.',
    '',
    '— The VegDrop Team',
  ].join('\n');

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F8F6;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2D2A26;">
        <tr>
          <td style="font-size:16px;line-height:24px;">
            <p style="margin:0 0 20px;">${escapeHtml(greeting)}</p>
            <p style="margin:0 0 24px;">${escapeHtml(intro)}</p>
            <p style="margin:0 0 24px;font-size:34px;font-weight:700;letter-spacing:9px;text-align:center;color:#0B7A37;background:#F1F7F2;border-radius:8px;padding:18px 0;">${escapeHtml(code)}</p>
            <p style="margin:0 0 24px;color:#5C6660;font-size:14px;">Expires in ${escapeHtml(plural(minutes))}. Can only be used once.</p>
            <p style="margin:0;padding-top:20px;border-top:1px solid #E6EAE7;font-size:14px;line-height:22px;color:#5C6660;">
              <strong style="color:#2D2A26;">VegDrop support will never ask you for this code.</strong>
              If you did not request it, you can ignore this email &mdash; your account stays secure as long as you do not share the code.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  return { subject, text, html };
}

module.exports = { renderOtpEmail, escapeHtml, PURPOSE_ACTION };
