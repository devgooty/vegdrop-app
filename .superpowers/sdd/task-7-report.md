# Task 7 Report: Shares UI wired to API

**Status:** Complete.

**Commit:** `Wire Admin Shares screen to share-policy API` (hash reported in final handoff).

**What changed:** Added `src/services/admin.js` with helpers for global share policy, market share policy overrides, clearing overrides, and admin market listing. Replaced `SharesView.jsx` placeholder with global and market override forms: five percentage inputs, bps conversion, live totals, save disabled unless the effective total is exactly 100%, market picker, market `promosEnabled` toggle, and clear override. Added `GET /api/admin/markets` returning `{ id, name }[]` for admin/developer users.

**Verification:** `node --test server/test/sharePolicyApi.test.js` passed (8/8). `npm run build` passed. Full `npm test` passed (868/868).

**Concerns:** No functional blockers. The market override form treats blank percentage fields as inherited from global policy; saving stores `null` for those fields and uses Clear to remove the override document entirely.

**Report path:** `C:\Users\heman\Downloads\bazzar\.superpowers\sdd\task-7-report.md`
