# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

VegBazzar — a React PWA for a hyperlocal grocery delivery service, with an Express + MongoDB backend and Razorpay payments.

## Commands

```bash
npm run dev        # Vite dev server on :3000 (proxies /api/* to :5000)
npm run server     # Express API on :5000
npm run server:dev # same, with --watch
npm test           # server test suite (node --test + mongodb-memory-server)
npm run build      # production build
```

Both processes must run together (`npm run dev` and `npm run server` in separate terminals).

Run a single test file or case:

```bash
node --test server/test/auth.test.js
```

```bash
node --test --test-name-pattern="refresh rotates" "server/test/**/*.test.js"
```

Tests spin up an in-memory MongoDB **replica set** (required — the wallet ledger and checkout use multi-document transactions). No local mongod needed. `config/env.js` skips `dotenv` when `NODE_ENV=test` specifically so a test run can never pick up real Razorpay credentials and call the live API.

## Configuration

Copy `.env.example` to `.env`. Notes that are easy to get wrong:

- **Never prefix a secret with `VITE_`.** Vite inlines those into the browser bundle. This codebase previously shipped role passwords that way; they were readable in `dist/`.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_PEPPER` are **required in production** — the process aborts at boot without them. In development a random ephemeral secret is generated per run, so sessions reset on restart.
- Production additionally requires `CORS_ALLOWED_ORIGINS`, real Razorpay credentials, and a MongoDB deployment that supports transactions. Each is a boot-time hard failure, not a warning.

## Architecture

### Three entry apps behind one hash router

`src/AppRouter.jsx` reads `window.location.hash` and mounts one of three apps:

- `src/App.jsx` — customer-facing, and the **only** entry that exposes the `developer` and `market_owner` panels (rendered inline as tabs).
- `src/ShopkeeperApp.jsx` — `#/shopkeeper`, role-locked to `shopkeeper`/`developer`.
- `src/DeliveryApp.jsx` — `#/delivery`, role-locked to `delivery`/`developer`.

All three are lazily loaded by `AppRouter`, so a customer never downloads the shopkeeper or delivery bundles (or Leaflet, which only the map routes pull in).

Each polls `GET /api/orders` every 5s and pauses while the tab is hidden. The previous localStorage `vegbazzar_orders` + `BroadcastChannel` mirror is **deliberately gone**: the server scopes orders by role, but a shared browser-storage key is readable by every app on the origin, so mirroring leaked one role's order list into another's. Don't reintroduce cross-app state sharing through web storage.

The role checks in these components are **UX gates only**. The API authorizes every request independently, so bypassing one in the browser grants nothing.

### Authentication — server-authoritative, passwordless

This is the part most likely to be misunderstood, because two earlier versions did it differently.

**There are no passwords anywhere in this system.** No `passwordHash` field, no hashing service, no password policy, no change-password endpoint. Possession of the phone number is the entire credential, which is why a code is always addressed to the phone and never to an email — an email-addressed code would be a second, weaker way in.

**The client never decides anything about identity.** It does not derive roles or validate codes. Sign-in is two calls:

1. `POST /api/auth/otp/start` — `{ phone, name? }`, returns `202` with an OTP challenge. **No token is issued here.**
2. `POST /api/auth/otp/verify` — `{ challengeId, code }`, returns the access token and sets the refresh cookie.

**Sign-in and sign-up are the same two calls, deliberately.** A number with no account gets one created at step 2; an existing one is signed in. Splitting them would make "no account for this number" an observable difference, so `start` answers identically either way and `verify`'s response does not reveal which happened. `name` is used only when creating, and is ignored for an existing account — it cannot rename someone else's.

A self-created account is always a `customer`. Privileged roles are assigned only via `PATCH /api/users/:id/role` by an admin, and signing in through the public flow never changes an existing role.

The phone a session is issued for comes from the **stored challenge**, never from the verify request body — otherwise holding a challenge id would let you point it at a number you don't control.

Brute-force protection is per challenge (attempts counted atomically, challenge dies at the cap) plus two rate limiters that must both exist: one keyed on the **destination** number, so rotating IPs cannot flood one person, and one keyed on the **caller**, so one source cannot walk a list of numbers making the bot send unsolicited messages — which is the fastest way to get the WhatsApp number banned.

Token handling, in `src/services/apiClient.js`:

- **Access token lives in a module-scoped variable — never localStorage.** Web storage is readable by any script that achieves XSS.
- **Refresh token is an httpOnly `SameSite=Strict` cookie**, so JavaScript cannot read it at all. Sessions restore on mount via `restoreSession()`.
- A `401` triggers one silent refresh and one retry; concurrent 401s share a single in-flight refresh.

**There is no offline auth fallback, deliberately.** A failed request is a failure. The previous client treated a network error as permission to authenticate itself locally, which made login bypassable by going offline. Offline degrades to read-only catalog browsing.

Stateless access tokens are revoked by incrementing `user.tokenVersion`; `middleware/auth.js` compares the token's `tv` claim against the live record and re-reads the role from the database on every request, so a demotion applies immediately.

### OTP delivery

`services/notify.js` resolves a transport **per channel**, lazily. `email` and
`sms` are separate: every real provider handles one or the other, never both.
Codes are only ever addressed to a phone now, so only the `sms` channel is
actually reached — the split stays because a single global transport once meant
that configuring WhatsApp broke sign-in for every user with an email address, and
that failure mode should not be reintroducible by adding one email notification.

Phone transports, via `NOTIFY_TRANSPORT`:

| Value | What it is |
|---|---|
| `console` | dev stub, prints codes; **production refuses to boot on it** |
| `whatsapp` | official Cloud API; approved template, paid per message |
| `whatsapp_bot` | unofficial WhatsApp Web client (`server/bot`); free, against WhatsApp's ToS, bannable |

There is no `OTP_CHANNEL` setting — it was removed rather than left as a knob
that can no longer change anything.

WhatsApp is a **transport, not a channel**. `OtpChallenge.channel` stays
`sms`/`email`, so the `phoneVerifiedAt` logic in `routes/auth.js` is untouched —
a code delivered over WhatsApp still verifies the phone.

**Because sign-in is passwordless, the transport is now a hard dependency**: if
codes cannot be delivered, nobody can sign in at all. That raises the stakes on
`whatsapp_bot` specifically, whose number can be banned.

The unofficial bot (`server/bot/`, ESM, separate process — see its README) exists
because it was asked for, and is deliberately **not** the default. If that number
is banned, `NOTIFY_TRANSPORT=whatsapp_bot` means nobody can sign in at all.

Things that are easy to get wrong here:

- **WhatsApp cannot send free-form business-initiated text.** Every code goes
  through a Meta-approved template of category `AUTHENTICATION`, whose body takes
  exactly one variable. A `type: "text"` send looks accepted and never arrives.
- **The transport never logs the code** and masks the destination. The console
  stub prints codes on purpose; a real provider transport must not.
- **Meta's HTTP status is never reused as the client's.** A 400 from Graph means
  our template is wrong, not that the caller's request was — the same mistake
  `middleware/errors.js` calls out for the Razorpay client. Every failure becomes
  one generic `503 OTP_DELIVERY_FAILED`, which also stops "not a WhatsApp user"
  from being an account-enumeration oracle.
- **`POST /messages` returning 200 does not mean delivered.** Delivery status
  arrives only at `/api/whatsapp/webhook`, which is mounted *above* the database
  gate (it needs no database) and authenticates Meta via an
  `X-Hub-Signature-256` HMAC. That HMAC covers the exact bytes sent, which is why
  `app.js` retains `req.rawBody` for that one path — re-serialising the parsed
  body does not reproduce them.

### Money

**All amounts are integer paise on the server** (`pricePaise`, `amountPaise`, `totalAmountPaise`). Rupees exist only at the API boundary and as presentation virtuals. Floats invite rounding drift that surfaces as unreconcilable balances.

Wallet balance is derived from an append-only `WalletTransaction` ledger — never a mutable field. Crediting is idempotent through a unique `idempotencyKey` (`razorpay:<paymentId>`), so a replayed verification collides on the index instead of double-crediting.

Order totals are **always recomputed server-side** from the catalog. Request bodies carry only product ids and quantities; `.strict()` zod schemas reject any attempt to include `totalAmountPaise`, `status`, or `paymentStatus`.

Payment verification checks three independent things: HMAC signature, that the `PaymentIntent` belongs to *this* user, and (with live credentials) that Razorpay itself reports the payment captured for the recorded amount. A signature alone proves a payment is real, not that it is yours.

### Server layout

`server/` is CommonJS; `src/` is ESM compiled by Vite. This split is intentional.

- `config/env.js` — validates and freezes config at load; **import it before anything reads `process.env`**
- `middleware/validate.js` — all schemas use `.strict()`, which is what blocks mass assignment
- `middleware/sanitize.js` — strips `$`-prefixed keys; written to mutate in place because Express 5 exposes `req.query` via a getter
- `db/connect.js` — `withTransaction()` degrades to non-transactional on standalone mongod (dev only; production boot refuses that topology)

Two gotchas worth knowing:

- Mongoose's global `sanitizeFilter` is **deliberately not enabled** — it rewrites legitimate operator queries like `{ expiresAt: { $gt: now } }` into `$eq` comparisons and silently breaks them. Injection is blocked at the validation and sanitize layers instead.
- `middleware/errors.js` only honours `err.statusCode` for `ApiError` (or `expose === true`). Trusting arbitrary SDK errors let the Razorpay client turn its own upstream 4xx into a client-facing 4xx, misreporting an integration failure as the caller's mistake.

### Performance

- **Bundle**: `AppRouter` lazy-loads the three role apps; `App.jsx` lazy-loads the admin panels. `vite.config.js` splits vendors by change cadence (`vendor-react`, `vendor-maps`, `vendor-icons`) so a feature deploy invalidates only small app chunks. Customer first-load JS is ~121 KB gzip, down from a single 181 KB chunk.
- **Do not add Leaflet to `index.html`.** `MapLocationPicker.jsx` imports it from npm; CDN tags were a duplicate download of an already-bundled library.
- **Caching**: `/api` is `Cache-Control: no-store` by default because nearly every response is identity-scoped. The public catalog opts into `public, max-age=30, stale-while-revalidate=120`. Adding a public route means opting in explicitly — never widen the default.
- **Compression**: gzip above a 1 KB threshold.

### Styling

Tailwind CSS v4 via `@tailwindcss/vite`. No `tailwind.config.js` is used or needed under v4.
