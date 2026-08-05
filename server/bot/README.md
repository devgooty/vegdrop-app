# VegDrop WhatsApp bot (unofficial)

Free WhatsApp sending and a small inbound bot, using the **WhatsApp Web
protocol** via [baileys] — not the official Business API.

## Read this before using it

**This violates WhatsApp's Terms of Service.** Meta detects and bans numbers
running unofficial clients. There is no appeal process worth relying on and no
warning. Use a number you are willing to lose permanently.

**Do not make this the only path to your login flow.** If the number is banned,
`NOTIFY_TRANSPORT=whatsapp_bot` means *nobody can sign in* — not degraded, dead.
The safe arrangement:

| Purpose | Channel | Why |
|---|---|---|
| Login / registration OTP | email, or official Cloud API | must not be bannable |
| Order updates, support replies | this bot | if it dies, orders still work |

OTP over this bot is supported because you asked for it, and it is **not** the
default. Setting `NOTIFY_TRANSPORT=whatsapp_bot` is a deliberate choice.

Ironically, OTP traffic is the *highest*-risk thing to put on an unofficial
client: bursts of near-identical short messages to people who never messaged you
first is exactly the pattern that gets flagged.

## Why it is a separate process

- `baileys` is ESM-only; `server/` is CommonJS.
- It owns a long-lived socket and an on-disk session that **exactly one process**
  may hold — so it cannot be scaled horizontally with the API, and it cannot run
  on serverless or any host with an ephemeral filesystem.
- If it crashes or gets banned, the API keeps serving.

The API reaches it over a **loopback-only HTTP bridge**.

## Setup

1. Generate a bridge token:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

2. Put it in `.env` as `WHATSAPP_BOT_BRIDGE_TOKEN`.

3. Start the bot and scan the QR with the phone that owns the number
   (WhatsApp → Settings → Linked devices → Link a device):

```bash
npm run bot
```

4. To route OTPs through it, add to `.env`:

```
NOTIFY_TRANSPORT=whatsapp_bot
```

That is the only setting. Codes are always addressed to the phone number, so
there is no channel to configure — and because sign-in is passwordless, this
bot being down means nobody can sign in at all. That is the whole risk of
`whatsapp_bot`: if the number is banned, so is your login.

## Operating it

Check liveness (unauthenticated, reveals only socket state):

```bash
curl http://127.0.0.1:5055/health
```

`503` means not paired or reconnecting. `200` means ready.

Session credentials live in `server/bot/.auth/` and are gitignored. **Treat that
directory as a password** — anyone with a copy can send WhatsApp messages as you.
To re-pair from scratch, delete it and restart.

## Ban-risk controls

`throttle.mjs` paces every outbound message. Defaults:

| Setting | Default | Effect |
|---|---|---|
| `WHATSAPP_BOT_MIN_INTERVAL_MS` | 3000 | minimum gap between sends |
| `WHATSAPP_BOT_JITTER_MS` | 2000 | randomises the gap so it is not a fixed tick |
| `WHATSAPP_BOT_DAILY_CAP` | 200 | hard stop per day |
| `WHATSAPP_BOT_RECIPIENT_COOLDOWN_MS` | 60000 | per-recipient rate limit |

Raising these raises your risk. A brand-new number sending 200 messages on day
one is the clearest possible signal. Warm up slowly.

Other things that get numbers banned: users blocking or reporting you, messaging
people who never contacted you, identical message bodies at volume, and running
the same session from two places at once.

## What the inbound bot does

| User sends | Reply |
|---|---|
| `hi` / `help` / `menu` | capability menu |
| `orders` | last 3 orders for **the sender's own number** |
| anything else | acknowledgement, no auto-answer |

Groups, broadcasts and status updates are ignored.

**Lookups are scoped to the sender.** The sender's number is verified by WhatsApp
itself, so it is a usable identity signal — but nothing is ever looked up by an
identifier from the message body. `orders VB1234` deliberately does *not* fetch
order `VB1234`; that would let anyone read any order by guessing, over an
unauthenticated channel. Same rule `routes/orders.js` follows with `req.user`.

Residual risk: India reassigns disconnected mobile numbers, so a new owner could
see the previous owner's recent orders. That is why replies carry only order
number, status and total — never the address, item list, or payment detail.

## Files

| File | Role |
|---|---|
| `run.mjs` | entry point, wiring, shutdown |
| `socket.mjs` | baileys connection, QR pairing, reconnect backoff |
| `bridge.mjs` | loopback HTTP `/send` + `/health` |
| `handlers.mjs` | inbound command routing |
| `throttle.mjs` | send pacing |

The API-side transport is `server/services/transports/whatsappBridge.js`.

[baileys]: https://github.com/WhiskeySockets/Baileys
