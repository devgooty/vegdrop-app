# Catalog search-and-add + suggestion promotion

**Date:** 2026-09-12  
**Status:** Approved for planning  
**Scope:** Shopkeeper product add UX; optional promotion of custom listings into the shared catalog

## Problem

Shopkeepers today fill a full product form (name, photo, unit, category, price, stock) and optionally link a shared catalog item via a plain `<select>`. The platform already has a shared catalog (`Product` with `owner: null`) with names, images, weights, and categories. Vendors should search that catalog and add a listing from it, typing mainly price and stock. Custom add remains for items missing from the catalog; good custom listings can be promoted into the shared catalog under a reviewer-chosen section (category).

## Goals

1. Search-first add from the shared catalog, with photo, name, and unit/weight visible in results.
2. Prefill listing fields from the chosen catalog item; require price + stock; allow editing name and photo.
3. Keep a manual “custom product” path for items not in the catalog.
4. Let shopkeepers suggest an unlinked custom listing for the shared catalog.
5. Let **market owner or developer** accept (choosing category/section) or reject; on accept, create a shared catalog row and link the shopkeeper’s listing.

## Non-goals

- Turning a shop-owned listing into a shared row by clearing `owner` (breaks ownership).
- Letting shopkeepers create or edit shared catalog rows directly.
- Changing market price sheets / stall inventory flows.
- Multi-language name capture on suggestions (English `name` only on v1; `nameTe`/`nameHi` stay empty until curated later).
- Bulk import / CSV.

## Decisions (locked with product)

| Topic | Choice |
|---|---|
| After pick | Prefill; price + stock required; name/photo editable |
| Weight / category on linked add | Locked to catalog values (editing them while linked would invent a different item) |
| Missing from catalog | Manual custom form still available |
| Promotion | Suggest → review → accept creates **new** shared product; links listing |
| Section on accept | **Reviewer chooses `categoryId`** |
| Who reviews | Market owner (vendors in their markets) **or** developer (all) |

## Architecture

```
Shopkeeper                    Shared catalog                 Reviewer
───────────                   ──────────────                 ────────
Search (catalogOnly)  ──►  owner:null Products
Pick item             ──►  POST /products { catalogItem, … }
Custom add            ──►  POST /products { no catalogItem }
Suggest               ──►  CatalogSuggestion (pending)  ──►  queue
Accept { categoryId } ──►  create owner:null Product
                      ──►  listing.catalogItem = shared._id
```

Reuse existing product create/patch and `assertLinkableCatalogItem`. Add a small `CatalogSuggestion` collection and routes; do not overload `Product` status fields.

## Shopkeeper UX

### Add product (primary)

1. Products list → **Add product** opens **search**, not a blank form.
2. Search shared catalog (`GET /api/products?catalogOnly=true&search=…`). Show photo, name, weight, category.
3. Exclude items this shop already lists under the same `catalogItem` (client filter from `mine` list; optional later server `excludeOwned`).
4. Empty query: short browse (first page / by category chips using existing categories).
5. Pick → confirm form prefilled: `name`, `image`, `weight`, `categoryId`, `catalogItem`. Fields: price, stock (required); name, image (editable). Weight and category read-only while linked.
6. Save → existing `POST /api/products` with shopkeeper ownership + `catalogItem`.

### Custom add

- Link on search screen: **Add something not in the list**.
- Same form as today without forced link; `catalogItem` omitted.
- After save (and on edit of an unlinked listing): **Suggest for shared catalog**.

### Suggest

- Available only when `catalogItem` is null and listing is owned by the caller.
- Creates `CatalogSuggestion` with a **snapshot** of name, image, weight at submit time (later listing edits do not mutate the pending review).
- One pending suggestion per listing (unique partial index).
- UI shows pending / accepted / rejected on that product card.

## Reviewer UX

### Queue

- **Market owner panel:** new “Catalog suggestions” section (alongside stall requests pattern). Scoped to shopkeepers with an approved stall in that owner’s markets.
- **Developer panel:** same queue, unscoped (all pending).
- Card: snapshot photo, name, weight, shop name/phone, submittedAt; actions Accept / Reject.

### Accept

- Modal/step: **choose category/section** (required `categoryId` from existing category list).
- Server (one transaction when available):
  1. Re-read suggestion `pending` and listing still owned, still `catalogItem: null`, still exists.
  2. Create shared `Product`: `owner: null`, `createdBy: reviewer`, snapshot name/image/weight, reviewer `categoryId`, generated sku, `stock: 0`, `pricePaise: 0` (or listing’s price as display seed — prefer **0** so markets/shops set their own; shop listing keeps its price).
  3. Set listing `catalogItem` to new shared id (do not overwrite shopkeeper name/image/price/stock).
  4. Mark suggestion `accepted`, set `sharedProduct`, `reviewedBy`, `reviewedAt`.
- Shared item then appears under that section for other vendors’ search-and-add.

### Reject

- Optional short reason; status `rejected`. Listing stays sellable and unlinked. Shopkeeper may suggest again only after reject (new suggestion) or after editing — allow new suggest once no pending exists.

## Data model: `CatalogSuggestion`

```
listing          ObjectId → Product   required
shopkeeper       ObjectId → User      required
name             String               snapshot
image            String               snapshot
weight           String               snapshot
status           enum pending|accepted|rejected
rejectReason     String?              maxlength ~300
reviewedBy       ObjectId? → User
reviewedAt       Date?
sharedProduct    ObjectId? → Product  set on accept
marketIds        [ObjectId]           denormalised at submit from approved stalls (for market-owner scoping)
createdAt / updatedAt
```

Indexes:

- `{ listing: 1 }` unique where `status: 'pending'` (partial)
- `{ status: 1, createdAt: -1 }`
- `{ shopkeeper: 1, createdAt: -1 }`
- `{ marketIds: 1, status: 1 }` for owner queue

## API

| Method | Path | Who | Notes |
|---|---|---|---|
| `POST` | `/api/catalog-suggestions` | shopkeeper | body `{ listingId }`; server snapshots fields |
| `GET` | `/api/catalog-suggestions` | shopkeeper / market_owner / developer | query `status`; scope by role |
| `POST` | `/api/catalog-suggestions/:id/accept` | market_owner, developer | body `{ categoryId }` strict |
| `POST` | `/api/catalog-suggestions/:id/reject` | market_owner, developer | body `{ reason? }` |

Mount under existing auth + role middleware. Market owner accept/reject must verify suggestion’s `marketIds` intersects markets they own; developer bypasses.

No change required to product POST schema for search-add beyond what already exists (`catalogItem` optional).

## Client changes (high level)

- `ShopkeeperPanel`: replace blank add entry with search screen; keep custom form; suggest CTA on unlinked products.
- `MarketOwnerPanel` + `Developer` admin surface: suggestion queue UI mirroring stall-request approve/reject.
- `src/services/…`: thin API helpers for suggestions.

## Error handling

| Case | Behaviour |
|---|---|
| Suggest on linked listing | 400 |
| Suggest while pending exists | 409 |
| Suggest on someone else’s listing | 403 / 404 |
| Accept already reviewed | 409 |
| Accept but listing deleted / linked / wrong owner | 409 with clear code |
| Market owner outside their markets | 403 |
| Missing categoryId on accept | 400 validation |

KYC / `vendorVerified` still gates catalog writes as today.

## Testing

- Unit/API: suggest happy path; duplicate pending; accept creates shared + links; reject; market-owner scope; developer unscoped; accept race after link.
- Client: not required for v1 beyond manual check; prefer server tests as contract.

## Rollout

- Feature is additive; no migration of existing products.
- Existing unlinked listings gain Suggest; existing linked listings unchanged.
- Shared catalog search already supported via `catalogOnly`.

## Open implementation notes (not product questions)

- Shared product `pricePaise: 0` and `stock: 0` on accept — markets use MarketPrice; independent shops set their own listing price (already on the source listing).
- Copy `image` URL as-is (same uploaded asset); no re-upload.
- Weight stays free-text string consistent with Product.
- Do not expose suggestion queue on customer or delivery apps.
