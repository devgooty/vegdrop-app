# Task 3 Report: Seed global policy + Admin share-policy API

## Status

DONE

## Summary

- Added `ensureGlobalPolicy()` to seed a singleton platform policy from `config.settlement.commissionBps`.
- Added `effectivePolicyForOrder(order)` to merge the global policy with any market override.
- Added admin/developer-only `/api/admin` share-policy routes for global policy and per-market override GET/PUT/DELETE.
- Mounted `/api/admin` and seeded the global policy after `ensureIndexes()` during API boot.
- Added strict API tests for global seeding, admin authorization, invalid BPS sums, market override merge/delete, and the over-10000 partial override guard before shopkeeper rebalancing.

## Verification

- RED: `node --test server/test/sharePolicyApi.test.js` failed because `ensureGlobalPolicy` and `/api/admin` did not exist.
- GREEN: `node --test server/test/sharePolicyApi.test.js`
- Related: `node --test server/test/sharePolicyApi.test.js server/test/sharePolicyMath.test.js server/test/adminRole.test.js`
- Full: `npm test`

## Full Test Result

- `npm test`: 858 passed, 0 failed.

## Notes

- Market PUT validates `assertBpsSum(mergePolicies(global, overrideBody))`.
- When `shopkeeperBps` is omitted, override fields excluding shopkeeper are rejected if they exceed 10000 before merge rebalancing.
- `mergePolicies()` may rebalance omitted `shopkeeperBps`; this is documented where the admin route validates effective market overrides.

## Task 3 Review Fixes

- Fixed market share-policy PUT to load any existing `MarketSharePolicy`, apply the incoming body as a patch, validate `assertBpsSum(mergePolicies(global, nextOverride))`, persist that next override, and return effective policy from the saved override.
- Changed market `promosEnabled` to default to `null` and updated merge logic so both `null` and `undefined` inherit the global policy. Market PUT now accepts `promosEnabled: null` as an explicit clear-to-inherit value and does not write `true` when omitted.
- Added API regressions for a second partial market PUT that would be invalid if the previous `shopkeeperBps` remained stored, and for global promos disabled plus a market override that omits `promosEnabled`.

## Task 3 Review Test Result

- `node --test server/test/sharePolicyApi.test.js server/test/sharePolicyMath.test.js`: 11 passed, 0 failed.
