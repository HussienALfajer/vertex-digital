# TASKS — S04 USDT deposits

Spec: `docs/specs/S04-usdt-deposits.md` (F06; ADRs 0003, 0006, 0008, 0011, 0014, 0016, 0017, 0018). Three PRs; each leaves `main` green. Each PR runs in its own session.

Why three and not the spec's two: PR 1 of the spec (contracts, db, readers, jobs, api) is too large for one reviewed session. Splitting the worker out keeps `main` safe: until PR 2 ships, no scanner writes `usdt_scan_cursors`, so every network reads `delayed` (rule U1) and USDT deposit creation is refused; nothing can be left `searching` without a worker.

## PR 1 — Contracts, db, ledger, api (`claude/zen-pasteur-xvhupy`, cloud session branch) · Opus 5.5 `high`
- [x] Contracts: `usdt.ts` (methods, networks with official contracts and their source, confirmations, explorer URLs, tail and limit constants, `txidSchema`, per-network `addressSchema` with TRON base58check and EIP-55); `money.ts` `usdtPayAmount`, `formatUsdtAmount`, `rawToUsdUnits`, `usdtRawForUnits`; `deposits.ts` (methods, flags `wrong_network` and `sent_before_deposit`, reject reasons, check statuses and errors, deciders, USDT options/create/submit-txid/approve/transfer schemas, `usdt` blocks on deposit and admin deposit, settings defaults, limit computation with the USDT minimum); `wallet.ts` `deposit_rounding`; `jobs.ts` queues `deposits.usdt-scan` and `deposits.usdt-verify` with payloads; error codes `TXID_INVALID`, `TXID_ATTEMPTS_EXCEEDED`, `DEPOSIT_AMOUNT_BUSY` with Arabic text (store and admin catalogs); audit actions `deposit.txid_submitted`, `deposit.transfer_bound`, `deposit.txid_bounced`, `deposit.rechecked` with admin labels; 100% unit-tested
- [x] Db (`/db-migration`): `deposits.decided_by` (backfill `admin`) and the changed checks; `deposits_guard` USDT bounce; `usdt_deposits` (immutable-field trigger, partial unique open amount via `deposit_open`, indexes, grants); `usdt_transfers` (append-only, unique `(method, txid)`); `usdt_scan_cursors`; `deposit_settings` USDT columns; enums; `postUsdtDepositCredit` (M1, `usdt_receipts:<method>`, `deposit_rounding:USD`) in `packages/db/src/ledger/deposits.ts`; `paymentReferenceOwner` `0X` lookup; tests (checks, guard, triggers as app role and owner, unique open amount, settings defaults, M1 postings)
- [x] Api: env `USDT_TRC20_ADDRESS`, `USDT_BEP20_ADDRESS`, `CHAIN_READER` (`fake` refused in production), reader variables, boot refuses a bad address; `.env.example`
- [x] Api `deposits`: `GET /api/deposits/usdt/options`, `POST /api/deposits/usdt` (tail under advisory lock, U2–U5, idempotency, ALTCHA), `POST /api/deposits/:id/txid` (U8, per-hour counter, job in the transaction), list/read/cancel with the `usdt` block; admin queue method filter, counts, deposit with transfer and candidates, `approve-usdt` (U15, re-authentication always), reject with new reasons (review only), `recheck` (U17), `GET /api/admin/usdt-transfers`, settings USDT fields; S03 approve and request-receipt refuse USDT; wallet timeline `method`; the U7 credit steps (lock, claim, `postUsdtDepositCredit`, deposit update, audit, email) as one shared write path in `packages/db` so the api approval and the PR 2 worker credit through the same code; S02 `manual_deposit` normalizes TXIDs; `test/deposits-usdt.test.ts` (every route and error code, two customers, re-authentication, parallel creations → different tails and the 100th busy, two deposits one TXID, S02 vs deposit claim with `0x`/link/case variants, approval vs re-check, no-store)
- [x] Bridge: build, OpenAPI export, admin client; admin typecheck; store/admin fixtures and E2E mocks adapted to changed shapes (the settings form keeps the USDT values until PR 3)
- [x] Wiring checklist, docs (`docs/architecture.md`, `docs/deployment.md` variables and address-change note, folder `CLAUDE.md`, spec details settled; queue policies `stately` in `QUEUE_POLICIES`)
- [x] Checks (lint, typecheck, test, build, drift, e2e: all passed and recorded), reviewer (no blocking findings; three PR 2 notes below)
- [x] Owner acceptance (2026-10-08), PR with auto-merge

## PR 2 — Chain readers and worker jobs (`ccr-25210d15-4vpn8q`, cloud session branch) · Opus 5.5 `high`
- [x] `ChainReader` interface and `ChainReaderError`; `fake` reader (a git-ignored JSON file, not a table: settled in the spec; memory store in tests; refused in production); TronGrid reader and BSC JSON-RPC reader with sanitized fixtures (synthetic: the providers were unreachable from the build environment; limits named in the spec and `docs/deployment.md`)
- [x] `jobs/deposits/usdt-verify.job.ts` (U6, U9–U11, retry schedule from `search_started_at`, bounce, review, credit U7; singleton per deposit; safe twice)
- [x] `jobs/deposits/usdt-scan.job.ts` (U12–U14: cursor with overlap, dust, bind and credit, replace a wrong customer TXID; 20 s while open, 5 min cron; stale alert on Telegram once per window; restarts lost verifications)
- [x] Credit transaction shared with the api approval (U7, M1: `creditUsdtDeposit`) and its email (`core/email/outbox.ts`)
- [x] CLI `usdt:fake-transfer`; commands table in `AGENTS.md`
- [x] Tests: exact match, each bounce, each review reason, reader error never "not found", 30-minute window, TRON solidified, BSC finalized + 15, summing, 18-decimal remainder, cursor overlap and duplicates, dust, stale alert once, scanner vs verifier in parallel → one journal/audit/email
- [x] From the PR 1 review: two customers with the same TXID: the verifier bounces the second with `txid_used` (final, never a retry loop)
- [x] From the PR 1 review: a TXID whose transfer is under $1 bounces back to `pending` with `amount_too_small` (owner, 2026-10-08); the code to confirm with the owner at acceptance
- [x] The worker checks `USDT_TRC20_ADDRESS` / `USDT_BEP20_ADDRESS` at boot too (edge case 17), with `CHAIN_READER` (`fake` refused in production; `stub` read as `fake`) and the reader variables; `.env.example` `CHAIN_READER=fake`
- [x] API: a new USDT deposit sends its network's scan job (detection within about 20 seconds)
- [x] Bridge: migrations 0016–0017 (check errors), build, OpenAPI export, admin client
- [x] Docs (`docs/architecture.md`, `docs/deployment.md`, `AGENTS.md`, folder `CLAUDE.md`, spec settled notes)
- [x] Reviewer: three blocking findings fixed (scanner skips claimed TXIDs; bounce with another pending deposit rejects instead, owner 2026-10-08; BSC lists only 15-confirmation blocks, a not-final listing waits quietly), with tests
- [x] Checks on the final tree (all recorded), owner acceptance (2026-10-08), PR with auto-merge

## PR 3 — Store and admin screens, E2E · Opus 5.5 `high`
- [ ] Store: method picker with three methods and reasons; USDT form (network note, presets, limits, `DEPOSIT_AMOUNT_BUSY` ±$0.01); `/wallet/deposits/[id]` USDT states (exact amount with highlighted tail, QR from text, address in groups, warnings, TXID field, searching, confirming progress, review reason, final states; 10 s / 30 s refresh); method labels in lists and timeline; i18n
- [ ] Admin: queue method filter and chips; USDT deposit page (facts, TXID, transfer, flags, candidates, approve with live amount and re-authentication, reject, re-check, decider); `/deposits/transfers` with badge and prefilled S02 form; settings USDT section; audit filters; i18n
- [ ] E2E flows and RTL screenshots (store dark phone width; admin light and dark)
- [ ] Wiring checklist, `wiring.md` patterns, `docs/ROADMAP.md` S04 done
- [ ] Checks (lint, typecheck, test, build, e2e), reviewer, owner acceptance, PR with auto-merge
