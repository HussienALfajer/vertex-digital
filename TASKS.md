# TASKS — S19 FazerCards, second automatic supplier and the store-wide player check

Spec `docs/specs/S19-fazercards.md`, ADR 0034. Three code PRs as the spec's delivery plan says, one session each; then the deploy and the funded pilot.

## PR 1 — enum, seed, switch, credentials, labels (this session, branch `feat/s19-fazercards-enum`; deployable alone)
- [x] Contracts: `fazercards` in `SUPPLIER_CODES` (not in `ADAPTERS_READY`, FC2), `SUPPLIER_CREDENTIAL_FIELDS.fazercards = ['apiKey', 'webhookSecret']`, `fazercards_paused` switch (default off) and its supplier mapping, treasury place `supplier:fazercards` → `supplier_prepaid:fazercards` (USD), low-balance default $5 (D8); unit tests
- [x] DB (`/db-migration`): enum values `supplier_code.fazercards` and `store_switch.fazercards_paused`; the seeded `suppliers` row (fixed UUID, `validation_daily_quota` 1000) in 0069, which recreates `supplier_code` (as 0061) because drizzle runs every pending migration in one transaction and an added value is unusable before commit; checked on the migrated test databases; drift
- [x] API: credentials entry and the "not available" state through the existing supplier routes; settings, treasury and reports accept the new code; seed-local; tests (credentials with re-authentication, switch, treasury place)
- [x] Worker: Telegram labels (pause switch, low balance); sync, routing and checks skip a supplier without an adapter (test)
- [x] Bridge: OpenAPI export and admin client
- [x] Admin: names and credential field labels, switch label, treasury and reconciliation labels, filters; FazerCards card "not available"; E2E mocks; RTL screenshots light and dark
- [x] Wiring checklist, checks, reviewer (3 findings: the dashboard shows FazerCards as not ready, the seed's id and quota and the new switch tested; the seed row is one-way for a rollback, accepted by the owner on 2026-10-20), owner acceptance, PR with auto-merge

## PR 2 — adapter, sync, orders, webhooks, statement, subscription, images, webhook card (next session)
- Adapter `packages/suppliers/src/fazercards/` (FC1, FC4–FC7, FC10–FC12) with a fake HTTP server and fixtures; `ADAPTERS_READY` gains `fazercards`
- Sync shaped per FC3 (category window, `missing_since` rules); `supplier_categories.note`; subscription watch FC9; webhook set/test/deliveries FC8 (API routes, audit); admin tabs, webhook and subscription cards; exploration of `validate-id` games and region values (Bronze bought only if needed, D1)

## PR 3 — routing ties, store-wide player check, ID formats, screens (later session)
- RT10–RT12; `game_player_checks`, `player_checks.region`, `orders.player_region`, PC1–PC9, `PLAYER_REGION_MISMATCH`; `hoyoverse_uid`, `supercell_tag` (ID1–ID4); game "فحص اللاعب" card, image suggestion (D10), store buy box name and region; E2E and screenshots
- Then: production deploy and the funded pilot (spec "Acceptance")
