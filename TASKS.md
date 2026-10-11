# TASKS — S13 Reconciliation and reports

Spec: `docs/specs/S13-reconciliation-and-reports.md` (F20, F22, A11; ADRs 0003, 0004, 0006, 0011, 0017, 0018, 0019, 0021, 0022, 0025, 0027). Three PRs, as the spec's implementation plan says; each leaves `main` green.

## PR 1 — Contracts, db, api (`ccr-34597277-aed0k9`, the cloud session's branch) · Opus 5.5 `high`
- [x] Contracts `reconciliation.ts` (new, re-exported): places map (T1) with currency and asset flag, outside categories (T4), movement kinds, checks, result statuses, run triggers and statuses, defaults; movement, supplier correction, reversal, movement, money places, overview, run, result, explanation, Sham Cash count and settings schemas with `.meta({ id })`; amount rules T3
- [x] Contracts `reports.ts` (new, re-exported): kinds, breakdowns, `REPORT_MAX_DAYS`, `TOP_CUSTOMERS_LIMIT`, query schema (RP1 period rule), one response schema per report R1–R6
- [x] Contracts extended: `wallet.ts` account kinds `outside_funds`, `transfer_fees`, `supplier_corrections` and journal kind `treasury`; `money.ts` `heldUnits`, `withinRange`, `impliedRate` (100% coverage); error codes (8 new) with Arabic admin text; audit entity types and actions with labels; `jobs.ts` `reconciliation.run`, `reconciliation.recheck` (Telegram, dashboard and USDT balance contracts moved to PR 2 and PR 3)
- [x] Db (`/db-migration`): enums; `treasury_movements` (checks, currency trigger, unique reference per source, append-only); `reconciliation_runs` (one running, one per business date); `reconciliation_results` and `reconciliation_explanations` (append-only); `reconciliation_settings` (seeded); indexes `deposits (status, decided_at)`, `fulfilment_attempts (resolved_at)`; tests of checks, triggers and grants
- [x] Db LS1: cost of goods journal signs corrected in `packages/db/src/orders` (S08 delivery and S11 manual fulfil) with regression tests
- [x] Db write paths `packages/db/src/treasury`: movement postings M1–M4, supplier correction, reversal under lock, opening balance rule, idempotency; concurrency tests (parallel reversals, one key in parallel)
- [x] Db `packages/db/src/reconciliation`: checks C1–C9 as SQL in one `REPEATABLE READ` snapshot, external check ranges (E2–E4) and books reads; tests: each check passes clean and fails with ids on a planted fault
- [x] Api `treasury` module: places, movements list, create, supplier correction, reverse (re-auth, typed confirmation above $100, `Idempotency-Key`, audit)
- [x] Api `reconciliation` module: overview, runs list and detail, manual run (one running, 5-minute rate), explanation, Sham Cash count run (E4 at once), settings (re-auth)
- [x] Api `reports` module: R1–R6 queries (Damascus days, real customers only, R6 test share), Excel export (streamed, RTL, strings never formulas, audit, 10/minute)
- [x] `TABLE_OWNERS` and the architecture test; `app.module.ts`
- [x] Api tests `test/treasury.test.ts`, `test/reconciliation.test.ts`, `test/reports.test.ts` (every route: success, 401, guard codes, re-auth, replays, the spec's rules; R1 equals the dashboard)
- [x] Bridge: build, OpenAPI export, admin client; mocks follow changed shapes
- [x] Wiring checklist, docs (`docs/architecture.md` modules, folder `CLAUDE.md` files, spec "Settled in implementation")
- [x] Checks (lint, typecheck, test, build, drift, e2e: passed and recorded on 174687db9b75; PostgreSQL 16 in the session, CI runs 17), reviewer (two blocking findings fixed: a Sham Cash count before an opening lost its amount and its replay; negative pounds written as NaN in exports), owner acceptance waived by the owner (open the PR at once, 2026-10-11), PR with auto-merge

## PR 2 — Worker (`claude/jolly-babbage-awoymj`, the cloud session's branch) · Opus 5.5
- [x] Chain readers `getUsdtBalance` (TronGrid, BSC `eth_call`, fake with scripted offset); `usdt:fake-balance` command and the `AGENTS.md` table
- [x] Jobs `reconciliation.run` (cron 00:30 Damascus, stale run failed, internal then external checks, recheck queueing) and `reconciliation.recheck`; supplier reads into `supplier_balance_reads`
- [x] Contracts and enum value (migration 0046) for Telegram `reconciliation_alert` (NT1) and the daily summary line (NT2); the cron's `{}` payload. No `usdt.ts` type was needed: readers return raw units, converted with `rawToUsdUnits`. Shared in `packages/db`: warnings E5, alert, finish and fail of a run (the API's count alerts too)
- [x] Worker tests (ok, mismatch, recheck clears and confirms, reader failure, alert rules, cron date, stale run)
- [x] Wiring checklist, docs
- [ ] Checks, reviewer, acceptance, PR with auto-merge

## PR 3 — Admin screens and E2E
- [ ] Admin `features/reconciliation/`: status card, open mismatches with explain dialog, money places, movement and correction dialogs, count dialog, movements tab with reverse, history tab and run page, settings drawer; navigation "المطابقة" with badge
- [ ] Admin `features/reports/`: tabs R1–R6, period presets, breakdown selector, tables with totals, chart on R1, Excel export; navigation "التقارير"
- [ ] Dashboard attention kinds `reconciliation_open`, `reconciliation_missing`, `sham_cash_count_due` (contracts, API, panel); i18n keys
- [ ] E2E flows and RTL screenshots (admin light and dark)
- [ ] Wiring checklist, docs (`docs/ROADMAP.md` S13 done, `wiring.md` patterns)
- [ ] Checks, reviewer, acceptance, PR with auto-merge
