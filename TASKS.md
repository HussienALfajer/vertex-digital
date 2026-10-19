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

## PR 2 — adapter, sync, orders, webhooks, statement, subscription, webhook card (branch `feat/s19-fazercards-adapter`)
- [x] Exploration (owner's go-ahead, 2026-10-20): read-only calls with the owner's key on the server, sanitized fixtures; the trial is active until 2026-10-24 (Bronze not needed); check categories differ from order categories (`docs/suppliers/fazercards.md`)
- [x] Contracts: `ADAPTERS_READY` gains `fazercards`; `account` panel capability, subscription and webhook settings schemas, `subscriptionAlert` (FC9), `manual_delivery`, `ignored` webhook result, `account` call operation (outside health), audit `supplier.webhook_set` / `webhook_tested`, Telegram `supplier_subscription`, error `STORE_URL_NOT_PUBLIC`; unit tests
- [x] Suppliers: `packages/suppliers/src/fazercards/` (FC1, FC4–FC7, FC10–FC12), `listOffersIn` and account methods on the interface (`notSupported` elsewhere), `PUT` in `SupplierHttp`; 37 adapter tests against the fake server; `docs/suppliers/fazercards.md`
- [x] DB (`/db-migration`): 0070 (category note and `offers_read_at`, suppliers' account columns, enum values), 0071 (`supplier_call_operation.account`); routing treats an inactive plan as paused (test); drift clean
- [x] Worker: windowed sync (FC3) with scoped `missing_since`; balances job reads the plan (FC9) with alerts and repricing; webhook job stores `ignored`; registry builds the adapter; tests
- [x] API: adapter in `SupplierAdaptersService`; `GET`/`PUT /api/admin/suppliers/:code/webhook`, `POST …/webhook/test` (PUT re-authenticated, both audited); the card's `subscription`, the category `note`; tests (401, re-authentication, audit, HMAC intake, PR 1 tests updated)
- [x] Bridge: OpenAPI export and admin client
- [x] Admin: plan on the card, plan and webhook cards in Connection, the quota card for FazerCards, the category note, labels; E2E mocks; RTL screenshots light and dark
- [x] Wiring checklist, checks, reviewer (3 findings fixed: the inactive plan from a refused read or order, the failed webhook set audited, gift card order bounds), owner acceptance (2026-10-20), PR with auto-merge

## PR 3 — routing ties, store-wide player check, ID formats, screens (later session)
- Carried from PR 2: `validatePlayer` gets the check category from the provider row of the game (the adapter already takes `categoryId`); FC9 checks unavailable while the plan is inactive (`subscriptionInactive` on `SupplierState`); PC7 moves `validate_player` out of health
- RT10–RT12; `game_player_checks`, `player_checks.region`, `orders.player_region`, PC1–PC9, `PLAYER_REGION_MISMATCH`; `hoyoverse_uid`, `supercell_tag` (ID1–ID4); game "فحص اللاعب" card, image suggestion (D10), store buy box name and region; E2E and screenshots
- Then: production deploy and the funded pilot (spec "Acceptance")
