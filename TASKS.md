# TASKS — Drop SHOP2TOPUP

The owner dropped SHOP2TOPUP on 2026-10-14: WDGZone (automatic) and manual remain the only suppliers. Full removal from code, docs and the database; applied migrations (0026, 0027) and git history stay untouched.

Two PRs, expand then contract (`db-migration` step 4): the released code passes `shop2topup_paused` to PostgreSQL (`productRoutingStates` reads every supplier pause switch with `inArray`), so dropping the enum values in the same release would break the old release during the deploy and after a rollback.

## PR 1 — Remove SHOP2TOPUP from code, docs and data · `refactor/drop-shop2topup`
- [x] Docs: new ADR (the drop; supersedes the SHOP2TOPUP parts of ADR 0004, 0005, 0021); v1-scope, ROADMAP, open-questions (Q12), architecture, specs S06–S09, S13, S16, `docs/suppliers/wdgzone.md`, the `/supplier-adapter` skill, `packages/db/CLAUDE.md`
- [x] Contracts: `SUPPLIER_CODES`, secret fields, `STORE_SWITCHES` + defaults + `SUPPLIER_PAUSE_SWITCHES`, reconciliation account `supplier:shop2topup`, comments; tests
- [x] Db: the `supplier_code` and `store_switch` enums keep their retired values until PR 2 (columns typed with the contracts' unions); custom migration: refuse if anything references SHOP2TOPUP (every table with a foreign key to `suppliers`, switch changes, ledger accounts, audit entries), then delete its supplier row; tests (seeds, migration guard)
- [x] Suppliers: adapter comments
- [x] Worker: Telegram texts, health job comment; tests
- [x] Api: report workbook label; tests
- [x] Bridge: build, OpenAPI export, admin client
- [x] Admin: reconciliation labels, `ar.json`, e2e mocks and specs
- [x] Checks (lint, typecheck, test, build, e2e, drift) through the checker
- [x] Reviewer, PR with auto-merge

## PR 2 — Drop the retired enum values (after PR 1 is deployed) · `refactor/drop-shop2topup-enums`
- [ ] Db: the enums back on the contracts' lists; the generated migration recreates `supplier_code` without `shop2topup` and `store_switch` without `shop2topup_paused`; review its SQL; drift
