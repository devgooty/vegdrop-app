/**
 * Inbound message handling.
 *
 * AUTHENTICATION MODEL
 *
 * The only identity signal available is the sender's phone number, and WhatsApp
 * itself guarantees that the sender controls that account. So a lookup keyed on
 * the sender's own number is reasonable.
 *
 * What this deliberately does NOT do is look up anything by an identifier the
 * sender supplies. "status VB1234" would let anyone read any order by guessing
 * order numbers, over an unauthenticated channel. Every query here is scoped to
 * the sender, the same way routes/orders.js scopes by `req.user`.
 *
 * Recycled numbers are a real residual risk: India reassigns disconnected mobile
 * numbers, so a new owner could see the previous owner's recent orders. That is
 * why nothing sensitive (addresses, full item lists, payment detail) is echoed —
 * just order number, status and total.
 */

/** Strip a WhatsApp JID down to the digits of the phone number. */
function digitsFromJid(jid) {
  return String(jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Extract plain text from the several shapes a WhatsApp message can take. */
function textOf(message) {
  const m = message?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  ).trim();
}

/**
 * Convert an international number back to the 10-digit local form the database
 * stores. Mirrors `fields.phone` in middleware/validate.js.
 */
function toLocalNumber(digits, countryCode) {
  if (digits.startsWith(countryCode) && digits.length === countryCode.length + 10) {
    return digits.slice(countryCode.length);
  }
  return digits.length === 10 ? digits : null;
}

const MENU =
  'VegBazzar 🥬\n\n' +
  'Reply with:\n' +
  '*orders* — your recent orders\n' +
  '*help* — this menu\n\n' +
  'For anything else, someone from our team will get back to you.';

const STATUS_EMOJI = {
  Pending: '🕐',
  Preparing: '👨‍🍳',
  'Out for Delivery': '🚚',
  Delivered: '✅',
  Cancelled: '❌',
};

/**
 * @param {object} deps
 * @param {(localPhone: string) => Promise<Array>} deps.findOrdersByPhone
 * @param {string} deps.countryCode
 * @param {(jid: string, text: string) => Promise<any>} deps.reply
 */
export function createMessageHandler({ findOrdersByPhone, countryCode, reply }) {
  return async function handleMessage(message) {
    const jid = message.key?.remoteJid;
    if (!jid) return;

    // Ignore groups, broadcasts and status updates — this is a 1:1 support line.
    if (!jid.endsWith('@s.whatsapp.net')) return;

    const body = textOf(message).toLowerCase();
    if (!body) return;

    const senderDigits = digitsFromJid(jid);
    const localPhone = toLocalNumber(senderDigits, countryCode);

    if (/^(hi|hello|hey|help|menu|start)\b/.test(body)) {
      await reply(jid, MENU);
      return;
    }

    if (/^orders?\b/.test(body) || /my orders?/.test(body)) {
      if (!localPhone) {
        await reply(jid, 'We could not match this number to an account. Please order through the app first.');
        return;
      }

      let orders;
      try {
        orders = await findOrdersByPhone(localPhone);
      } catch (err) {
        console.error('[bot] order lookup failed', { message: err?.message });
        await reply(jid, 'We could not look that up right now. Please try again in a moment.');
        return;
      }

      if (!orders || orders.length === 0) {
        await reply(jid, 'No recent orders found for this number.');
        return;
      }

      const lines = orders.map((o) => {
        const emoji = STATUS_EMOJI[o.status] ?? '📦';
        const total = (o.totalAmountPaise / 100).toFixed(2);
        return `${emoji} *${o.orderNumber}* — ${o.status}\n   ₹${total}`;
      });

      await reply(jid, `Your recent orders:\n\n${lines.join('\n\n')}`);
      return;
    }

    // Anything unrecognised. No LLM, no guessing — just acknowledge.
    await reply(
      jid,
      "Thanks for your message! We've noted it and someone will follow up.\n\nReply *help* for what this number can do automatically."
    );
  };
}

export { textOf, digitsFromJid, toLocalNumber };
