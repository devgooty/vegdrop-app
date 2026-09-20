# Admin Panel Shares (Wave 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `#/admin` as a separate app for `admin` + `developer`, with global and per-market order share policies that drive settlement splits (platform / shopkeeper / delivery / market owner / customer incentive).

**Architecture:** New `admin` role and `APP_ROLE_SCOPE.admin`. Mongo singleton `PlatformSharePolicy` plus optional `MarketSharePolicy`. Pure helpers merge policies and split paise. `settlement.recordDelivery` reads effective policy, pays shopkeepers via existing `StallEarning`, and records other buckets on new earning models. Admin React app at `#/admin` edits policies only in this wave — cashback / free cash / coupons / offers are **follow-up plans**, tabs stay hidden.

**Tech Stack:** Express + Mongoose (CommonJS), Zod `.strict()`, React + Vite, `node --test` + mongodb-memory-server, existing wallet ledger.

**Spec:** `docs/superpowers/specs/2026-09-20-admin-panel-shares-design.md`

**Out of this plan (separate plans later):** Wave 1 cashback, Wave 2 free cash, Wave 3 coupons, Wave 4 offers.

## Global Constraints

- All money: integer paise; never floats in arithmetic.
- Share buckets are basis points summing to exactly `10000`.
- Runtime settlement reads Mongo policy, not `STALL_COMMISSION_BPS` (env is bootstrap seed only).
- Independent-shop orders force `marketOwner` allocation to `0` (fold that bps into `platform` at apply time so totals still match).
- Shopkeeper paid on **pre-coupon goods gross** (no coupons in this wave).
- Delivery fee is **outside** the share split.
- Idempotent delivery recording; unique keys / existing earning uniqueness.
- `/api/admin/*` requires role `admin` or `developer`.
- `PATCH /users/:id/role` remains developer-only; may set `admin`.
- Never prefix secrets with `VITE_`.
- Follow `ApiError`, `requireAuth`/`requireRole`, `validate({…}).strict()`, `fields.objectId`.

## File map

| File | Responsibility |
|---|---|
| `server/models/User.js` | Add `admin` to `ROLES` |
| `server/services/authSession.js` | `APP_ROLE_SCOPE.admin` |
| `server/routes/auth.js` | Zod `app` enum includes `admin` |
| `server/models/PlatformSharePolicy.js` | Global singleton policy |
| `server/models/MarketSharePolicy.js` | Per-market override |
| `server/models/PlatformEarning.js` | Per-order platform bucket row |
| `server/models/SharePayout.js` | Delivery / market-owner hold-then-release |
| `server/models/OrderIncentive.js` | Customer-incentive accounting (no wallet yet) |
| `server/services/sharePolicy.js` | Load, merge, validate, seed, split math |
| `server/services/settlement.js` | Use share split instead of `applyCommission` |
| `server/routes/admin.js` | Share-policy CRUD |
| `server/app.js` | Mount `/api/admin` |
| `server/index.js` or boot path | Ensure global policy seeded after migrations |
| `server/test/sharePolicy.test.js` | Pure merge/split + API policy tests |
| `server/test/settlementShares.test.js` | Delivery uses policy buckets |
| `src/AdminApp.jsx` | Role-gated admin shell |
| `src/AppRouter.jsx` | Route `#/admin` |
| `src/components/adminApp/*` | Layout, Shares view (new tree — do not overload Developer `AdminLayout`) |
| `src/services/admin.js` | Client API helpers |
| `src/components/LoginPage.jsx` | `admin` appType copy |

---

### Task 1: `admin` role + auth scope

**Files:**
- Modify: `server/models/User.js` (`ROLES`)
- Modify: `server/services/authSession.js` (`APP_ROLE_SCOPE`)
- Modify: `server/routes/auth.js` (zod `app` enums — every `z.enum([…])` that lists apps)
- Test: `server/test/adminRole.test.js`

**Interfaces:**
- Produces: `ROLES` includes `'admin'`; `APP_ROLE_SCOPE.admin === ['admin', 'developer']`

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  authenticatedUser,
  createUser,
} = require('./helpers');
const { APP_ROLE_SCOPE } = require('../services/authSession');
const { ROLES } = require('../models/User');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

test('ROLES and APP_ROLE_SCOPE include admin', () => {
  assert.ok(ROLES.includes('admin'));
  assert.deepEqual(APP_ROLE_SCOPE.admin, ['admin', 'developer']);
});

test('admin can restore a session; shopkeeper cannot hit a future admin gate pattern', async () => {
  const admin = await authenticatedUser('admin');
  const me = await api('GET', '/api/auth/me', { token: admin.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
});

test('developer can promote a customer to admin', async () => {
  const dev = await authenticatedUser('developer');
  const { user } = await createUser({ role: 'customer' });
  const res = await api('PATCH', `/api/users/${user._id}/role`, {
    token: dev.accessToken,
    body: { role: 'admin' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
});

test('admin cannot change roles', async () => {
  const admin = await authenticatedUser('admin');
  const { user } = await createUser({ role: 'customer' });
  const res = await api('PATCH', `/api/users/${user._id}/role`, {
    token: admin.accessToken,
    body: { role: 'shopkeeper' },
  });
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/adminRole.test.js`  
Expected: FAIL — `admin` not in `ROLES` / scope

- [ ] **Step 3: Minimal implementation**

In `server/models/User.js`:
```js
const ROLES = Object.freeze([
  'customer', 'delivery', 'shopkeeper', 'market_owner', 'developer', 'admin',
]);
```

In `server/services/authSession.js`:
```js
const APP_ROLE_SCOPE = Object.freeze({
  customer: ['customer', 'market_owner', 'developer'],
  shopkeeper: ['shopkeeper'],
  delivery: ['delivery'],
  developer: ['developer'],
  market_owner: ['market_owner'],
  admin: ['admin', 'developer'],
});
```

In `server/routes/auth.js`, extend every `z.enum(['customer', 'shopkeeper', 'delivery', 'developer', 'market_owner'])` for `app` to include `'admin'`.

Confirm `requireRole('developer')` on `PATCH /users/:id/role` already blocks `admin` (no code change if already developer-only).

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test server/test/adminRole.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/models/User.js server/services/authSession.js server/routes/auth.js server/test/adminRole.test.js
git commit -m "Add admin role and Admin app auth scope"
```

---

### Task 2: Share policy models + pure split helpers

**Files:**
- Create: `server/models/PlatformSharePolicy.js`
- Create: `server/models/MarketSharePolicy.js`
- Create: `server/services/sharePolicy.js`
- Test: `server/test/sharePolicyMath.test.js`

**Interfaces:**
- Produces:
  - `BUCKETS = ['platform','shopkeeper','delivery','marketOwner','customerIncentive']`
  - `assertBpsSum(policy) → void` throws `ApiError` `SHARE_BPS_INVALID`
  - `mergePolicies(global, marketOverride|null) → { platformBps, shopkeeperBps, deliveryBps, marketOwnerBps, customerIncentiveBps, promosEnabled }`
  - `splitGrossPaise(grossPaise, policy) → { platformPaise, shopkeeperPaise, deliveryPaise, marketOwnerPaise, customerIncentivePaise }`
  - `allocateShopkeeperAcrossStalls(stallGrosses[], shopkeeperPaise) → number[]` (same length; remainder on last)
  - `forceNoMarketOwner(policy) → policy` (moves `marketOwnerBps` into `platformBps` for shop orders)

- [ ] **Step 1: Write the failing math tests**

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergePolicies,
  splitGrossPaise,
  allocateShopkeeperAcrossStalls,
  forceNoMarketOwner,
  assertBpsSum,
} = require('../services/sharePolicy');

const global = {
  platformBps: 1000,
  shopkeeperBps: 7000,
  deliveryBps: 1000,
  marketOwnerBps: 500,
  customerIncentiveBps: 500,
  promosEnabled: true,
};

test('merge fills missing market fields from global', () => {
  const m = mergePolicies(global, { deliveryBps: 1500, promosEnabled: false });
  assert.equal(m.deliveryBps, 1500);
  assert.equal(m.platformBps, 1000);
  assert.equal(m.promosEnabled, false);
  assertBpsSum(m);
});

test('splitGrossPaise sums to gross and puts remainder on last bucket', () => {
  const s = splitGrossPaise(10001, global);
  const sum =
    s.platformPaise +
    s.shopkeeperPaise +
    s.deliveryPaise +
    s.marketOwnerPaise +
    s.customerIncentivePaise;
  assert.equal(sum, 10001);
});

test('allocateShopkeeperAcrossStalls preserves total', () => {
  const parts = allocateShopkeeperAcrossStalls([3000, 7000], 7000);
  assert.equal(parts.reduce((a, b) => a + b, 0), 7000);
});

test('forceNoMarketOwner folds marketOwner into platform', () => {
  const p = forceNoMarketOwner(global);
  assert.equal(p.marketOwnerBps, 0);
  assert.equal(p.platformBps, 1500);
  assertBpsSum(p);
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `node --test server/test/sharePolicyMath.test.js`

- [ ] **Step 3: Implement models + `sharePolicy.js`**

`PlatformSharePolicy` fields: five `*Bps` (int 0–10000), `updatedBy` ObjectId, timestamps. Enforce sum via pre-validate.

`MarketSharePolicy` fields: `market` unique ObjectId; each `*Bps` optional (null = inherit); `promosEnabled` Boolean default true; `updatedBy`.

`splitGrossPaise`: for each bucket except last, `Math.floor(gross * bps / 10000)`; last bucket = `gross - sumOthers`.

`allocateShopkeeperAcrossStalls`: proportional floors; last stall gets remainder.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/models/PlatformSharePolicy.js server/models/MarketSharePolicy.js server/services/sharePolicy.js server/test/sharePolicyMath.test.js
git commit -m "Add share policy models and split math"
```

---

### Task 3: Seed global policy + Admin share-policy API

**Files:**
- Modify: `server/services/sharePolicy.js` — `ensureGlobalPolicy()`, `effectivePolicyForOrder(order)`
- Create: `server/routes/admin.js`
- Modify: `server/app.js` — mount `/api/admin`
- Modify: boot (`server/index.js` after `ensureIndexes`) — `await sharePolicy.ensureGlobalPolicy()`
- Test: `server/test/sharePolicyApi.test.js`

**Interfaces:**
- Produces:
  - `GET/PUT /api/admin/share-policy`
  - `GET/PUT/DELETE /api/admin/markets/:id/share-policy`
  - `ensureGlobalPolicy()` seeds from `config.settlement.commissionBps` when missing: `platformBps = commissionBps`, `shopkeeperBps = 10000 - platformBps`, others `0`, `promosEnabled: true`

- [ ] **Step 1: Write failing API tests**

```js
test('ensureGlobalPolicy seeds from commissionBps', async () => {
  await sharePolicy.ensureGlobalPolicy();
  const g = await PlatformSharePolicy.findOne().lean();
  assert.ok(g);
  assert.equal(g.platformBps + g.shopkeeperBps + g.deliveryBps + g.marketOwnerBps + g.customerIncentiveBps, 10000);
});

test('admin can PUT global policy; shopkeeper cannot', async () => {
  const admin = await authenticatedUser('admin');
  const ok = await api('PUT', '/api/admin/share-policy', {
    token: admin.accessToken,
    body: {
      platformBps: 800,
      shopkeeperBps: 7200,
      deliveryBps: 1000,
      marketOwnerBps: 500,
      customerIncentiveBps: 500,
    },
  });
  assert.equal(ok.status, 200);

  const shop = await authenticatedUser('shopkeeper');
  const no = await api('GET', '/api/admin/share-policy', { token: shop.accessToken });
  assert.equal(no.status, 403);
});

test('PUT rejecting bad sum returns SHARE_BPS_INVALID', async () => {
  const admin = await authenticatedUser('admin');
  const res = await api('PUT', '/api/admin/share-policy', {
    token: admin.accessToken,
    body: {
      platformBps: 1000,
      shopkeeperBps: 1000,
      deliveryBps: 1000,
      marketOwnerBps: 1000,
      customerIncentiveBps: 1000,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SHARE_BPS_INVALID');
});

test('market override merge + DELETE restores global-only', async () => {
  await sharePolicy.ensureGlobalPolicy();
  const admin = await authenticatedUser('admin');
  const owner = await authenticatedUser('market_owner');
  const market = await Market.create({
    name: 'Override Market',
    slug: `mkt-${Date.now()}`,
    address: 'Hyd',
    owner: owner.user._id,
    location: { type: 'Point', coordinates: [78.4, 17.3] },
  });

  const put = await api('PUT', `/api/admin/markets/${market._id}/share-policy`, {
    token: admin.accessToken,
    body: { promosEnabled: false, deliveryBps: 2000 },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.policy.promosEnabled, false);

  const effective = await sharePolicy.effectivePolicyForOrder({ market: market._id });
  assert.equal(effective.promosEnabled, false);
  assert.equal(effective.deliveryBps, 2000);
  assert.equal(
    effective.platformBps +
      effective.shopkeeperBps +
      effective.deliveryBps +
      effective.marketOwnerBps +
      effective.customerIncentiveBps,
    10000
  );

  const del = await api('DELETE', `/api/admin/markets/${market._id}/share-policy`, {
    token: admin.accessToken,
  });
  assert.equal(del.status, 200);
  const after = await MarketSharePolicy.findOne({ market: market._id });
  assert.equal(after, null);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement routes**

```js
// server/routes/admin.js — sketch
router.use(requireAuth, requireRole('admin', 'developer'));

router.get('/share-policy', async (req, res) => {
  await sharePolicy.ensureGlobalPolicy();
  const doc = await PlatformSharePolicy.findOne();
  res.json({ policy: doc });
});

router.put(
  '/share-policy',
  validate({ body: sharePolicyBodySchema }), // all five bps required, .strict()
  async (req, res) => {
    assertBpsSum(req.body);
    const doc = await PlatformSharePolicy.findOneAndUpdate(
      {},
      { $set: { ...req.body, updatedBy: req.user._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ policy: doc });
  }
);
// markets/:id/share-policy similarly; DELETE removes MarketSharePolicy
```

Mount: `app.use('/api/admin', adminRoutes);`

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.js server/app.js server/index.js server/services/sharePolicy.js server/test/sharePolicyApi.test.js
git commit -m "Add admin share-policy API and global policy seed"
```

---

### Task 4: Earning models for non-shopkeeper buckets

**Files:**
- Create: `server/models/PlatformEarning.js`
- Create: `server/models/SharePayout.js`
- Create: `server/models/OrderIncentive.js`
- Test: exercised in Task 5

**Interfaces:**
- `PlatformEarning`: `{ order unique, orderNumber, market?, amountPaise, earnedAt }`
- `SharePayout`: `{ order, bucket: 'delivery'|'marketOwner', recipient User, amountPaise, status pending|released, earnedAt, releaseAt, releasedAt, walletTransaction, unique (order, bucket) }`
- `OrderIncentive`: `{ order unique, amountPaise, promosEnabled, earnedAt }` — accounting only until cashback wave

- [ ] **Step 1: Create the three models** with paise integer validators mirroring `StallEarning`.

- [ ] **Step 2: Commit**

```bash
git add server/models/PlatformEarning.js server/models/SharePayout.js server/models/OrderIncentive.js
git commit -m "Add platform, share-payout, and incentive earning models"
```

---

### Task 5: Settlement uses share policy

**Files:**
- Modify: `server/services/settlement.js`
- Modify: `server/services/sweeper.js` (or settlement release loop) to release `SharePayout` like `StallEarning`
- Modify: `server/routes/developer.js` KPI — sum `PlatformEarning.amountPaise` for `platformCommission` (keep field name for UI, or add `platformShare` and map in client — prefer keep `platformCommission` meaning platform bucket)
- Test: `server/test/settlementShares.test.js`
- Keep existing `server/test/settlement.test.js` green (seed default policy in `resetDatabase` or `startTestServer` via `ensureGlobalPolicy`)

**Interfaces:**
- Consumes: `sharePolicy.effectivePolicyForOrder(order)`, `splitGrossPaise`, `allocateShopkeeperAcrossStalls`, `forceNoMarketOwner`
- Changes: `applyCommission` removed or thin-wrapped; `recordMarketDelivery` / `recordShopDelivery` write all buckets

**Algorithm (market order):**
1. `policy = effectivePolicyForOrder(order)`
2. `stallShares = splitByStall(order)`; `G = sum gross`
3. `amounts = splitGrossPaise(G, policy)`
4. `shopParts = allocateShopkeeperAcrossStalls(stallGrosses, amounts.shopkeeperPaise)`
5. For each stall: create `StallEarning` with `grossPaise = stallGross`, `netPaise = shopParts[i]`, `commissionPaise = stallGross - netPaise` (withheld from seller — not only platform)
6. If `amounts.platformPaise > 0`: create `PlatformEarning` (ignore duplicate key)
7. If `amounts.deliveryPaise > 0` and order has assigned rider: `SharePayout` bucket `delivery`
8. If `amounts.marketOwnerPaise > 0`: resolve market.owner → `SharePayout` bucket `marketOwner`
9. Always upsert `OrderIncentive` with `amounts.customerIncentivePaise` and `promosEnabled`

**Shop order:** `policy = forceNoMarketOwner(effective…)`; one stall-equivalent shop earning; no marketOwner payout.

**Release:** extend settlement release sweep to credit `SharePayout` wallets with idempotency `share-payout:<payoutId>`, reason `admin_adjustment` is wrong — add wallet reasons `delivery_settlement` and `market_owner_settlement` to `WalletTransaction.reason` enum in this task.

- [ ] **Step 1: Write failing settlement share tests**

```js
test('market delivery splits per global policy', async () => {
  await sharePolicy.ensureGlobalPolicy();
  await PlatformSharePolicy.updateOne({}, {
    platformBps: 1000,
    shopkeeperBps: 7000,
    deliveryBps: 1000,
    marketOwnerBps: 500,
    customerIncentiveBps: 500,
  });
  // place + deliver order using existing settlement.test helpers
  // assert StallEarning net ≈ 70% of goods gross
  // assert PlatformEarning, SharePayout×2, OrderIncentive exist
  // assert re-calling recordDelivery does not duplicate
});

test('market with promosEnabled false still splits money; incentive row records flag', async () => {
  // PUT market override promosEnabled false; deliver; OrderIncentive.promosEnabled === false
});

test('shop order forces marketOwner paise into platform', async () => {
  // policy with marketOwnerBps > 0; shop delivery; no SharePayout marketOwner; platform includes that share
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement settlement + wallet reasons + sweeper release for SharePayout**

- [ ] **Step 4: Run `node --test server/test/settlementShares.test.js server/test/settlement.test.js` — PASS**

- [ ] **Step 5: Update developer KPI aggregation to use PlatformEarning; adjust `developerConsoleData.test.js` if it asserts commission from StallEarning only**

- [ ] **Step 6: Commit**

```bash
git add server/services/settlement.js server/services/sweeper.js server/models/WalletTransaction.js server/routes/developer.js server/test/settlementShares.test.js server/test/helpers.js server/test/developerConsoleData.test.js
git commit -m "Settle orders using share policy buckets"
```

---

### Task 6: Admin app shell (`#/admin`)

**Files:**
- Create: `src/AdminApp.jsx`
- Create: `src/components/adminApp/AdminAppLayout.jsx`
- Create: `src/components/adminApp/SharesView.jsx` (placeholder “loading policies…” OK until Task 7 wires API)
- Modify: `src/AppRouter.jsx`
- Modify: `src/components/LoginPage.jsx` — `SIGN_UP.admin` + unknown-account message
- Modify: `src/components/SplashScreen.jsx` only if edition list needs an `admin` label (reuse developer styling if editions are a fixed map — add `admin` entry mirroring developer)

**Interfaces:**
- `AdminApp` `allowedRoles: ['admin','developer']`, `appType="admin"`, `storagePrefix="vegdrop_admin_"`
- Router: `hash.startsWith('/admin') → 'admin'`

- [ ] **Step 1: Implement AdminApp + router branch** (mirror `DeveloperApp.jsx`)

```jsx
const ADMIN_ROLES = ['admin', 'developer'];
// LoginPage appType="admin"
// AdminAppLayout with sidebar item Shares only
```

- [ ] **Step 2: Manual check** — `npm run dev`, open `/#/admin`, sign in as developer, see Shares nav.

- [ ] **Step 3: Commit**

```bash
git add src/AdminApp.jsx src/AppRouter.jsx src/components/adminApp src/components/LoginPage.jsx src/components/SplashScreen.jsx
git commit -m "Add #/admin app shell for admin and developer"
```

---

### Task 7: Shares UI wired to API

**Files:**
- Create: `src/services/admin.js`
- Modify: `src/components/adminApp/SharesView.jsx`
- Modify: `src/components/adminApp/AdminAppLayout.jsx` if needed

**Interfaces:**
- `fetchSharePolicy()`, `saveSharePolicy(body)`, `fetchMarketSharePolicy(id)`, `saveMarketSharePolicy(id, body)`, `clearMarketSharePolicy(id)`
- UI: five numeric % inputs (convert ↔ bps ×100); live total; disable Save unless total === 100; market `<select>` of markets from existing markets list endpoint the developer already uses (or `GET /api/markets` if permitted — if not, add `GET /api/admin/markets` thin list in this task)

- [ ] **Step 1: If admin cannot list markets, add `GET /api/admin/markets` returning `{ id, name }[]` for all markets (admin|developer).**

- [ ] **Step 2: Build SharesView**
  - Load global on mount
  - Toggle “Edit market override” → pick market → load override or empty inherit
  - `promosEnabled` checkbox on market form
  - Save / Clear override buttons

- [ ] **Step 3: Smoke** — save global 10/70/10/5/5; set one market promos off; confirm GET

- [ ] **Step 4: Commit**

```bash
git add src/services/admin.js src/components/adminApp/SharesView.jsx server/routes/admin.js
git commit -m "Wire Admin Shares screen to share-policy API"
```

---

### Task 8: Docs touch-up + full test pass

**Files:**
- Modify: `CLAUDE.md` — Architecture “Five entry apps” → six; note `#/admin` and share policy vs `STALL_COMMISSION_BPS`
- Run: `npm test` (or at least settlement + admin + sharePolicy suites)

- [ ] **Step 1: Update CLAUDE.md briefly** (apps list + settlement reads Mongo share policy)

- [ ] **Step 2: Run full server tests; fix fallout**

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document Admin app and share-policy settlement"
```

---

## Follow-up plans (do not implement here)

1. **Wave 1 — Cashback:** credit `order_cashback` from `OrderIncentive` after delivery when `promosEnabled`.
2. **Wave 2 — Free cash:** `POST /api/admin/free-cash`.
3. **Wave 3 — Coupons:** checkout integration; funding from platform/incentive.
4. **Wave 4 — Offers:** campaigns + market scope.

---

## Spec coverage checklist

| Spec item | Task |
|---|---|
| `#/admin` app | 6 |
| `admin` role + both roles access | 1, 6 |
| Global + market policy | 2, 3, 7 |
| Five bps buckets sum 10000 | 2, 3 |
| `promosEnabled` per market | 3, 7 |
| Settlement split | 5 |
| Platform / delivery / market owner / incentive rows | 4, 5 |
| Seed from `STALL_COMMISSION_BPS` | 3 |
| Developer-only role assign | 1 |
| Promo waves | Out of plan (follow-ups) |
