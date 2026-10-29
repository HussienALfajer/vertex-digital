# TASKS — S23 Merchant tiers, PR 1 "Tiers and prices" (`docs/specs/S23-merchant-tiers.md`)

Spec PR 1 (decisions 1–5, 9, 10, 13, 14) is split in two PRs so neither is half-wired: 1a the server side, 1b the panel. PR 2 (identity and progress) and PR 3 (operations and reports) follow in their own sessions.

Stopped at: PR 1a ready and pushed; the owner presses Create PR, then auto-merge and the wait for the merge.

Owner decision (2026-10-29), not applied yet: PX3's half-step minimum margins are whole cents, rounded up: Silver $0.05 (was $0.045), Diamond $0.04 (was $0.035); Gold stays $0.04. Apply it in `TIER_RULE_DEFAULTS.half` (`packages/contracts/src/merchant-tiers.ts`) and in the spec's PX3 table, with a line naming the six production slugs read on 2026-10-29: `games`, `game-cards` (global rule), `apps`, `subscriptions` (half step), `gift-cards`, `shopping` (no step).

## PR 1a — tiers, prices and privileges on the server (contracts, db, api, worker)

- [x] contracts: `merchant-tiers.ts` (`MERCHANT_TIERS`, `LEVEL_TIERS`, `TIER_NAMES_AR`, `tierRank`, `higherTier`, `effectiveLevel`, `parentCappedPrice`, tier settings and grant schemas, tiers page and preview schemas with `.meta({ id })`), `MERCHANT_LEVELS_MAX = 3`, `TIER_QUANTITY_CEILING`, `PRICE_SOURCES` + `parent_cap`, `listPrice` with the parent cap, error codes (`MERCHANT_TIER_*`) with their Arabic texts, audit actions (`merchant_tier.*`, `merchant.tier_granted`, `merchant.tier_grant_ended`), jobs (`merchants.tier-grants`), Telegram events (`merchant_tier_changed`, `merchant_tier_grant_ending`, the summary line), `merchant_level_changed` payload with the tier; unit tests at 100%
- [x] db (`/db-migration`): `merchant_tier` enum, `merchant_levels.tier` (live levels archived first, unique among live), `merchant_tier_settings` seeded (Bronze copied from `merchant_settings`), `merchant_profiles` (`earned_level_id`, `level_source`), `merchant_tier_grants` with its guard and one-open index, append-only `merchant_tier_changes` and `merchant_tier_months`, `product_prices.source` + `parent_cap`, widened checks (`orders.quantity`, `checkouts.line_count` to 100); `TABLE_OWNERS`; tests
- [x] db write paths: TR6 recomputation in `packages/db/src/merchants/levels.ts` (earned + effective level, change row, celebrate flag, notification, Telegram alert); repricing parents before children with the parent cap (`packages/db/src/pricing`); concurrency tests (TR6 with a purchase, parent cap under concurrent rule edits)
- [x] apply the owner's rounding decision above, rebuild contracts, rerun `pnpm verify apps/api/test/merchant-tiers.test.ts` (the setup test fails on `margin_rules_min_margin_check` until then)
- [x] api: tiers routes replacing `/api/admin/merchant-levels` (`GET /api/admin/merchant-tiers`, `PUT …/:tier/level`, `PUT …/:tier/settings`, `POST …/preview`), grants (`POST /api/admin/customers/:id/merchant/tier-grant` and `/end`), merchant settings with the Diamond contact, revocation ending grants (TR9), MG7, the merchants list and profile with the tier and filter; privileges per tier (deposit limits TS3, player-check quota TS4, code quantity and bulk lines TS5); price kind (PX6); `merchants:setup-tiers` command (PX1) and `pnpm db:seed-local` running it; tests per endpoint and rule
- [x] worker: `merchants.level` passes the payload's `cause` to `recomputeMerchantLevel`; `merchants.level-schedule` recomputes each merchant then writes `recordTierMonth` for the month just ended; new `merchants.tier-grants` job every 10 minutes (`dueTierGrants` → `expireTierGrant` one per transaction, `remindEndingTierGrants`), registered in `worker.module.ts`; Telegram texts for `merchant_tier_changed`, `merchant_tier_grant_ending` and the summary line "فئات التجار: n تغيّرت اليوم" (counted from `merchant_tier_changes`); email and push texts of `merchant_level_changed` name the tier; tests (each job run twice). Was: `merchants.level` with TR6, `merchants.level-schedule` writing `merchant_tier_months`, `merchants.tier-grants` (MG4, MG5), Telegram texts (TR8, MG5, daily summary line); tests run twice
- [x] bridge: `pnpm build`, OpenAPI export and admin client regenerated; the admin's S21 levels page removed (route, navigation, queries, i18n, E2E mock and spec for `/api/admin/merchant-levels`; the tiers page comes in PR 1b), route tree regenerated, admin typecheck
- [x] reviewer (`docs/specs/S23-merchant-tiers.md`): fixed the 50-unit request cap (orders, releases, resolve, fulfil up to 100), the month row written before the recomputation, the setup refusing a same-named list off the chain, the Bronze seed's hourly checks clamped, and tests for TS3–TS5, MG7, edge case 9 and access
- [x] full `pnpm verify` again after the review fixes (pass, 2026-10-29: lint, typecheck, test, build, 340 admin E2E, migration and OpenAPI drift); the db test "gives every order a fixed verification code … (VF1–VF3)" in `packages/db/src/orders/orders.test.ts` passes when its file runs alone (148/148): nothing to fix
- [x] docs: AGENTS.md commands table (`merchants:setup-tiers`), `docs/architecture.md` ownership (merchants owns the four tier tables), `apps/api/CLAUDE.md` and `packages/db/CLAUDE.md` notes (tiers, grants, parent cap, setup), ROADMAP line
- [ ] note in the PR: migration 0104's SQL was rewritten to the generator's output without the early `merchant_levels_tier_check` (moved to 0105 after the archive; owner approved deleting the first generation); `pnpm db:generate` reports no drift
- [ ] checks, reviewer, PR and merge

Before the S23 deploy (from the reviewer, not confirmed here): read production's newest `merchant_settings` row and whether lists named "الفضية", "الذهبية" or "الماسية" exist; time `PUT /api/admin/merchant-tiers/:tier/level` (it reprices every routed product in one request) against the 15 s lock timeout on the production catalog; a grant racing the archive of its tier can stay open without effect (single admin, not blocking).

## PR 1b — the panel (admin)

- [ ] admin: tiers page `/merchants/tiers` (replaces `/merchants/levels`): four cards, threshold and list dialog, settings dialog, threshold preview side panel; Diamond contact in Settings → merchants (deposit and check fields leave it)
- [ ] admin: merchants list tier column with "ممنوحة" and the tier filter; customer profile tier card, "منح فئة" and "إنهاء المنح" dialogs (re-authentication), grant history
- [ ] i18n keys, error and audit labels; loading, empty and error states
- [ ] e2e: tiers page, preview, grant dialog, merchants filter; RTL screenshots light and dark
- [ ] browser check on the local stack (acceptance 1 and 5)
- [ ] checks, reviewer, PR and merge

## Moved to later PRs (spec delivery plan)

- PR 1b: the merchant settings lose the deposit and check fields (contract and panel, they are no longer read); the profile's limit source names the tier (TS3, "الافتراضي: تاجر ذهبي"); the store's code-quantity input reads the tier's `orderUnitsMax` (today 50 in the browser, the server enforces the tier).
- PR 2: `celebrate_pending`, `certificate_code`, `certificate_reissued_at` (identity); the notification's "what it grants".
- PR 3: the Diamond contact columns of `merchant_settings` (decision 12).
