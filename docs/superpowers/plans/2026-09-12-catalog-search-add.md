# Catalog Search-and-Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let shopkeepers add catalogue listings by searching the shared platform catalog (prefilled photo/name/unit), keep a custom-add path, and let market owners or developers promote suggested custom listings into the shared catalog under a reviewer-chosen category.

**Architecture:** Reuse `POST /api/products` with `catalogItem` for search-add. Add a `CatalogSuggestion` collection + `/api/catalog-suggestions` routes for suggest/list/accept/reject. Accept creates a new `owner: null` Product and links the shopkeeper listing — never clears `owner` on the listing. Shopkeeper UI becomes search-first; MarketOwnerPanel and Developer AdminLayout get a review queue.

**Tech Stack:** Express + Mongoose (CommonJS server), Zod `.strict()` validation, `withTransaction`, React + Vite shopkeeper/market-owner/developer UIs, `node --test` + mongodb-memory-server.

**Spec:** `docs/superpowers/specs/2026-09-12-catalog-search-add-design.md`

## Global Constraints

- All amounts on shared Product rows created by accept: `pricePaise: 0`, `stock: 0`.
- Snapshot suggestion fields at submit; do not live-read listing name/image/weight on accept.
- Reviewer chooses `categoryId` on accept (required).
- One pending suggestion per listing (partial unique index).
- Market owner scope: suggestion `marketIds` must intersect markets they own; developer sees all.
- Do not clear `owner` on shop listings to “promote” them.
- Never prefix secrets with `VITE_`.
- Follow existing patterns: `ApiError`, `requireAuth`/`requireRole`, `validate({…}).strict()`, `fields.objectId` from `server/middleware/validate.js`.

## File map

| File | Responsibility |
|---|---|
| `server/models/CatalogSuggestion.js` | Suggestion schema + indexes |
| `server/routes/catalogSuggestions.js` | POST/GET/accept/reject |
| `server/app.js` | Mount `/api/catalog-suggestions` |
| `server/test/catalogSuggestions.test.js` | API contract tests |
| `src/services/catalogSuggestions.js` | Client API helpers |
| `src/components/ShopkeeperPanel.jsx` | Search-first add + suggest CTA |
| `src/components/MarketOwnerPanel.jsx` | Review tab |
| `src/components/admin/views/CatalogSuggestionsView.jsx` | Developer queue |
| `src/components/admin/Sidebar.jsx` + `AdminLayout.jsx` | Nav + render |

---

### Task 1: CatalogSuggestion model

**Files:**
- Create: `server/models/CatalogSuggestion.js`
- Test: covered by Task 2+ (model exercised via API)

**Interfaces:**
- Produces: mongoose model `CatalogSuggestion` with fields from the spec; `toJSON` virtual `id`

- [ ] **Step 1: Create the model**

```js
'use strict';

const mongoose = require('mongoose');

const STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);

const catalogSuggestionSchema = new mongoose.Schema(
  {
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    shopkeeper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    image: { type: String, default: '', maxlength: 2000 },
    weight: { type: String, default: '', maxlength: 60 },
    status: {
      type: String,
      enum: STATUSES,
      default: 'pending',
      required: true,
      index: true,
    },
    rejectReason: { type: String, default: null, maxlength: 300 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    sharedProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    marketIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Market' }],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

catalogSuggestionSchema.index(
  { listing: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
catalogSuggestionSchema.index({ status: 1, createdAt: -1 });
catalogSuggestionSchema.index({ shopkeeper: 1, createdAt: -1 });
catalogSuggestionSchema.index({ marketIds: 1, status: 1 });

catalogSuggestionSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

module.exports = mongoose.model('CatalogSuggestion', catalogSuggestionSchema);
module.exports.STATUSES = STATUSES;
```

- [ ] **Step 2: Commit**

```bash
git add server/models/CatalogSuggestion.js
git commit -m "Add CatalogSuggestion model for shared-catalog promotion"
```

---

### Task 2: POST suggest + route mount

**Files:**
- Create: `server/routes/catalogSuggestions.js` (POST `/` first)
- Modify: `server/app.js` — `require` + `app.use('/api/catalog-suggestions', …)` next to products
- Create: `server/test/catalogSuggestions.test.js`
- Test: `server/test/catalogSuggestions.test.js`

**Interfaces:**
- Consumes: `CatalogSuggestion`, `Product`, `Stall`, `requireAuth`, `requireRole`, `requireVerifiedVendor`, `validate`, `fields`, `ApiError`
- Produces: `POST /api/catalog-suggestions` body `{ listingId }` → `{ data: suggestionJson }`

- [ ] **Step 1: Write failing tests**

In `server/test/catalogSuggestions.test.js`, mirror `catalogOwnership.test.js` helpers (`verifiedVendor`, `listProduct`, `uniq`). Cover:

```js
test('shopkeeper can suggest an unlinked listing', async () => { /* 201, status pending, snapshot name */ });
test('cannot suggest a linked listing', async () => { /* 400 ALREADY_LINKED or VALIDATION */ });
test('cannot suggest someone else’s listing', async () => { /* 404 or 403 */ });
test('second pending suggest for same listing is 409', async () => { /* 409 */ });
```

For linked case: create shared product (`owner: null`), create listing with `catalogItem`, then POST suggest.

- [ ] **Step 2: Run tests — expect FAIL (route missing)**

```bash
node --test server/test/catalogSuggestions.test.js
```

Expected: connection errors or 404 on `/api/catalog-suggestions`.

- [ ] **Step 3: Implement POST + mount**

`server/routes/catalogSuggestions.js` skeleton:

```js
'use strict';

const express = require('express');
const { z } = require('zod');
const CatalogSuggestion = require('../models/CatalogSuggestion');
const Product = require('../models/Product');
const Stall = require('../models/Stall');
const Market = require('../models/Market');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireVerifiedVendor } = require('../middleware/vendorVerified');
const { validate, fields } = require('../middleware/validate');
const { ApiError } = require('../middleware/errors');
const { withTransaction } = require('../db/connect');

const router = express.Router();

function publicSuggestion(doc) {
  return typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
}

router.post(
  '/',
  requireAuth,
  requireRole('shopkeeper'),
  requireVerifiedVendor,
  validate({
    body: z.object({ listingId: fields.objectId }).strict(),
  }),
  async (req, res) => {
    const listing = await Product.findById(req.valid.body.listingId);
    if (!listing || !listing.owner || String(listing.owner) !== String(req.user._id)) {
      throw new ApiError(404, 'Listing not found.', 'NOT_FOUND');
    }
    if (listing.catalogItem) {
      throw new ApiError(400, 'That listing is already linked to the shared catalog.', 'ALREADY_LINKED');
    }

    const stalls = await Stall.find({
      owner: req.user._id,
      status: 'approved',
    })
      .select('market')
      .lean();
    const marketIds = [...new Set(stalls.map((s) => String(s.market)))].map(
      (id) => new (require('mongoose').Types.ObjectId)(id)
    );

    try {
      const suggestion = await CatalogSuggestion.create({
        listing: listing._id,
        shopkeeper: req.user._id,
        name: listing.name,
        image: listing.image || '',
        weight: listing.weight || '',
        status: 'pending',
        marketIds,
      });
      return res.status(201).json({ data: publicSuggestion(suggestion) });
    } catch (err) {
      if (err && err.code === 11000) {
        throw new ApiError(409, 'A suggestion is already pending for this listing.', 'SUGGESTION_PENDING');
      }
      throw err;
    }
  }
);

module.exports = router;
```

Mount in `server/app.js`:

```js
const catalogSuggestionRoutes = require('./routes/catalogSuggestions');
// …
app.use('/api/catalog-suggestions', catalogSuggestionRoutes);
```

- [ ] **Step 4: Run tests — expect PASS for Task 2 cases**

```bash
node --test server/test/catalogSuggestions.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/models/CatalogSuggestion.js server/routes/catalogSuggestions.js server/app.js server/test/catalogSuggestions.test.js
git commit -m "Allow shopkeepers to suggest custom listings for the shared catalog"
```

---

### Task 3: GET list (role-scoped)

**Files:**
- Modify: `server/routes/catalogSuggestions.js`
- Modify: `server/test/catalogSuggestions.test.js`

**Interfaces:**
- Produces: `GET /api/catalog-suggestions?status=pending` → `{ data: Suggestion[] }`
  - shopkeeper: own only
  - developer: all
  - market_owner: `marketIds` intersects owned markets

- [ ] **Step 1: Write failing tests**

```js
test('shopkeeper sees only their suggestions', async () => { /* … */ });
test('developer sees all pending suggestions', async () => { /* … */ });
test('market owner sees suggestions from traders in their markets only', async () => {
  // seedOwnedMarket + seedTrader pattern from marketAdmin.test.js
  // vendor with approved stall in market A suggests
  // other owner’s market must not see it; owner of A does
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement GET**

```js
router.get(
  '/',
  requireAuth,
  requireRole('shopkeeper', 'market_owner', 'developer'),
  validate({
    query: z
      .object({
        status: z.enum(['pending', 'accepted', 'rejected']).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const filter = {};
    if (req.valid.query.status) filter.status = req.valid.query.status;

    if (req.user.role === 'shopkeeper') {
      filter.shopkeeper = req.user._id;
    } else if (req.user.role === 'market_owner') {
      const markets = await Market.find({ owner: req.user._id }).select('_id').lean();
      filter.marketIds = { $in: markets.map((m) => m._id) };
    }
    // developer: no extra filter

    const rows = await CatalogSuggestion.find(filter).sort({ createdAt: -1 }).limit(200);
    return res.json({ data: rows.map(publicSuggestion) });
  }
);
```

Populate shopkeeper name/phone for reviewers optionally via `.populate('shopkeeper', 'name phone')` — include in `publicSuggestion` if populated.

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "Scope catalog suggestion lists by shopkeeper, market owner, and developer"
```

---

### Task 4: Accept and reject

**Files:**
- Modify: `server/routes/catalogSuggestions.js`
- Modify: `server/test/catalogSuggestions.test.js`

**Interfaces:**
- Consumes: suggestion id, `{ categoryId }` on accept, `{ reason? }` on reject
- Produces: accepted → shared Product (`owner: null`, `pricePaise: 0`, `stock: 0`) + listing.catalogItem set; rejected → status rejected

Helper for reviewer access:

```js
async function assertCanReview(suggestion, user) {
  if (user.role === 'developer') return;
  if (user.role !== 'market_owner') {
    throw new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN');
  }
  const markets = await Market.find({ owner: user._id }).select('_id').lean();
  const owned = new Set(markets.map((m) => String(m._id)));
  const hit = (suggestion.marketIds || []).some((id) => owned.has(String(id)));
  if (!hit) {
    throw new ApiError(403, 'That suggestion is outside your markets.', 'FORBIDDEN');
  }
}

function sharedSku(name) {
  const slug = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ITEM';
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CAT-${slug}-${suffix}`;
}
```

Accept body: `z.object({ categoryId: z.number().int() }).strict()`  
Reject body: `z.object({ reason: z.string().trim().max(300).optional() }).strict()`

Accept algorithm inside `withTransaction`:

1. `findOneAndUpdate({ _id, status: 'pending' }, …)` only after creating product — or: load pending, `assertCanReview`, load listing, verify `owner === suggestion.shopkeeper` and `catalogItem == null`, else `409 LISTING_NOT_ELIGIBLE`.
2. `Product.create([{ owner: null, createdBy: reviewer, sku, categoryId, name: suggestion.name, image: suggestion.image, weight: suggestion.weight, pricePaise: 0, stock: 0 }], { session })`
3. `Product.updateOne({ _id: listing._id, catalogItem: null }, { $set: { catalogItem: shared._id } }, { session })` — if modifiedCount 0 → abort with 409.
4. Update suggestion to accepted with `sharedProduct`, `reviewedBy`, `reviewedAt`.

- [ ] **Step 1: Write failing tests**

```js
test('accept creates shared product, links listing, marks accepted', async () => {
  // assert shared.owner null, shared.categoryId === chosen, listing.catalogItem === shared.id
  // listing.pricePaise unchanged
});
test('accept requires categoryId', async () => { /* 400 */ });
test('reject marks rejected and leaves listing unlinked', async () => { /* … */ });
test('market owner cannot accept outside their markets', async () => { /* 403 */ });
test('accept fails if listing already linked', async () => { /* 409 */ });
test('shopkeeper cannot accept', async () => { /* 403 */ });
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement accept/reject routes**

- [ ] **Step 4: Run — PASS**

```bash
node --test server/test/catalogSuggestions.test.js
```

- [ ] **Step 5: Commit**

```bash
git commit -m "Let market owners and developers accept or reject catalog suggestions"
```

---

### Task 5: Client API service

**Files:**
- Create: `src/services/catalogSuggestions.js`

**Interfaces:**
- Produces:
  - `createCatalogSuggestion(listingId)` → suggestion
  - `fetchCatalogSuggestions({ status }?)` → array
  - `acceptCatalogSuggestion(id, { categoryId })` → suggestion
  - `rejectCatalogSuggestion(id, { reason }?)` → suggestion

- [ ] **Step 1: Implement**

```js
import { api } from './apiClient';

export async function createCatalogSuggestion(listingId) {
  const result = await api.post('/catalog-suggestions', { listingId });
  return result.data;
}

export async function fetchCatalogSuggestions(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  const q = params.toString();
  const result = await api.get(`/catalog-suggestions${q ? `?${q}` : ''}`);
  return result.data;
}

export async function acceptCatalogSuggestion(id, { categoryId }) {
  const result = await api.post(`/catalog-suggestions/${id}/accept`, { categoryId });
  return result.data;
}

export async function rejectCatalogSuggestion(id, { reason } = {}) {
  const result = await api.post(`/catalog-suggestions/${id}/reject`, {
    ...(reason ? { reason } : {}),
  });
  return result.data;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/catalogSuggestions.js
git commit -m "Add client helpers for catalog suggestions"
```

---

### Task 6: Shopkeeper search-first add UI

**Files:**
- Modify: `src/components/ShopkeeperPanel.jsx`

**Interfaces:**
- Consumes: `fetchProducts({ catalogOnly, search, limit })`, `createProduct` via existing `onAddProduct`
- New screens: `search-catalog` → `add-from-catalog` (confirm) or `add-product` (custom)

- [ ] **Step 1: Change add entry**

Where the list screen navigates to add (find the button that sets `activeScreen` to `'add-product'`), set `'search-catalog'` instead.

- [ ] **Step 2: Add search screen**

State: `catalogSearch` string, reuse `catalogItems` fetch or re-fetch with `search` on debounce (~250ms). Filter out ids already present as `product.catalogItem` in `products`.

Render rows: image thumb, name, weight, category title from `categories`. Tap → set form from item:

```js
setProductForm({
  name: item.name,
  categoryId: item.categoryId,
  price: '',
  weight: item.weight || '1 Kg',
  stock: '',
  image: item.image || '',
  catalogItem: item.id,
});
setActiveScreen('add-from-catalog');
```

Footer link: **Add something not in the list** → `setProductForm(initialProductState); setActiveScreen('add-product');`

- [ ] **Step 3: Confirm form for `add-from-catalog`**

Reuse most of the existing add form UI with these differences:

- Weight + category controls disabled / read-only
- Hide the old Catalog Item `<select>` (already linked)
- Title: “Add from catalog”
- Save calls same `handleAddProduct` (already sends `catalogItem`)

Keep `add-product` custom form as today (no forced link); can remove or keep the optional catalog select — prefer **remove** from custom path to avoid confusion (custom = unlinked until suggest/accept).

- [ ] **Step 4: Manual smoke**

With `npm run server` + `npm run dev`, as verified shopkeeper: search tomato → add with price/stock → appears in list linked.

- [ ] **Step 5: Commit**

```bash
git commit -m "Make shopkeeper product add search the shared catalog first"
```

---

### Task 7: Suggest CTA on shopkeeper listings

**Files:**
- Modify: `src/components/ShopkeeperPanel.jsx`

**Interfaces:**
- Consumes: `createCatalogSuggestion`, `fetchCatalogSuggestions`
- UI: on product card when `!product.catalogItem`, show Suggest / Pending / Rejected / Accepted badge

- [ ] **Step 1: Load own suggestions when products tab active**

```js
const [suggestionsByListing, setSuggestionsByListing] = useState({});
// map listingId -> latest suggestion
```

Fetch on mount/products refresh; index by `String(s.listing)`.

- [ ] **Step 2: Card actions**

If no suggestion or rejected: button **Suggest for catalog** → `createCatalogSuggestion(product.id)` then refresh map.  
If pending: badge “Suggested — waiting”.  
If accepted: badge “In shared catalog” (and `catalogItem` should now be set after refresh products).

- [ ] **Step 3: Commit**

```bash
git commit -m "Let shopkeepers suggest unlinked listings for the shared catalog"
```

---

### Task 8: Reviewer queues (market owner + developer)

**Files:**
- Modify: `src/components/MarketOwnerPanel.jsx` — new tab `catalog` / “Catalog”
- Create: `src/components/admin/views/CatalogSuggestionsView.jsx`
- Modify: `src/components/admin/Sidebar.jsx` — nav item `{ id: 'catalog-suggestions', label: 'Catalog suggestions', icon: Package }`
- Modify: `src/components/admin/AdminLayout.jsx` — case + label

**Interfaces:**
- Consumes: `fetchCatalogSuggestions({ status: 'pending' })`, `acceptCatalogSuggestion`, `rejectCatalogSuggestion`, `initialCategories` / `categories` for accept picker

- [ ] **Step 1: Shared review list component pattern**

Each card: image, name, weight, shopkeeper name/phone if populated, Accept / Reject.

Accept flow: prompt/select `categoryId` from categories (`import { initialCategories } from '../data/mockData'` or prop), then call accept, remove from list.

Reject: optional `window.prompt` or small inline reason, then reject.

- [ ] **Step 2: MarketOwnerPanel tab**

Add to tab bar next to requests. On select, fetch pending. Market owner API already scopes.

- [ ] **Step 3: Developer CatalogSuggestionsView**

Wire into AdminLayout like other views.

- [ ] **Step 4: Commit**

```bash
git commit -m "Add catalog suggestion review queues for market owners and developers"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full suggestion tests**

```bash
node --test server/test/catalogSuggestions.test.js
```

Expected: all PASS.

- [ ] **Step 2: Run related product tests**

```bash
node --test server/test/catalogOwnership.test.js server/test/shops.test.js
```

Expected: PASS (no regressions on product create/link).

- [ ] **Step 3: Spec coverage check**

Confirm: search-add UI, custom add, suggest, accept with category, reject, market-owner scope, developer scope — all implemented.

- [ ] **Step 4: Final commit if any fixups remain**

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Search-first add, prefill, price/stock, editable name/photo | 6 |
| Weight/category locked when linked | 6 |
| Custom add path | 6 |
| Suggest unlinked only, snapshot, one pending | 2 |
| GET scoped lists | 3 |
| Accept creates shared + links; reviewer category | 4 |
| Reject with optional reason | 4 |
| Market owner + developer review UI | 8 |
| Client service | 5 |
| API tests | 2–4, 9 |

No TBD placeholders. Types/names consistent: `listingId`, `categoryId`, `CatalogSuggestion`, routes under `/api/catalog-suggestions`.
