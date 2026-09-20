# Final whole-branch review — Wave 0 Admin Panel Shares

- Base: `8358c7b816da3a888a3186432915f1d84ca36ca5`
- Head: `457a8b16e3079863ebcccbc19725aff9c4094e2b`
- Scope: `#/admin` app (admin+developer), `admin` role, global + per-market share policy, five-bucket settlement split, Shares UI. Promo waves out of scope.
- Reviewer: manual whole-branch review. **CodeRabbit CLI was not run** — it is unavailable in this environment (native Windows PowerShell, no WSL/bash to run the `curl | sh` installer). Findings below are from a manual read of the diff and the actual source against the spec/plan. Test results (868/868) are as reported by the task reports; they were not independently re-executed this session.

## Strengths

- **Paise conservation is exact and proven.** `splitGrossPaise` floors the first four buckets and lands the remainder on the last, and `allocateShopkeeperAcrossStalls` mirrors that per-stall; both keep the "sum equals gross" invariant. Matches the codebase's "sum paise, divide once" rule.
- **Idempotency is layered, as the money rules demand.** Unique indexes on `PlatformEarning{order}`, `SharePayout{order,bucket}`, `OrderIncentive{order}`, plus `createIgnoringDuplicate` (swallows 11000) and wallet idempotency keys (`share-payout:<id>`). A replayed `recordDelivery` writes nothing new.
- **The retry/policy-drift guard is genuinely thoughtful.** `amountsAgreeWithExisting` refuses to finish a partially-written settlement if a live policy edit landed between a crash and its retry, rather than committing a split that would not sum to gross. This is the kind of failure the rest of the file leans on being impossible.
- **The commission source-of-truth fix is correct and consistent.** `routes/developer.js` KPI and `routes/markets.js /analytics` now read `PlatformEarning.amountPaise`, not `StallEarning.commissionPaise`. This is exactly right: `commissionPaise` is everything withheld from the seller (platform + delivery + market owner + incentive), so summing it double-counts the rider's and owner's own shares the instant either bps > 0. CLAUDE.md was updated to state this as the single source of truth.
- **`forceNoMarketOwner` folds the market-owner bucket into platform for shop orders** rather than silently dropping that share of gross.
- **Server-authoritative and locked down.** `/api/admin/*` is gated `requireRole('admin','developer')`; bodies are `.strict()` zod with int bps 0–10000; account administration (`PATCH /users/:id/role`) stays `['developer']`-only, so the new `admin` role cannot escalate. `GET /admin/markets` returns id+name only.
- **`OrderIncentive.promosEnabled` snapshots the flag at settlement**, so a later policy change cannot rewrite history — the pattern the cashback wave will depend on.
- **Circular dependency handled deliberately** (`PlatformSharePolicy` → `sharePolicy` at top for `assertBpsSum`; `sharePolicy` lazy-requires the models), with a comment explaining why.
- **Frontend integrates cleanly with existing conventions.** Lazy-loaded `#/admin` route, role-gated shell, admin never joins the 5s order poll (per CLAUDE.md), login copy makes admin a provisioned-only (never self-registered) role. UI converts %↔bps, shows live totals, and disables Save unless the effective total is exactly 100%.

## Critical issues

None found. The money math conserves paise, settlement is idempotent, and authorization is correct.

## Important issues

1. **Singleton `PlatformSharePolicy` has no uniqueness guarantee — concurrent first-boot can create two global-policy documents.** Both `ensureGlobalPolicy()` and `PUT /admin/share-policy` write via `findOneAndUpdate({}, …, { upsert: true })` against an empty filter, and the model has no unique index constraining the collection to one row. If two API instances boot against a fresh database simultaneously (a rolling deploy — CLAUDE.md explicitly requires migrations/boot to be "safe under two instances starting at once"), both `$setOnInsert` upserts can insert, after which `findOne()` reads a nondeterministic singleton. The window is narrow (first-ever boot only; steady state is stable), but the fix is one line — a fixed `_id` sentinel or a unique index on a constant discriminator — and closes it entirely. Recommend fixing before merge or as an immediate fast-follow.

## Minor issues

1. **The flooring remainder is parked on `customerIncentive`, which is never paid out this wave.** In `splitGrossPaise`, the last bucket (`customerIncentivePaise`) absorbs the rounding remainder (up to ~4 paise/order). Consequence: with `customerIncentiveBps = 0` an order can still accrue a nonzero incentive amount, and those paise are withheld from real recipients into an unpaid pool. Paise-scale and harmless to reconciliation, but semantically the remainder would sit better on `platform` (a pure audit bucket) than on the one bucket that pays nobody yet.
2. **The bps-sum invariant is only enforced in the model's `pre('validate')` hook, which does not fire on the `findOneAndUpdate` write paths the routes use** (and `runValidators` runs field validators, not document middleware). The routes compensate by calling `assertBpsSum` explicitly, so there is no live bug — but the DB-layer invariant is effectively route-enforced, a latent footgun for any future writer that updates a policy without the explicit assert.
3. **A partial/empty market PUT persists an all-null override row** (`nextMarketOverride` fills missing fields with `null`), i.e. a stored document that means "inherit everything." Harmless (Clear removes it, and merge treats null as inherit) but slightly wasteful — an all-null override could be treated as a delete.
4. **`SplashScreen edition="admin"` falls through to the customer brand line** (only `shopkeeper`/`delivery` are special-cased). Cosmetic and consistent with the developer edition's behavior; noted only for completeness.

## Overall assessment

**Ready to merge**, with the singleton-uniqueness hardening (Important #1) recommended as a one-line fix before merge or an immediate fast-follow. The core deliverable — a five-bucket, policy-driven settlement split — is correct, paise-exact, idempotent, and properly authorized, and the commission double-count fix and its documentation are exactly aligned with the codebase's stated money invariants. Spec/plan coverage is complete: `admin` role + scope, global/market policy CRUD, five bps buckets summing to 10000, `promosEnabled` per market, the four new earning rows, developer-only role assignment, and env-as-bootstrap-seed. The Minor items are polish, not blockers.

## Fix note — Important #1 (singleton uniqueness)

**Change:** Added required unique `scope: 'global'` on `PlatformSharePolicy` (string `_id` is awkward under Mongoose ObjectId casting). `ensureGlobalPolicy()` and `PUT /api/admin/share-policy` now upsert on `{ scope: 'global' }` instead of `{}`. Boot migration `migratePlatformSharePolicySingleton()` backfills `scope`, keeps the newest canonical row, and deletes duplicate legacy rows.

**Tests:** `node --test server/test/sharePolicyApi.test.js` — 9/9 pass (includes new `ensureGlobalPolicy is idempotent under repeated upsert` asserting `countDocuments() === 1` after parallel upserts).
