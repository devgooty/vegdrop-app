# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

VegDrop — a React PWA for a hyperlocal grocery delivery service, with an Express + MongoDB backend and Razorpay payments.

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
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_PEPPER`, `KYC_ENCRYPTION_KEY` are **required in production** — the process aborts at boot without them. In development a random ephemeral secret is generated per run, so sessions reset on restart.
- **`KYC_ENCRYPTION_KEY` is effectively permanent.** It encrypts bank account numbers at rest; rotating it makes every existing vendor KYC record undecryptable.
- Production additionally requires `CORS_ALLOWED_ORIGINS`, real Razorpay credentials, `RAZORPAYX_*` payout credentials, and a MongoDB deployment that supports transactions. Each is a boot-time hard failure, not a warning.
- `RAZORPAYX_*` is a **separate product** from `RAZORPAY_*`. Payments credentials collect money and cannot send it, so the KYC penny drop needs its own set.

## Architecture

### Three entry apps behind one hash router

`src/AppRouter.jsx` reads `window.location.hash` and mounts one of three apps:

- `src/App.jsx` — customer-facing, and the **only** entry that exposes the `developer` and `market_owner` panels (rendered inline as tabs).
- `src/ShopkeeperApp.jsx` — `#/shopkeeper`, role-locked to `shopkeeper`/`developer`.
- `src/DeliveryApp.jsx` — `#/delivery`, role-locked to `delivery`/`developer`.

All three are lazily loaded by `AppRouter`, so a customer never downloads the shopkeeper or delivery bundles (or Leaflet, which only the map routes pull in).

Each polls `GET /api/orders` every 5s and pauses while the tab is hidden. The previous localStorage `vegdrop_orders` + `BroadcastChannel` mirror is **deliberately gone**: the server scopes orders by role, but a shared browser-storage key is readable by every app on the origin, so mirroring leaked one role's order list into another's. Don't reintroduce cross-app state sharing through web storage.

The role checks in these components are **UX gates only**. The API authorizes every request independently, so bypassing one in the browser grants nothing.

### Authentication — server-authoritative, passwordless

This is the part most likely to be misunderstood, because two earlier versions did it differently.

**There are no passwords anywhere in this system.** No `passwordHash` field, no hashing service, no password policy, no change-password endpoint. Possession of the phone number is the credential of record: a challenge is bound to a phone, and that is the number a session is issued for.

**A login code is additionally copied to a verified email when SMTP is configured** (`SMTP_HOST` + `SMTP_FROM`). This was asked for deliberately, and the trade it makes should be stated plainly rather than discovered: once a code reaches a mailbox, whoever reads that mailbox can sign in, so account security becomes the **weaker** of the two channels. Two rules keep that from being a takeover path, and neither is optional:

- **Only verified addresses receive copies.** `emailVerifiedAt` must be set, via `POST /api/auth/email/start` + `/verify`, which sends a code to the *new* address to prove control of it.
- **`PATCH /api/users/:id` rejects `email`**, exactly as it rejects `phone`. It accepted `email` while nothing was delivered there. Now that codes arrive, an unverified address would let a briefly-stolen session redirect every future code to the attacker — the same attack that removing `phone` closed.

Email delivery is **best effort**: `services/otp.js` sends the copy after the phone leg has already succeeded, and swallows failures. A dead mail server must not fail a sign-in whose code was already delivered. A phone failure is still fatal.

**The client never decides anything about identity.** It does not derive roles or validate codes. Sign-in is two calls:

1. `POST /api/auth/otp/start` — `{ phone, name? }`, returns `202` with an OTP challenge. **No token is issued here.**
2. `POST /api/auth/otp/verify` — `{ challengeId, code }`, returns the access token and sets the refresh cookie.

**Sign-in and sign-up are the same two calls, deliberately.** A number with no account gets one created at step 2; an existing one is signed in. Splitting them would make "no account for this number" an observable difference, so `start` answers identically either way and `verify`'s response does not reveal which happened. `name` is used only when creating, and is ignored for an existing account — it cannot rename someone else's.

A self-created account is always a `customer`. Privileged roles are assigned only via `PATCH /api/users/:id/role` by an admin, and signing in through the public flow never changes an existing role — with one deliberate exception, below.

**One contact backs one account *per role*, not one account overall.** A phone number is a person, and a person plausibly wants to shop, sell, and deliver through the same one — so uniqueness on `User` is the compound `(email, role)` / `(phone, role)`, never `(email)` / `(phone)`. One email may hold a customer account, a shopkeeper account and a delivery account at once; it may never hold two of the same role. Each is a **fully separate document** with its own `_id`, order history and duty status. There is no shared profile object above them, and nothing links them but the contact string itself.

Which of them a request means is decided by **which app asked**, via the `app` field on `/auth/lookup` and `/auth/otp/start` and the `APP_ROLE_SCOPE` map in `routes/auth.js`. This is not cosmetic: without it a bare email is ambiguous, and the shopkeeper app would resolve a customer account and sign the user into the wrong thing. When adding a route that resolves an account from a contact, scope it — `findByIdentifier(identifier, roles)` takes the roles for exactly this reason.

Two consequences that have already bitten:

- **`services/otp.js` scopes its cooldown and supersede queries by account** (`{ user: user._id }`), not by destination. Keyed on destination alone, one person requesting a shopkeeper code moments after a customer code would have had the second throttled, or the first silently invalidated.
- **The uniqueness change needs a migration to mean anything on an existing database.** `ensureIndexes` uses `createIndexes`, which never drops, so the legacy global-unique `email_1`/`phone_1` survive and go on vetoing second-role registrations with E11000 — reaching the user as "an account already exists for those details" — while the new compound indexes sit alongside them working perfectly. `db/migrations.js` → `migrateUserContactIndexes()` drops them on every boot. **No test could have caught this**: `test/helpers.js` indexes a database created seconds earlier, which has no history to be wrong about. `test/migrations.test.js` is the one place that installs the old indexes first and asserts on what follows.

**Account administration is `developer` only.** `market_owner` used to share it, which was too much authority for what that role is: a market owner is a business partner running a marketplace, not platform staff. Because the role endpoint accepts any value in `ROLES` and only blocks *self*-modification, sharing it meant any market owner could promote a second account they controlled to `developer` and inherit everything `developer` bypasses. `GET /api/users` returns `toPublicJSON()`, which carries `email` and `phone`, so it also handed them the entire customer table — the same competitor-to-competitor leak `visibilityFilter` in `routes/orders.js` was rewritten to close. Nothing is lost by narrowing it: a market owner already gets every market-scoped view they need (the stall-request queue carries each applicant's name and number, `/:id/stalls` lists their traders, `/:id/analytics` reports performance), and the client only ever rendered the user list inside `DeveloperPanel`.

**Vendor self-registration** (`/auth/vendor/register/start` → `/vendor/register/verify`) is the *same* dual-OTP flow as customer registration — both contacts required, each proved by its own code, phone-unreachable tolerated the same way — sharing an implementation (`startRegistrationChallenge`/`completeRegistration` in `routes/auth.js`). It differs only in which role the account gets and which OTP `purpose` guards it: `vendor_registration` is a distinct enum value on `OtpChallenge`, not `registration` plus a payload flag, so a code issued for a customer sign-up can never be redeemed to mint a `shopkeeper` account. The role is hardcoded in the route, never read from a body.

A vendor account created this way is inert until two separate things are true. It has no KYC record, and `middleware/vendorVerified.js` refuses every catalog write in `routes/products.js` until the bank account is verified (see Vendor KYC, below). Clearing KYC then grants writes only to **its own listings**: `Product.createdBy` is stamped from the session at creation and checked on every later write, so one vendor cannot reprice, empty or delist another's range. A null `createdBy` — seeded catalog, and anything predating the field — is administrable by `market_owner`/`developer` only; "unowned" deliberately does not mean "claimable by the first vendor to ask".

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
`sms` are separate because every real provider handles one or the other, never
both — and that split now carries real weight, since a login code reaches both
channels. A single global transport once meant configuring WhatsApp broke sign-in
for every user with an email address; keyed by channel, an unconfigured or broken
channel only affects what is addressed to it.

The `sms` channel is WhatsApp (or the console stub); the `email` channel is SMTP
via nodemailer (`services/transports/email.js`), active only when `SMTP_HOST` and
`SMTP_FROM` are set. Neither transport ever logs the code, and both mask the
destination — only the console stub prints codes, and production refuses to boot
on it.

Phone transports, via `NOTIFY_TRANSPORT`:

| Value | What it is |
|---|---|
| `console` | dev stub, prints codes; **production refuses to boot on it** |
| `whatsapp` | official Cloud API; approved template, paid per message |

There is no `OTP_CHANNEL` setting — it was removed rather than left as a knob
that can no longer change anything.

WhatsApp is a **transport, not a channel**. `OtpChallenge.channel` stays
`sms`/`email`, so the `phoneVerifiedAt` logic in `routes/auth.js` is untouched —
a code delivered over WhatsApp still verifies the phone.

**Because sign-in is passwordless, the transport is very nearly a hard
dependency**: if codes cannot be delivered, the ordinary way in stops working for
everyone. Reverse OTP (below) is the one path that survives it, because it never
sends anything — but it is opt-in per sign-in, so an outbound outage still breaks
the default flow for anyone who does not choose it.

That is why there is no longer a `whatsapp_bot` option. An unofficial WhatsApp
Web client (`server/bot/`, baileys, a second process behind a loopback bridge)
used to be a third choice — free, no Meta account, no template approval, and in
breach of WhatsApp's Terms of Service. It was removed rather than left available
with a warning: the transport IS the authentication system here, so a banned
number is not a degraded notification path, it is every user locked out at once
with no way back in. Cheap message delivery is not worth putting sign-in on an
account someone else can revoke without notice.

**Don't reintroduce it.** If Cloud API templates are too slow to approve for a
given environment, add an SMS provider — not a client that impersonates a
person's WhatsApp.

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
- **The webhook never replies to an inbound message.** Two reasons: no template
  is approved for anything but the code, and a reply inside the 24-hour service
  window can be billable — which would turn reverse OTP, whose whole point is
  costing nothing, into a paid flow.

### Reverse OTP — proving a number by receiving a message

The flow above proves someone can *receive* at a number. Reverse OTP proves they
can *send* from it: the server shows a 6-character code, the user messages it to
our inbox from their own phone, and an inbound webhook matches it. It is an
**alternative the user picks on the sign-in screen, never a replacement**, and it
covers sign-in, the registration phone leg, and phone change.

What it actually buys, stated precisely because the usual pitch overstates it:
inbound messages are free, no `AUTHENTICATION` template approval is needed, and
nothing can silently fail to deliver because nothing is delivered. It does **not**
remove the Meta dependency — the app, the WABA number and `WHATSAPP_APP_SECRET`
are all still required to receive and authenticate the webhook.

**The code is not the secret.** It is displayed on screen and travels through the
user's own messaging app. What proves the claim is that the message arrived FROM
the number being claimed; the code only decides *which* pending session an
arriving message settles, and stops an old message from settling a new login.
Two things follow. `services/reverseOtp.js` HMACs the code **without** a
per-challenge salt — unlike `services/otp.js`, which mixes the challenge id in —
because the challenge has to be found *from* the code. And hashing here is
defence in depth rather than load-bearing.

**The two channels are not equally strong, and this is surfaced rather than
buried.** WhatsApp webhooks are HMAC-signed by Meta over the raw body and the
sender is Meta's own record. The SMS relay (`POST /api/gateway/reverse-otp-sms`,
authenticated by a shared `X-Gateway-Secret`) reports whatever an Android app read
out of an SMS header, on a network where sender IDs can be forged — the secret
proves the *relay* is ours, not the sender it names. `/start` therefore returns
`assurance: 'high'` / `'low'` per channel and the UI says so. That Android relay
app is not part of this repository.

Things worth knowing:

- **Three KV keys collapse into one document.** A Redis design wants `code:`,
  `token:` and a sender index written and expired together; `ReverseOtpChallenge`
  makes them three indexes on one row, so they cannot drift and one TTL clears
  all of it. Its TTL index is declared separately from the field, for the reason
  spelled out on `OtpChallenge`.
- **Every match is a single conditional `findOneAndUpdate`,** never a read then a
  write. `verifiedAt: null` in each failure-flag filter is the whole of the
  "verified always wins" rule: once a correct send lands, a concurrent
  wrong-number message cannot paint a stale `mismatch` over it.
- **Silence is the failure mode this feature exists to avoid.** A right code from
  the wrong number sets `mismatch`; a message from a known number carrying no
  valid code sets `badCode`. Without both, a typo leaves the user watching
  "waiting" forever with nothing to act on.
- **`app` is read from the stored challenge, never the completing request.** It
  gates whether an unknown number may become an account — only the customer app
  may, exactly as at `/otp/start`.
- **Status and complete are separate calls.** `GET /status` is a plain read
  called hundreds of times per verification; minting a session from it would make
  a GET set a refresh cookie.
- **Polling is exempted from `globalLimiter`** (see `GLOBAL_LIMIT_EXEMPT`) and
  metered per token instead. At 2s for ten minutes one verification would spend a
  third of the per-IP budget, and on a shared connection — one market, one wifi —
  that locks everyone else out of the API.
- **`config` is frozen at load, so channel settings cannot be toggled per test.**
  `test/reverseOtp.test.js` sets `WHATSAPP_APP_SECRET` at the top of the file,
  before requiring `./helpers`, because `node --test` gives each file its own
  process. Setting it in `helpers.js` would flip `whatsapp.test.js`'s assertion
  that an unsigned POST is refused with 503 *because* no secret is configured.

### Vendor KYC

Holding the `shopkeeper` role no longer implies a human vetted the account, so catalog writes are gated separately. `middleware/vendorVerified.js` guards every write in `routes/products.js` and refuses unless the caller's `VendorKyc.status` is `verified`. `market_owner` and `developer` bypass it; neither sells anything.

The status is read from the database on every request, never cached in the JWT — a de-verified vendor must stop trading immediately, the same reasoning behind re-reading `role` in `middleware/auth.js`.

What is collected is a legal name, bank name, bank account number, IFSC and a UPI ID — no PAN; there is no identity-uniqueness check, only **control of the settlement account**, proven by a penny drop. Format validation shows a UPI ID is well-formed; only receiving money proves the vendor can see that account. When the provider reports a beneficiary name for the UPI ID, it must loosely match the declared legal name.

**The penny-drop amount is randomised (1–100 paise) and must be reported exactly.** A fixed ₹1 with a "did you receive it?" button would verify nothing — anyone could click yes. Only its HMAC is stored, exactly like an OTP code, so a database read does not hand over the answer. Attempts are counted atomically before comparison and the record is rejected at the cap.

The bank account number is encrypted with AES-256-GCM (`services/fieldCrypto.js`) and only ever returned masked to the last four digits.

`services/payouts.js` is a provider interface: RazorpayX when `RAZORPAYX_*` is configured, a console-logging mock otherwise. Production boot refuses the mock. Provider failures surface as **502, never the upstream status** — RazorpayX rejecting our request is our integration fault, and reporting it as a 400 would tell the vendor they typed something wrong when they did not.

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
- `db/migrations.js` — runs on **every boot**, before `ensureIndexes()`. Every migration in it must be idempotent and safe under two instances starting at once.

**Changing an index's options is a two-part change.** `ensureIndexes()` calls `createIndexes`, not `syncIndexes`, deliberately: a rollback to an older release must not delete indexes the newer one added. The cost is that an index whose *options* changed can never be rebuilt — MongoDB answers a same-name-different-options request with `IndexKeySpecsConflict` and keeps the old definition, silently. So redeclaring an index in a model changes nothing on a database that already has the old one; dropping it is a separate, named act, which is what `db/migrations.js` is for. Match the stale index on **key shape and options, not on name**, so the check stays idempotent once the replacement is built.

Watch for the failure mode this creates: the constraint that is actually in force is the *old* one, the app behaves as though the feature was never shipped, and the only evidence is a single `[db] index build failed for <Model>` line at boot. Tests will not save you either — `test/helpers.js` indexes a database created moments earlier, so it has no stale definitions to conflict with. A test for this class of bug has to install the old index itself first; `test/migrations.test.js` is the worked example.

Two more gotchas worth knowing:

- Mongoose's global `sanitizeFilter` is **deliberately not enabled** — it rewrites legitimate operator queries like `{ expiresAt: { $gt: now } }` into `$eq` comparisons and silently breaks them. Injection is blocked at the validation and sanitize layers instead.
- `middleware/errors.js` only honours `err.statusCode` for `ApiError` (or `expose === true`). Trusting arbitrary SDK errors let the Razorpay client turn its own upstream 4xx into a client-facing 4xx, misreporting an integration failure as the caller's mistake.

### Performance

- **Bundle**: `AppRouter` lazy-loads the three role apps; `App.jsx` lazy-loads the admin panels. `vite.config.js` splits vendors by change cadence (`vendor-react`, `vendor-maps`, `vendor-icons`) so a feature deploy invalidates only small app chunks. Customer first-load JS is ~121 KB gzip, down from a single 181 KB chunk.
- **Do not add Leaflet to `index.html`.** `MapLocationPicker.jsx` imports it from npm; CDN tags were a duplicate download of an already-bundled library.
- **The splash screen is CSS and SVG, and must stay that way.** It was a 1.5 MB `public/splash.mp4` that all three apps fetched and played before their first frame — the largest asset on the critical path, spent entirely on decoration. Weight was not the only problem: muted autoplay is a request a browser may refuse (iOS low-power mode, data saver, enterprise policy), and a refused video fires no event, so `SplashScreen.jsx` needed a hard timeout purely to avoid stranding users on a frozen frame. Keyframes cannot be declined. Every `.vd-splash-*` rule in `src/index.css` states the *settled* value and each keyframe animates to it, which is what makes `prefers-reduced-motion` a single `animation: none` block — put a final value only inside a `to {}` and reduced motion will render a half-built lockup.
- **Caching**: `/api` is `Cache-Control: no-store` by default because nearly every response is identity-scoped. The public catalog opts into `public, max-age=30, stale-while-revalidate=120`. Adding a public route means opting in explicitly — never widen the default.
- **Compression**: gzip above a 1 KB threshold.

### Styling

Tailwind CSS v4 via `@tailwindcss/vite`. No `tailwind.config.js` is used or needed under v4.
