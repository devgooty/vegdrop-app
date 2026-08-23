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
- **`DEV_LOGIN=1` serves `GET /api/auth/dev/login?phone=…`, which mints a session with nothing proved.** It is the only sign-in bypass in the codebase and exists so a local demo can be opened in any browser without reading a code out of the console. `server/scripts/dev-with-memory-db.js` sets it; `npm run server` does not.

  It is guarded on **two independent facts, because NODE_ENV is not trustworthy here**. `config.devLoginEnabled` requires the flag AND a non-production `NODE_ENV` AND the absence of any deploy marker (`RAILWAY_ENVIRONMENT`, `VERCEL`, `RENDER`, …); setting the flag alongside either signal is a **boot-time fatal**. The route is not merely disabled when off — it is never registered, so there is no handler to reach.

  The deploy-marker half is not belt-and-braces, it is the load-bearing one. `NODE_ENV` is set by whoever configured the host, so it is a claim about the environment rather than a fact about it — a deployment can be serving real traffic with it unset or wrong, and every guard keyed only on `isProduction` is then silently inert. The platform markers are injected by the platform itself and cannot be forgotten, so *being deployed* is what this check actually tests. Treat any other "production refuses to boot" rule in this file as conditional on `NODE_ENV` genuinely being right on the host; verify it there rather than assuming.

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

**A code goes to the phone and nowhere else.** It was copied to a verified email for a while, and that was removed deliberately: once a code reaches a mailbox, whoever reads that mailbox can sign in, so account security became the **weaker** of the two channels. The case it insured against — a number the transport cannot reach — is covered properly by reverse OTP, which proves the number instead of routing around it.

What went with it: `POST /api/auth/email/start` and `/verify`, the `email_change` OTP purpose, `User.emailVerifiedAt`, and the email branch of `notify.sendOtp`.

**Dropping the field needed a migration, not just a schema edit.** `db/migrations.js` → `migrateDroppedEmailVerification()` unsets `emailVerifiedAt` on every boot. Mongoose will not write an undeclared field, but it will not remove one either, so every account predating the change would have gone on carrying a timestamp asserting that someone proved an address — through a flow that no longer exists. `test/migrations.test.js` writes through the raw collection to reproduce that state, because the field can no longer be created through the model. The email **transport** is untouched and still live — `routes/markets.js` sends stall approval and suspension notices through `sendNotice`. It is codes that no longer go there.

**`PATCH /api/users/:id` accepts `email` again; it still refuses `phone`.** The address was refused while codes were delivered to it, because any address a session could set was a way in: a briefly-stolen session could point it at the attacker and receive every future code. Nothing is delivered there now, so setting one grants nothing — it is where a stall notice goes. `phone` stays out, because it IS the credential; changing it goes through `POST /api/auth/phone/start`, which proves the new number first.

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

**Registration proves the phone, and asks for nothing else but a name.** It used to prove two contacts, and the email leg was the *required* one — so an account could be created having proved only an address, which inverted the model: the credential of record was the contact nobody demonstrated control of.

**No email is collected at sign-up, sign-in, or anywhere in `LoginPage`.** An account is created without one. An address is attached later from the profile, through `PATCH /api/users/:id`, by anyone who wants the stall notices in `routes/markets.js` — which in practice means shopkeepers, though nothing enforces that and customers may add one too. Optional for everyone, asked of no one.

`POST /register/verify` takes either an outbound code pair or a reverse-OTP `phoneToken`, **exactly one, never neither**; there is no longer a shape of that request that mints an account without a proved number, and so no more `pendingPhone` for new accounts.

**Vendor self-registration** (`/auth/vendor/register/start` → `/vendor/register/verify`) is the *same* flow as customer registration — phone proved, nothing else asked, phone-unreachable falling through to reverse OTP the same way — sharing an implementation (`startRegistrationChallenge`/`completeRegistration` in `routes/auth.js`). It differs only in which role the account gets and which OTP `purpose` guards it: `vendor_registration` is a distinct enum value on `OtpChallenge`, not `registration` plus a payload flag, so a code issued for a customer sign-up can never be redeemed to mint a `shopkeeper` account. The role is hardcoded in the route, never read from a body.

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
both. A single global transport once meant configuring WhatsApp broke delivery
for everything addressed to an inbox; keyed by channel, an unconfigured or broken
channel only affects what is addressed to it. Codes go to `sms` only — `email`
now carries stall notices and nothing else.

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
`assurance: 'high'` / `'low'` per channel and the UI says so.

That Android relay app is not part of this repository and should not become one.
An off-the-shelf forwarder already satisfies the contract, and the endpoint
assumes nothing about the relay beyond the shared secret precisely so that stays
true. `docs/sms-relay-setup.md` names the app and the exact rule to configure —
including the SIM-slot and text filters, which are together the only thing
keeping the relay handset's personal SMS off our server, and which both default
to off.

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

### Sourcing — which seller fills an order

Two different things are called a shop here, and only one of them is ranked the same way.

**Market stalls.** `services/sourcing.js` → `planRound()` ranks every open, approved stall in a market against the lines still needing a taker: **coverage first** (a stall holding four of five items beats one holding a single item, because an order split across fewer stalls is one a rider can actually collect), then `activeLoad`, then stall number for determinism. Greedy set cover, capped at `maxStallsPerOrder`. Stalls with `autoAccept` and declared `StallInventory` are claimed for outright; the rest are offered and a human taps accept. Runs from `checkout.js` the moment a market order is placed.

**Independent shops** get the same idea and none of the same machinery, because an order placed with one is **all-or-nothing** — `checkout.js` refuses a basket whose lines are not all owned by that shop (`MIXED_SELLERS`). So there is nothing to split and no cascade; `POST /api/shops/nearby/coverage` simply ranks nearby shops by how much of the basket each holds, and only a shop that holds **all** of it can be ordered from. Distance is the last tiebreak, not the first: a nearer shop that cannot complete the order cannot be ordered from at all.

Things that are easy to get wrong here:

- **`Product.catalogItem` is what makes "the same item" mean anything across shops.** Each shop's listings are its own rows and `sku` is globally unique, so Ravi's tomatoes and Anand's tomatoes share nothing but a word. A shop-owned row points at the `owner: null` catalog row it is an instance of; a shared row's stays null because it already IS that item. **Nothing at runtime matches on names.** `migrateProductCatalogItem` does, once, to backfill — and leaves anything ambiguous or unmatched null rather than guessing, because a wrong link advertises produce a shop does not have and routes an order it cannot fill. It logs what it left unlinked; those listings are invisible to coverage until a vendor links them, which is why the vendor form says so.
- **A listing with no `catalogItem` is invisible to basket coverage** but perfectly visible to someone already browsing that shop. That is the intended shape, not a bug.
- **The basket is held as catalog items and translated at checkout.** `catalogKeyOf()` in `App.jsx` is the single definition of what a cart line is — a shop listing, a weight variant (`<catalogId>-500g`) and a plain catalog row all resolve through it. The coverage response carries a `catalogItem → this shop's productId` mapping, re-fetched at checkout rather than reused from the shop card, because the basket can change after a shop is picked. This is why `checkout.js` needed no change at all.
- **Choosing a shop no longer empties the basket, and that reversal has a condition.** It used to, because a basket named one seller's rows. It now carries over *only when the shop can fill it*, and every line is re-priced from that shop's own price — the original objection ("would show one price and charge another") is answered rather than dropped. A shop that cannot fill the basket still clears it.
- **The seed creates no shop-owned listings**, so independent-shop coverage has nothing to rank on a fresh database. `scripts/dev-with-memory-db.js` seeds three demo shops at 5/5, 4/5 and 3/5 — deliberately with the best-stocked one furthest away, so "ranked by coverage" cannot be mistaken for "ranked by distance". It lives there rather than in `utils/seed.js` because that seeder also runs at real boots and has the `remove-demo-seed` contract built around exactly what it creates.

  **This rule has been broken once, and the consequences were live.** The Developer Console work added `seedDemoOrdersAndData()` — nine paid orders, a wallet ledger, and a `VendorKyc` marked `verified` — straight into `seedIfEmpty`, guarded on `Order.countDocuments() === 0`. "Only seeds an empty database" is the condition a *launching production database* satisfies, and the outer `isProduction` guard was inert because the Railway host had no `NODE_ENV` set. The proof was one line in the production log: `[seed] created demo rider bank details.` It is now behind its own export, called only from `dev-with-memory-db.js`, and `test/seedDeployGuard.test.js` asserts the shared seeder fabricates no orders, no ledger and no verified KYC.

  The demo-seed guard therefore asks `config.isProduction || config.isDeployed`, not `isProduction` alone — same reasoning as `DEV_LOGIN`, and for the same reason it is the `isDeployed` half that is load-bearing. **Any new rule of the form "this must not happen on a real server" belongs on `isDeployed`.** `NODE_ENV` is a claim the host makes; a platform marker is a fact about it.

### Money

**All amounts are integer paise on the server** (`pricePaise`, `amountPaise`, `totalAmountPaise`). Rupees exist only at the API boundary and as presentation virtuals. Floats invite rounding drift that surfaces as unreconcilable balances.

**A quantity is a whole number of the seller's packs, and the client may only ever show a price the server will reach on its own.** `src/services/packs.mjs` is the single definition; the eight cases in `server/test/packs.test.js` are a billing contract, not a formatting one.

The rule exists because the product cards used to break it. They offered 250g/500g/750g/1kg on every product, priced the choice by dividing the pack price into a per-kilo rate, and sent none of it anywhere: checkout posts `{ productId, quantity }` and the server recomputes each line from the catalog. So the order was billed as ONE pack whatever was picked — a 250g spinach pack shown as "1kg — ₹140" was charged ₹35 and the stall was told to pack 250g. A 1kg lettuce pack shown as "250g — ₹9" was charged ₹35.

Three things follow, and each has already been got wrong:

- **Sending the weight would not have fixed it.** The server would still have to price it, and a stall cannot split a pack it bought whole. `units` is a count of packs; `quantity: line.quantity * unitsOf(line)` is what goes on the wire, in `handleCheckout` and in `catalogBasket` both — coverage has to count in the same packs checkout will, or a shop holding one pack reads as covering a line asking for four.
- **Prices are multiplied, never divided and multiplied back.** `Math.round(12 / 0.1 * 0.25)` is 30 against a true 3. `packOptions` multiplies the pack price, which is exactly the arithmetic the server does.
- **A weight in brackets after a count is not a weight.** `packGrams` matches a bare weight only, so "1 pc (approx 600g)" and "1 bunch (approx 100g)" get no size picker. The old test was `weight.includes('g') && !weight.includes('pack')`, which most of the catalog passes — that is how a single cauliflower came to be sold by the quarter-kilo, and how a bunch of coriander was priced ten times over on first paint.

**`catalogKeyOf` and `cartLineKeyOf` answer different questions and are not interchangeable.** The first is "which item is this", and is right for coverage and checkout, where a shop's listing and the catalog row it instantiates are the same produce. The second adds the size, and is what decides whether two basket lines are one row. Matching the basket on `catalogKeyOf` alone folded 1kg into an existing 250g line and dropped the choice without saying so. `handleAddToCart`, `mergeCartLines` and `handleUpdateQuantity` all have to agree, and they only do if they ask the same question.

`packs.mjs` is the only `.mjs` under `src/`, deliberately: `package.json` is `"type": "commonjs"` for the server, so Node reads a `.js` there as CommonJS and could not import it to test it. Vite resolves either extension.

Wallet balance is derived from an append-only `WalletTransaction` ledger — never a mutable field. Crediting is idempotent through a unique `idempotencyKey` (`razorpay:<paymentId>`), so a replayed verification collides on the index instead of double-crediting.

Order totals are **always recomputed server-side** from the catalog. Request bodies carry only product ids and quantities; `.strict()` zod schemas reject any attempt to include `totalAmountPaise`, `status`, or `paymentStatus`.

Payment verification checks three independent things: HMAC signature, that the `PaymentIntent` belongs to *this* user, and (with live credentials) that Razorpay itself reports the payment captured for the recorded amount. A signature alone proves a payment is real, not that it is yours.

### Scheduled orders are locked off

Standing orders ship **disabled**, at the owner's request. `SCHEDULED_ORDERS_UNLOCK=1` on the API is the only switch; `config.scheduledOrdersLocked` defaults to locked, so a missing config file cannot re-enable the feature.

**A hidden tab is not a lock, and that is the whole point of where the checks are.** `services/scheduler.js` places standing orders from the sweeper on a timer, with no UI involved — so hiding the Scheduled Deliveries tab while leaving that running would keep debiting wallets on a schedule and remove the only screen that can pause or cancel it. The lock therefore lives in three places, and the UI is the least important of them:

- `routes/schedules.js` — `POST /` refuses with `403 SCHEDULES_LOCKED`, before validation or any write.
- `services/scheduler.js` — `runDueSchedules()` returns early. Rows stay `active` and untouched rather than being paused, so unlocking needs no migration; nothing fires for the locked period because anything that falls outside `GRACE_MS` is handled by the same overdue branch that covers the server having been down.
- `CustomerOrders.jsx` — the tab renders with a padlock and is not selectable.

**`GET`, `PATCH` and `DELETE` stay open deliberately.** Locking must never strand someone holding a standing order they can no longer look at or cancel; only *creating* one is refused.

The client learns the state from `features` on the session payload (`featureFlags()` in `services/authSession.js`), not from a constant of its own — two copies of one truth is how a screen ends up offering what the API then refuses. `isFeatureEnabled` answers **false for anything it has not been told about**, so a locked feature cannot flicker into view before the first refresh lands.

`test/schedules.test.js` sets `SCHEDULED_ORDERS_UNLOCK=1` at the top of the file, before requiring `./helpers`, for the reason spelled out on `test/reverseOtp.test.js`. Those tests describe machinery that has to keep working for the day the lock comes off; they are not a claim that it is switched on. `test/schedulesLocked.test.js` is the one that asserts the default.

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
- **The splash screen is CSS and SVG, and must stay that way.** It was a 1.5 MB `public/splash.mp4` that all three apps fetched and played before their first frame — the largest asset on the critical path, spent entirely on decoration. Weight was not the only problem: muted autoplay is a request a browser may refuse (iOS low-power mode, data saver, enterprise policy), and a refused video fires no event, so `SplashScreen.jsx` needed a hard timeout purely to avoid stranding users on a frozen frame. Keyframes cannot be declined. Every `.vd-splash-*` rule in `src/index.css` states the *settled* value and each keyframe animates to it, which is what makes `prefers-reduced-motion` a single `animation: none` block — put a final value only inside a `to {}` and reduced motion will render a half-built lockup. The `.vd-splash-handoff` keyframes are the one documented exception: they run *outward*, away from the settled value, and they can only because they apply while the screen is leaving.
- **The launch screen hands a piece of its lockup to the screen that follows, rather than cutting to it.** Two handoffs, both in `src/lib/brandFlight.js`: the **wordmark** to the customer login screen, and the **droplet** to the shop's header badge. In each case both ends draw the same thing — same face, weight and tracking for the logotype; the same `VegDropMark` component for the droplet — so redrawing it at a new size and place would read as two screens that happen to share a logo. Instead the splash takes the lockup apart around the piece being carried, publishes where it was standing, and the arriving screen flies its own copy from there into place (FLIP, through the Web Animations API). Deliberately **not** `document.startViewTransition` — see the reasoning at the top of `brandFlight.js`.

  Things that are easy to get wrong here:

  - **The rect is published at the END of the splash's exit, not the start.** The home exit *moves* what it hands over: closing the plate lets the centred lockup row re-centre, which walks the droplet back to the middle of the screen. Measuring first would name a place it has since left.
  - **The flight measures a different element than it animates, on the home side.** What is published is a bare droplet; the badge is a squircle *around* one, at about two thirds the width. `options.measure` takes the size from the glyph while the badge is what moves — sound only because the two are concentric. The login side has the mirror-image trap: measuring `.si-hero-wordmark` would measure the hero's full width, so an inline-block `.si-hero-wordmark-text` wrapper exists purely to be the thing measured.
  - **The badge is drawn in layers so it can arrive undressed.** `.vd-home-mark-shell` sits *behind* the mark rather than wrapping it, which is what lets the squircle fade in over a droplet that is already fully drawn. Wrapping it would mean fading the mark too.
  - **Each exit is opt-in per launch and has to name the right screen** (`handoff`), because each ends on one bare element and only the screen expecting it has anywhere to put it. `HEADER_TABS` in `App.jsx` is part of that: three of the tabs render no header, so they have no badge to catch anything.
  - **The exit keyframes run outward**, away from the settled value — the one documented exception to the base-state invariant above, allowed because they apply only while the screen is leaving. Reduced motion declines both handoffs in JS and takes the plain fade, because a flight between two measured boxes has no resting value a stylesheet could fall back to.
  - Only the customer login has a wordmark in the DOM; the shopkeeper and delivery heroes have theirs painted into the artwork, so those apps keep the plain fade.
- **Caching**: `/api` is `Cache-Control: no-store` by default because nearly every response is identity-scoped. The public catalog opts into `public, max-age=30, stale-while-revalidate=120`. Adding a public route means opting in explicitly — never widen the default.
- **Compression**: gzip above a 1 KB threshold.

### Styling

Tailwind CSS v4 via `@tailwindcss/vite`. No `tailwind.config.js` is used or needed under v4.
