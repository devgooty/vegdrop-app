# Admin Panel — order shares & customer promos

**Date:** 2026-09-20  
**Status:** Approved for planning  
**Scope:** New `#/admin` app; `admin` role; global + per-market revenue share policy; phased customer promos (cashback → free cash → coupons → offers)

## Problem

VegDrop today has a single money knob: `STALL_COMMISSION_BPS` in env, applied at delivery by `services/settlement.js`. There is no UI to split an order across platform, shopkeeper, delivery, market owner, and a customer-incentive pool. There is also no first-class cashback, free-cash grant, coupon, or offer system — only wallet reasons `promotional_credit` and `admin_adjustment` that nothing productised yet uses.

Operators need a dedicated **Admin** surface (not a tab inside Developer Console) where both `developer` and a new `admin` role can set those shares and run promo tools. Some markets cannot run offers; policy must support a global default plus per-market overrides.

## Goals

1. Ship a sixth hash-router app at `#/admin` (`AdminApp.jsx`), lazy-loaded like the other role apps.
2. Add role `admin`; both `admin` and `developer` may open Admin and call `/api/admin/*`.
3. Replace single-rate commission with a five-bucket **basis-point** split of order gross (must sum to 10_000).
4. Resolve policy as **global ⊕ optional market override**; independent-shop orders always use global; markets may set `promosEnabled: false`.
5. Deliver promos in waves on the same app: cashback → free cash → coupons → offers.
6. Keep all money integer paise, append-only ledger, idempotent on delivery / grant keys — same invariants as wallet and settlement today.

## Non-goals

- Redesigning Developer Console analytics (`#/developer`).
- Tax / GST invoicing.
- Push notifications for every promo grant (v1).
- Letting `admin` promote accounts to `developer` or manage other admins’ roles.
- Changing handover codes, sourcing, or checkout line pricing (except applying coupon/offer discounts in later waves).
- Per-independent-shop share overrides (shops inherit global only).

## Decisions (locked with product)

| Topic | Choice |
|---|---|
| Surface | Separate app `#/admin`, not a Developer tab |
| Access | `developer` **and** new role `admin` |
| Role assignment | Only `developer` may set role to `admin` via existing `PATCH /users/:id/role` |
| Share model | Mix: order % buckets **plus** separate promo tools |
| Bucket unit | Basis points (10_000 = 100%); UI may show % |
| Policy scope | Global default **and** per-market override |
| Promo v1 ambition | Full set over waves, not day-one everything |
| Delivery approach | Policy core + Admin shell first; promo tabs hidden until their wave ships |
| Funding of customer discounts | From platform / `customerIncentive` pool — never silently from shopkeeper share |
| Migration | Seed global policy from current `STALL_COMMISSION_BPS`; old deliveries unchanged |

## Architecture

```
AppRouter (#/admin)
    └── AdminApp  (role gate: admin | developer)
            ├── Shares     → PlatformSharePolicy + MarketSharePolicy
            ├── Cashback   → rules + post-delivery credit
            ├── Free cash  → one-off wallet grants
            ├── Coupons    → codes at checkout
            └── Offers     → time-boxed campaigns

Delivery confirmed
    └── settlement / shareApply
            ├── effectivePolicy(order) = merge(global, market?)
            ├── split gross → 5 buckets (remainder on last)
            ├── shopkeeper → StallEarning (existing hold/release)
            ├── delivery / marketOwner → wallet credits when share > 0
            ├── platform → internal accounting / KPI
            └── customerIncentive → cashback rule if promos on
```

### Roles & auth

- Extend `ROLES` in `models/User.js` with `admin`.
- `APP_ROLE_SCOPE.admin` = `['admin', 'developer']` so sign-in from the Admin app resolves the right account.
- Client gate in `AdminApp` is UX only; every `/api/admin` route uses `requireAuth` + role check.
- `admin` **cannot** call role-change endpoints at all. `PATCH /users/:id/role` stays **developer-only**, and may set any role in `ROLES` including `admin` (existing self-modify block unchanged).

### Share buckets

| Key | Recipient |
|---|---|
| `platform` | Platform take (KPI / internal ledger; not a user wallet in v1) |
| `shopkeeper` | Stall or independent shop via existing settlement |
| `delivery` | Rider wallet (or earning row) for that order |
| `marketOwner` | Market owner wallet; **0** forced for independent-shop orders |
| `customerIncentive` | Pool that funds cashback / promo liability for that order |

Gross = sum of goods line totals used today for stall settlement (`sourcePricePaise` / shop pricing path). Delivery fee handling: **out of share split in v1** (unchanged fee path); document if fee later joins the pool.

### Policy documents

1. **`PlatformSharePolicy`** — singleton. Fields: five `*Bps` integers; optional default cashback rule refs; `updatedBy`, `updatedAt`.
2. **`MarketSharePolicy`** — one per market (sparse). Partial override: any missing bucket inherits global; `promosEnabled` (default true); clear-override deletes the doc or sets `useGlobal: true`.

`effectivePolicy(order)`:
- If `order.market` → load market override if any, merge onto global.
- Else → global only.
- If `promosEnabled === false`, cashback/coupons/offers short-circuit off for that order.

Validation on write: after merge, buckets sum to exactly 10_000. Reject otherwise with `400 SHARE_BPS_INVALID`.

### Settlement change

Replace `applyCommission(grossPaise)` single-rate math with `applyShareSplit(grossPaise, policy)`.

- Shopkeeper net → existing `StallEarning` create path (hold hours unchanged).
- Other positive buckets → idempotent wallet (or platform) entries keyed by `share:<bucket>:<orderId>` (and stall id where relevant).
- Replay-safe: unique indexes / existing earning uniqueness.

Env `STALL_COMMISSION_BPS` becomes **bootstrap only** for the first global policy seed; runtime reads Mongo policy. Deployed hosts without a policy row seed once at boot from that env value: `platformBps = commissionBps`, `shopkeeperBps = 10000 - platformBps`, others 0.

## Promo waves

### Wave 1 — Cashback

- Rule: percent of order (or flat) capped; funded only up to that order’s `customerIncentive` allocation.
- Fire after delivery confirmation, same moment as settlement.
- Idempotency key: `cashback:<orderId>`.
- Wallet reason: add dedicated `order_cashback` to the ledger enum (do not overload `promotional_credit`).
- Skipped when market `promosEnabled` is false or incentive bucket is 0.

### Wave 2 — Free cash

- Admin UI: look up customer by phone (scoped to customer role), amount paise, note.
- Credit wallet immediately; audit row `{ grantedBy, amountPaise, user, note }`.
- Idempotency: client-supplied or server-generated grant id unique.

### Wave 3 — Coupons

- Model: code, type (`percent` | `flat`), value, minOrderPaise, maxDiscountPaise, expiresAt, maxRedemptions, perUserLimit, optional market allow-list.
- Checkout validates against effective policy for the order’s market; reject if promos disabled.
- Discount reduces customer payment; accounting attributes funding to platform / incentive — **shopkeeper share computed on pre-discount goods gross** unless product later decides otherwise (locked: shopkeeper paid on goods gross before coupon).

### Wave 4 — Offers

- Time-boxed campaign: schedule, optional catalog/category filter, market scope or global, stacks or replaces base cashback (explicit flag).
- Market with promos off ignores offers.

UI tabs for unshipped waves are **hidden**, not stubbed.

## API (sketch)

Prefix: `/api/admin`. Auth: `admin` | `developer`.

| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/share-policy` | Global policy |
| GET/PUT/DELETE | `/markets/:id/share-policy` | Market override |
| GET/PUT | `/cashback-rules` | Wave 1 |
| POST | `/free-cash` | Wave 2 grant |
| CRUD | `/coupons` | Wave 3 |
| CRUD | `/offers` | Wave 4 |
| GET | `/audit` | Recent policy / grant changes |

Customer-facing coupon apply stays on checkout routes, not under `/admin`.

## Admin app UX

- Entry: `#/admin`; splash edition `admin`.
- Sign-in uses Admin app scope; wrong role sees a clear “use the correct app” message (same pattern as other role apps).
- Sidebar: Shares first; then Cashback / Free cash / Coupons / Offers as waves land; optional Audit.
- Shares screen: global editor with live total; market picker for override; toggle “Promos enabled”; save disabled until bps sum to 100%.

## Error handling

| Code | When |
|---|---|
| `SHARE_BPS_INVALID` | Buckets do not sum to 10_000 |
| `PROMOS_DISABLED` | Coupon/offer/cashback attempted on market with promos off |
| `POLICY_NOT_FOUND` | Misconfigured missing global (should not happen after boot seed) |
| `FORBIDDEN` | Wrong role on `/api/admin` or role elevation attempt |

Idempotent replays: 200 with existing effect, not 409, matching wallet top-up style.

## Testing

- Policy merge + validation; market clear restores global.
- Split arithmetic remainder; five buckets; independent shop forces `marketOwner = 0`.
- Settlement idempotency with new keys.
- Role matrix: admin OK on admin API; shopkeeper 403; admin cannot self-promote to developer.
- Cashback once per order; skipped when promos off; capped by incentive paise.
- Wave tests land with each wave’s plan.

## Migration & rollout

1. Add `admin` to `ROLES`; migration no-op on existing users.
2. Boot seed `PlatformSharePolicy` from `STALL_COMMISSION_BPS` if absent.
3. Ship Admin app + Shares + settlement split before any promo wave.
4. Enable Cashback → Free cash → Coupons → Offers in separate PRs/plans.

## Locked implementation choices

- **Rider share:** `RiderEarning` with the same hold-then-release pattern as `StallEarning` (reuse hold hours from settlement config). Zero share → write nothing.
- **Platform share:** explicit `PlatformEarning` (or equivalently named) row per order for audit/KPI; not derived only from subtracting other buckets at read time.
- **Market-owner share:** credit the market’s `owner` user wallet via the same hold pattern (small `OwnerEarning` or shared earning collection keyed by recipient role) — one shape for delivery and market-owner preferred over two divergent payout paths.

## Success criteria

- Operator opens `#/admin`, sets global split, overrides one market and disables promos there.
- Next delivery on that market: shopkeeper settlement uses shopkeeper bps; no cashback; other markets follow global.
- `admin` user can operate Admin; cannot become `developer` without another developer.
- Coupon/offer waves do not ship until Shares + Cashback are green in tests.
