# TASKS — S23 Merchant tiers, PR 1 "Tiers and prices" (`docs/specs/S23-merchant-tiers.md`)

Spec PR 1 (decisions 1–5, 9, 10, 13, 14) is split in two PRs so neither is half-wired: 1a the server side, 1b the panel. PR 2 (identity and progress) and PR 3 (operations and reports) follow in their own sessions.

Stopped at: PR 1a, contracts and db done; api next.

## PR 1a — tiers, prices and privileges on the server (contracts, db, api, worker)

- [x] contracts: `merchant-tiers.ts` (`MERCHANT_TIERS`, `LEVEL_TIERS`, `TIER_NAMES_AR`, `tierRank`, `higherTier`, `effectiveLevel`, `parentCappedPrice`, tier settings and grant schemas, tiers page and preview schemas with `.meta({ id })`), `MERCHANT_LEVELS_MAX = 3`, `TIER_QUANTITY_CEILING`, `PRICE_SOURCES` + `parent_cap`, `listPrice` with the parent cap, error codes (`MERCHANT_TIER_*`) with their Arabic texts, audit actions (`merchant_tier.*`, `merchant.tier_granted`, `merchant.tier_grant_ended`), jobs (`merchants.tier-grants`), Telegram events (`merchant_tier_changed`, `merchant_tier_grant_ending`, the summary line), `merchant_level_changed` payload with the tier; unit tests at 100%
- [x] db (`/db-migration`): `merchant_tier` enum, `merchant_levels.tier` (live levels archived first, unique among live), `merchant_tier_settings` seeded (Bronze copied from `merchant_settings`), `merchant_profiles` (`earned_level_id`, `level_source`), `merchant_tier_grants` with its guard and one-open index, append-only `merchant_tier_changes` and `merchant_tier_months`, `product_prices.source` + `parent_cap`, widened checks (`orders.quantity`, `checkouts.line_count` to 100); `TABLE_OWNERS`; tests
- [x] db write paths: TR6 recomputation in `packages/db/src/merchants/levels.ts` (earned + effective level, change row, celebrate flag, notification, Telegram alert); repricing parents before children with the parent cap (`packages/db/src/pricing`); concurrency tests (TR6 with a purchase, parent cap under concurrent rule edits)
- [ ] api: tiers routes replacing `/api/admin/merchant-levels` (`GET /api/admin/merchant-tiers`, `PUT …/:tier/level`, `PUT …/:tier/settings`, `POST …/preview`), grants (`POST /api/admin/customers/:id/merchant/tier-grant` and `/end`), merchant settings with the Diamond contact, revocation ending grants (TR9), MG7, the merchants list and profile with the tier and filter; privileges per tier (deposit limits TS3, player-check quota TS4, code quantity and bulk lines TS5); price kind (PX6); `merchants:setup-tiers` command (PX1) and `pnpm db:seed-local` running it; tests per endpoint and rule
- [ ] worker: `merchants.level` with TR6, `merchants.level-schedule` writing `merchant_tier_months`, `merchants.tier-grants` (MG4, MG5), Telegram texts (TR8, MG5, daily summary line); tests run twice
- [ ] bridge: OpenAPI export and admin client regenerated; the admin's levels page and E2E mocks adapted to the changed routes so `main` stays whole
- [ ] docs: AGENTS.md commands table (`merchants:setup-tiers`), `docs/architecture.md` ownership, ROADMAP line
- [ ] checks, reviewer, PR and merge

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
