# TASKS — S02 Wallet and ledger

Spec: `docs/specs/S02-wallet-ledger.md` (F03; ADRs 0003, 0011, 0014, 0016). Two PRs; each leaves `main` green. PR 2 runs in its own session.

## PR 1 — Contracts, db, api, worker email (`claude/brave-tesla-g89w6r`, cloud session branch) · Opus 5.5 `high`
- [ ] Contracts: `wallet.ts` (directions, categories with allowed directions J1, deposit methods, threshold J6, wallet, timeline entry customer/admin, search query/result, admin wallet, create/reverse adjustment, adjustment, ledger summary, page schemas with ids); `walletSypValue` in `money.ts`; error codes (`ADJUSTMENT_NOT_ALLOWED`, `AMOUNT_CONFIRMATION_REQUIRED`, `AMOUNT_CONFIRMATION_MISMATCH`, `EXTERNAL_REFERENCE_TAKEN`, `ADJUSTMENT_ALREADY_REVERSED`, `ADJUSTMENT_NOT_REVERSIBLE`) with their Arabic text in the store and admin catalogs; audit actions `wallet_adjustment.created` / `.reversed` and entity type `wallet_adjustment` with admin labels; email template `customer_wallet_adjusted`; 100% unit-tested
- [ ] Db (`/db-migration`): `ledger_accounts.customer_id` (unique, kind check, identity trigger extended); `wallet_adjustments` (enums, checks, unique external reference per method, unique reversal, reversal trigger, append-only trigger and grants); email template enum value; `ensureCustomerWallet`, `ensureSystemAccount`, `walletTimeline` in `packages/db/src/ledger`; tests (append-only as the app role, reversal trigger, identity, kind check, two parallel first credits, timeline running balance across pages, equal timestamps, net amount of a two-posting journal)
- [ ] Api `wallet`: customer `GET /api/wallet`, `GET /api/wallet/entries` (`no-store`); admin search, wallet, entries, adjustments (re-authentication, `Idempotency-Key`, J1–J10), reverse (R1–R5), ledger summary; audit and email outbox in the same transaction; `TABLE_OWNERS`; `test/wallet.test.ts` (routes, 401/403, own entries only, every error code, 20 parallel debits, parallel reversals, same key in parallel, failed debit leaves no rows)
- [ ] Worker: render the `customer_wallet_adjusted` email (Arabic HTML + text through i18n, link to `/wallet`); test
- [ ] Bridge: build, OpenAPI export, admin client generated; admin typecheck
- [ ] Wiring checklist, docs (`docs/architecture.md` modules, folder `CLAUDE.md`, "Patterns to copy" ledger row in `wiring.md`)
- [ ] Checks (lint, typecheck, test, build, drift), reviewer, owner acceptance (endpoints at `/api/docs`), PR with auto-merge

## PR 2 — Store and admin screens, E2E (`feat/s02-wallet-screens`) · Opus 5.5 `medium`
- [ ] Store: header balance chip (Suspense hole, hidden on error), `/wallet` (card, timeline with labels per kind and category, running balance, load more, empty, error, sign-in redirect); i18n
- [ ] Admin: `/wallets` (summary card with system accounts, search, results, load more), `/wallets/$customerId` (header, timeline table, reversed/reversal links), adjust dialog (categories per direction and customer, manual-deposit fields, balance after, confirmation field without paste above $100, re-authentication retry with the same key, new key after an edited field), reverse dialog; navigation "المحافظ"; audit filters; i18n
- [ ] E2E: flows and RTL screenshots (store dark at phone width, empty and with entries, chip; admin light and dark: wallets, wallet page, adjust dialog with confirmation, reverse dialog)
- [ ] Wiring checklist, `docs/ROADMAP.md` (S02 done)
- [ ] Checks (lint, typecheck, test, build, e2e), reviewer, owner acceptance (spec "Acceptance" 1–9 in the browser), PR with auto-merge
