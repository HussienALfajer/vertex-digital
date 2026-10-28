# S13 — Reconciliation and reports (F20, F22)

Status: Approved · Date: 2026-10-11 · Scope: `docs/product/v1-scope.md` §F20, §F22, automation A11 · ADRs: 0003, 0004, 0006, 0011, 0017, 0018, 0019, 0021, 0022, 0025, 0027

## Summary
The books must prove themselves every night, and the owner must see where the money is and what the store earned. S13 adds three things. **Treasury movements** record money leaving or entering the store's money places (Sham Cash in SYP and USD, USDT per network, each supplier's prepaid balance, and the outside world), so supplier funding, the owner's withdrawals and conversions are in the ledger (ADR 0021 left this to S13). The **nightly reconciliation** (A11, 00:30 `Asia/Damascus`) runs exact internal checks on the ledger and compares the books with real balances: suppliers and USDT read automatically, Sham Cash counted by the admin; every mismatch stays open until the admin explains it, and a new one alerts on Telegram. **Reports** show sales and profit by delivery (as the dashboard) by day, game, product and supplier, deposits by method, refunds and failure rates, top customers and a ledger money-movement report, each exportable to Excel (owner, 2026-10-11).

## In scope / out of scope
- In:
  - Treasury movements and supplier balance corrections: table, journals, reversal, audit; the money places view.
  - The correction of S08 M2's posting signs, so cost of goods and supplier funding net correctly (rule LS1, ADR 0027).
  - Reconciliation runs (nightly, manual, Sham Cash count), their checks and results, explanations, settings, the Telegram alert and the daily summary line, dashboard attention items.
  - A USDT balance read on each chain reader (live and fake) and a fake-balance command.
  - Reports R1–R6 with Excel export.
  - Admin screens `/reconciliation` (with the money places and movements) and `/reports`.
- Out (later or never):
  - Automatic Sham Cash balance reading: no API (Sham Cash automation is not planned).
  - Automatic fixes: reconciliation never posts a journal, pauses the store or changes an order (owner, 2026-10-11: alert only; the admin uses the F26 emergency stop if needed).
  - Profit distribution, tax or accounting exports (chart of accounts, trial balance files): not in V1.
  - Reports for test customers: excluded from R1–R5 (S01); R6 shows their share on its own line.
  - Scheduled report emails: not in V1.
  - A store-side view: S13 is admin-only.
  - Phone numbers, player IDs, IPs or codes in any report or export: never (owner, 2026-10-11; ADR 0004 for codes).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the reconciliation overview, runs, results, money places, movements; read reports | Admin | The admin |
| Start a run now; enter a Sham Cash count; explain a mismatch | Admin | The admin |
| Export a report to Excel | Admin, audited | The admin |
| Record or reverse a treasury movement or supplier correction; change reconciliation settings | Admin, re-authentication | The admin |
| Run the nightly reconciliation and rechecks | Worker | System |

## Data

### Contracts (`packages/contracts/src/reconciliation.ts`, `reports.ts` new; `wallet.ts`, `audit.ts`, `errors.ts`, `jobs.ts`, `telegram.ts`, `dashboard.ts`, `usdt.ts` extended)
- `LEDGER_ACCOUNT_KINDS` gains `outside_funds` (money outside the store: the owner's pocket and the rest of the world), `transfer_fees` (fees lost moving money) and `supplier_corrections` (supplier balance changes that are not a delivery's cost). `JOURNAL_KINDS` gains `treasury`.
- `TREASURY_PLACES`: `sham_cash_syp`, `sham_cash_usd`, `usdt_trc20`, `usdt_bep20`, `supplier:<code>` (`wdgzone`, `manual`, `fake`), `outside_usd`, `outside_syp`; each maps to one ledger account code and currency (rule T1) and whether it is an asset (shown as "held" = −balance, rule LS2).
- `OUTSIDE_CATEGORIES`: `owner`, `unclaimed_receipt`, `return_to_sender`, `other` (rule T4).
- `TREASURY_MOVEMENT_KINDS`: `transfer`, `supplier_correction`.
- `RECONCILIATION_CHECKS` (rule C list), `RECONCILIATION_RESULT_STATUSES`: `ok`, `mismatch`, `warning`, `skipped`; `RECONCILIATION_RUN_TRIGGERS`: `schedule`, `manual`, `count`; `RECONCILIATION_RUN_STATUSES`: `running`, `finished`, `failed`.
- `RECONCILIATION_DEFAULTS`: tolerance $1 (`1_000_000` units), count stale after 7 days, recheck after 10 minutes, run at `00:30` `Asia/Damascus`.
- `REPORT_KINDS`: `sales`, `breakdown`, `deposits`, `refunds`, `customers`, `ledger`; `REPORT_BREAKDOWNS`: `game`, `product`, `supplier`; `REPORT_MAX_DAYS = 366`; `TOP_CUSTOMERS_LIMIT = 50`.
- Schemas: `treasuryPlaceSchema`, `createTreasuryMovementSchema`, `createSupplierCorrectionSchema`, `reverseTreasuryMovementSchema`, `treasuryMovementSchema`, `moneyPlacesSchema`, `reconciliationOverviewSchema`, `reconciliationRunSchema`, `reconciliationResultSchema`, `explainResultSchema`, `shamCashCountSchema`, `reconciliationSettingsSchema`, `reportQuerySchema` (`from`, `to` ISO dates, `by?`), one response schema per report.
- Money math in `money.ts` (100% coverage holds): `heldUnits(kind, balance)` (rule LS2), `withinRange(actual, low, high, tolerance)`, `impliedRate(sentSyp, receivedUsd)` as an exact decimal string.

### `treasury_movements` (new; owner: `reconciliation`; append-only)
- `id` uuid v7, primary key.
- `kind` enum `treasury_movement_kind`, required.
- `from_account_id`, `to_account_id` uuid, required, foreign keys to `ledger_accounts`, different (check).
- `sent_units` bigint `> 0`, `sent_currency`; `received_units` bigint `> 0`, `received_currency`: the amount that left the source and the amount that reached the destination, each in its place's currency (checks: `sent_currency` and `received_currency` equal the accounts' currencies, by trigger).
- `rate` numeric, nullable: SYP per USD implied when the currencies differ, stored exactly (`sent / received` or the reverse); null otherwise (check).
- `outside_category` enum `outside_category`, required if and only if one side is an `outside_funds` account.
- `opening_balance` boolean, default false: the first movement that sets a place's starting balance (rule T6).
- `order_id` uuid, nullable, foreign key to `orders`: a supplier correction's order, when it concerns one.
- `external_reference` text, nullable, 1–100 characters: the outgoing TXID, Sham Cash transaction number or supplier receipt. Unique on `(from_account_id, upper(external_reference))` when set and not a reversal (rule T8).
- `reason` text, required, 5–500 characters (also the audit reason).
- `reverses_movement_id` uuid, nullable, **unique**, foreign key to `treasury_movements`.
- `journal_id` uuid, required, unique, foreign key to `ledger_journals`.
- `idempotency_key` uuid, required, unique.
- `admin_id` uuid, required, indexed, no foreign key (as `wallet_adjustments`).
- `created_at` timestamptz, required.
- Indexes: `(created_at desc)`, `(from_account_id)`, `(to_account_id)`, the unique ones. A trigger refuses `UPDATE`, `DELETE`, `TRUNCATE`; the app role has `INSERT`, `SELECT` only.

### `reconciliation_runs` (new; owner: `reconciliation`)
- `id` uuid v7; `trigger` enum `reconciliation_run_trigger`; `business_date` date, nullable: the `Asia/Damascus` day a scheduled run covers (set if and only if `trigger = 'schedule'`, unique when set: one nightly run per day).
- `status` enum `reconciliation_run_status`, default `running`; `started_at`, `finished_at` (set with `finished` or `failed`, check).
- `snapshot_position` bigint, nullable: the highest `ledger_postings.position` the internal checks saw.
- `mismatch_count`, `warning_count` integer `>= 0`, default 0.
- `recheck_at` timestamptz, nullable: when the external recheck is due (rule RN4).
- `failure` text, nullable, ≤ 500 characters: the error's class and message, never secrets or personal data.
- `admin_id` uuid, nullable: the admin who started a `manual` or `count` run (required for those, check).
- `alerted_at` timestamptz, nullable: when its Telegram alert was queued (rule NT1).
- Indexes: `(trigger, started_at desc)`; a partial unique index allows one `running` run at a time (`where status = 'running'`).

### `reconciliation_results` (new; append-only)
- `id` uuid v7; `run_id` foreign key; `check` enum `reconciliation_check`; `subject` text, required, 1–100 characters: what was checked (`ledger`, an account code, `supplier:<code>`, `usdt_trc20`, `sham_cash_syp` …).
- `status` enum `reconciliation_result_status`.
- `currency`, `books_units`, `actual_units`, `difference_units` (bigint, nullable for checks without amounts), `allowed_low_units`, `allowed_high_units`: the range the actual may fall in before the tolerance (rule E1).
- `offending_count` integer `>= 0`; `details` jsonb: up to 50 offending ids (journal, order, attempt, deposit, adjustment, movement) and explanation lines (in-flight attempts, uncredited transfers, deposits under review), never personal data.
- `created_at`. Unique `(run_id, check, subject)`; index `(check, subject, created_at desc)`. Append-only (trigger and grants).

### `reconciliation_explanations` (new; append-only)
- `id` uuid v7; `result_id` uuid, required, **unique**, foreign key; `note` text 5–500 characters; `admin_id` uuid (no foreign key); `created_at`. Append-only.

### `reconciliation_settings` (new; newest row in force, as `supplier_policy`)
- `id`, `tolerance_usd_units` bigint (0 to $100, whole cents), `count_stale_days` integer (1–60), `admin_id` nullable (seed row null), `created_at`. Seeded with the defaults by the migration.

### Existing tables
- `supplier_balance_reads`: the run's own supplier reads are inserted here, like the 5-minute reads (S07 H5).
- Indexes added: `deposits (status, decided_at)` for R3; `fulfilment_attempts (resolved_at)` for R4.

## States and rules

### Ledger signs
- LS1. **S08 M2 is corrected** (ADR 0027): the ledger's convention is "a posting adds to the account's credit side": wallets and revenue grow positive, money the store holds (receipts accounts) grows negative. S08 posted cost of goods the other way (`cost_of_goods +`, `supplier_prepaid −`), which makes funding and consumption move a supplier's account the same way. From S13, a cost of goods journal posts `cost_of_goods:USD` **−cost** and `supplier_prepaid:<supplier>` **+cost**. No production database holds cost journals (Phase 2 was never deployed); development and test databases are recreated (`pnpm db:setup-local`). Check C5 refuses the old signs, so a stale development database shows at once.
- LS2. **Held amounts.** For asset accounts (`sham_cash_receipts`, `usdt_receipts`, `supplier_prepaid`) the panel shows "held" = −balance; expense accounts (`cost_of_goods`, `refunds`, `adjustments`, `transfer_fees`) show −balance as "spent"; `outside_funds` shows −balance as "brought in by the owner and others, net". Raw balances stay as stored; only the display flips, through `heldUnits` in contracts.

### Treasury movements
- T1. **Places** and their accounts: `sham_cash_syp` → `sham_cash_receipts:SYP`; `sham_cash_usd` → `sham_cash_receipts:USD`; `usdt_trc20` → `usdt_receipts:usdt_trc20`; `usdt_bep20` → `usdt_receipts:usdt_bep20`; `supplier:<code>` → `supplier_prepaid:<code>` (USD); `outside_usd` → `outside_funds:USD`; `outside_syp` → `outside_funds:SYP`. Accounts are created on first use (`ensureSystemAccount`). An archived supplier stays a place while its account is not zero.
- T2. A **transfer** moves money from one place to another: `from ≠ to`, and not outside to outside (`TREASURY_PLACES_INVALID`). Examples: funding a supplier from USDT; the owner withdrawing profit (USDT → outside); the owner paying a supplier from their own pocket (outside → supplier); selling pounds for USDT (Sham Cash SYP → USDT).
- T3. **Amounts:** `sent` in the source's currency and `received` in the destination's, both `> 0`, whole cents for SYP and USD places except a supplier place, which allows sub-cent (supplier balances do). Same currency: `received ≤ sent`, the difference is the fee (`MOVEMENT_RECEIVED_EXCEEDS_SENT` otherwise). Different currencies: no fee line; the implied rate is stored (rule M2) and shown with today's rate next to it.
- T4. A side that is `outside` needs an `outside_category`: `owner` (the owner's own money in or out), `unclaimed_receipt` (money that reached a store place outside the deposit flow and is booked in, for example a USDT transfer nobody claimed, S04 M3), `return_to_sender` (money sent back to a payer), `other`.
- T5. A **supplier correction** changes one supplier's books without moving money between places: direction `increase` (the supplier credited the store: a refund after delivery, a goodwill credit) or `decrease` (the supplier charged without a delivery the store recorded: a double delivery, a fee), an amount (sub-cent allowed), an optional order number, a reason. Its counter-account is `supplier_corrections:USD`, so cost of goods keeps matching the attempts exactly (check C5).
- T6. **Opening balance:** a movement into a place may be marked `opening_balance` while no opening into it stands (else `OPENING_BALANCE_EXISTS`; audit A09-1: a wrong opening reversed after the place was used may be taken again, and a place used before its opening may still take one); it comes from `outside` with category `owner`. The dialog proposes the amount that makes the books match the latest external balance now (supplier or USDT read, or the last Sham Cash count). Until a place has one, its external check is `skipped` with warning `opening_missing` (rule E5).
- T7. Re-authentication (S01 D5) for recording and reversing. Above $100 (USD value; SYP converted at today's rate), `amountConfirmationUnits` must equal `sent` (S02 J6 codes). `Idempotency-Key` as S02 J9 (`IDEMPOTENCY_KEY_REUSED`).
- T8. An `external_reference` is unique per source place (`EXTERNAL_REFERENCE_TAKEN`), so the same outgoing transfer is not booked twice. A `return_to_sender` movement out of a USDT place names the incoming transfer it sends back (its TXID, stored as a deposit claim stores it): only a transfer a standing `unclaimed_receipt` into that place booked (`RETURN_RECEIPT_MISSING`), so the books took it in once, no deposit can claim it later, and it is returned once (Q30). Book the receipt first, then the return; the receipt is not reversed while the return stands (`RECEIPT_RETURNED`, T9).
- T9. **Reversal:** once, by a new movement with `reverses_movement_id`, its own reason, and mirrored postings (`MOVEMENT_ALREADY_REVERSED`, `MOVEMENT_NOT_REVERSIBLE` for a reversal). No balance check on system accounts: a place may go below zero in the books, which the reconciliation then shows.
- T10. Movements never touch a customer wallet; wallet changes stay S02 adjustments.

### Reconciliation runs
- RN1. **Nightly:** pg-boss cron at 00:30 `Asia/Damascus` queues `reconciliation.run` for the day that ended (`business_date`); the unique `business_date` makes a second queueing a no-op (owner, 2026-10-11).
- RN2. **Manual:** "تشغيل الآن" starts a `manual` run; refused with `RECONCILIATION_RUNNING` while any run is `running`, and at most one manual run per 5 minutes (`RATE_LIMITED`).
- RN3. **Internal checks** (C1–C9) run in one `REPEATABLE READ` read-only transaction, so they see one snapshot; `snapshot_position` records it.
- RN4. **External checks** (E2–E4) read the outside balance first, then the books in a fresh snapshot, so a movement posted between the two reads is in the books. A result outside its range plus tolerance is **rechecked once after 10 minutes** (the run stays `running`, `recheck_at` set, `reconciliation.recheck` queued) and only the recheck's result is stored. A reader that fails or times out gives `skipped` with the reason (a warning, not a mismatch), and the next run tries again.
- RN5. A run is `finished` when every check has a result; a job that throws is retried twice (pg-boss), then the run is `failed` with its `failure` and an alert (NT1). A `running` run older than 1 hour is marked `failed` by the next run before it starts.
- RN6. **Count runs:** entering a Sham Cash count creates a `count` run with only check E4 for that currency, finished at once, mismatch rules as for any run.
- RN7. **Open mismatches:** for each `(check, subject)`, the newest result is open when it is a `mismatch` without an explanation. Explaining closes that result only; if the next run finds the mismatch again it is open again (owner, 2026-10-11: the books get fixed by a movement, an adjustment or a correction, not by notes).
- RN8. **Explain:** a note (5–500 characters) on a mismatch result that is the newest for its check and subject and has no explanation (`RESULT_NOT_EXPLAINABLE` otherwise). Audited, no re-authentication.
- RN9. Reconciliation writes no journal and changes no order, deposit, wallet, switch or supplier (owner, 2026-10-11).

### Internal checks (exact: any difference is a mismatch; owner, 2026-10-11)
- C1. `journal_balance`: every journal's postings sum to zero per currency and number `posting_count`.
- C2. `ledger_total`: all postings sum to zero per currency.
- C3. `wallet_non_negative`: no customer wallet below zero.
- C4. `account_journal_kinds`: every posting's account kind is allowed for its journal kind (`purchase`: wallet, `sales_revenue`; `refund`: wallet, `refunds`; `cost_of_goods`: `cost_of_goods`, `supplier_prepaid`; `deposit`: wallet, `sham_cash_receipts`, `currency_exchange`, `usdt_receipts`, `deposit_rounding`; `adjustment`: wallet, `adjustments`; `treasury`: places, `transfer_fees`, `currency_exchange`, `supplier_corrections`).
- C5. `attempt_cost`: every attempt with `delivered_quantity > 0` and a unit cost above zero has exactly one cost journal (`cost_journal_id`) of `unit cost × delivered units`, posting `cost_of_goods:USD` −cost and `supplier_prepaid:<its supplier>` +cost (rule LS1); no cost journal without such an attempt.
- C6. `order_purchase`: every order with `paid_at` has a purchase journal; a single order's journal takes exactly `total_usd_units` from its customer's wallet; a checkout's journal equals the sum of its orders' totals (S10); every purchase journal belongs to an order or a checkout; `sales_revenue` equals the sum of purchase journals.
- C7. `order_refund`: an order's `refunded_usd_units` equals its refund journal's wallet credit (0 and no journal when nothing was refunded); every refund journal belongs to one order; `refunds` equals the sum.
- C8. `deposit_credit`: every `credited` deposit has one journal `deposit:<id>` whose wallet credit equals `credited_usd_units`, and for Sham Cash SYP the SYP leg equals the received amount, for USDT the receipts leg the received amount and the rounding leg the difference; no deposit journal without a credited deposit.
- C9. `manual_journals`: every adjustment and treasury movement has its journal with the amounts, accounts and signs its row says (S02 M1–M3, rules M1–M3 below); no `adjustment` or `treasury` journal without its row.
- Each failing check lists up to 50 offending ids and the total count.

### External checks (tolerance $1, editable; owner, 2026-10-11)
- E1. **Range and tolerance:** a result is `ok` when `allowed_low − tolerance ≤ actual ≤ allowed_high + tolerance`, else `mismatch`. For SYP the tolerance is the USD tolerance × today's rate, rounded up to whole pounds.
- E2. `supplier_balance` per supplier with a balance API (not `manual`): the adapter's balance read now; books = held on `supplier_prepaid:<code>`; allowed range `[held − in-flight, held]`, where in-flight = Σ `unit cost × quantity` of its open attempts (`sending`, `pending`, `unknown`), since a supplier may charge before it delivers. A balance in another currency than USD is `skipped` ("عملة غير مدعومة").
- E3. `usdt_balance` per network: the official USDT balance of the store's address (server environment) by the chain reader; books = held on `usdt_receipts:<network>`; allowed range `[held, held + uncredited]`, uncredited = Σ recorded transfers to the address (`usdt_transfers`) whose block time is after the standing opening's (earlier ones are inside the opening amount), not credited to a deposit, not claimed by a manual deposit or an `unclaimed_receipt` movement reference, and not named by a standing `return_to_sender` movement from the place (Q30, owner 2026-10-28). Details list them. Transfers below $1 are not recorded (ADR 0018); their total stays within the tolerance or is booked as `unclaimed_receipt`.
- E4. `sham_cash_count` per currency (count runs only): the amount the admin typed from the Sham Cash app; books = held on `sham_cash_receipts:<currency>`; allowed range `[held, held + under review]`, under review = Σ declared amounts in that currency of deposits in `submitted` (the money may have arrived before the decision).
- E5. **Warnings** (not mismatches, no alert except as rule NT1 says): `opening_missing` (a place in use without an opening balance; its external check is `skipped`), `count_stale` (no Sham Cash count in either currency for more than 7 days, editable), `order_conflicts` (conflict events, S08 F5, during the business day: a possible double delivery to settle with a supplier correction), `reader_failed` (rule RN4).
- E6. `manual` and `fake` suppliers: no external check for `manual` (its held amount is negative when the admin paid from their own pocket: the panel says "مستحق لك"); `fake` is checked against its fake balance like a real supplier, so the flow can be tested.

### Reports
- RP1. **Period:** `from` and `to` are `Asia/Damascus` dates, inclusive, at most 366 days (`REPORT_PERIOD_INVALID`); presets today, yesterday, last 7 days, this month, last month. Rows by day.
- RP2. **Real customers only** in R1–R5 (`is_test` false), as the dashboard (ADR 0025).
- RP3. **R1 Sales and profit** (`sales`), by orders finished in the period (`finished_at`), ADR 0025 definitions: per day: delivered orders (`delivered` and `partially_refunded`), sales = Σ delivered units × unit price, cost = Σ their delivered attempts' units × unit cost, profit, margin %; a totals row. The figures equal the dashboard's for the same day.
- RP4. **R2 Breakdown** (`breakdown?by=game|product|supplier`): the same figures grouped; by supplier, per delivered attempt (an order split between suppliers counts on each for its units), plus attempts sent, failed and the failure rate. Sorted by sales, descending.
- RP5. **R3 Deposits** (`deposits`), by `decided_at` in the period: per method: credited count and USD, for Sham Cash SYP the pounds received, rejected and expired counts, median review time (Sham Cash), and `manual_deposit` adjustments on their own line.
- RP6. **R4 Refunds and failures** (`refunds`): refunded and partly refunded orders by refund reason (count and USD); per product the refund rate (refunded or partly refunded ÷ finished orders); per supplier the attempt failure rate (failed ÷ resolved attempts, by `resolved_at`).
- RP7. **R5 Top customers** (`customers`): the top 50 by sales in the period: name, email, delivered orders, sales, profit, deposits credited, a link to the profile (owner, 2026-10-11: name and email only).
- RP8. **R6 Money movement** (`ledger`), from the ledger by journal time: per day, deposits credited (per method), purchases, refunds, cost of goods, adjustments (credits and debits per category), treasury movements (funding, withdrawals, injections, transfers), transfer fees, supplier corrections, rounding gains; and for the period each place's held amount at the start and end. Every row that touches a wallet shows test customers' share on its own line. It reconciles with R1 only over long periods (ADR 0025).
- RP9. Money is shown in USD with cents; costs and profits keep sub-cent precision in the data and display rounded half-up to the cent. Reports never show SYP except R3's pounds received.

### Excel export
- X1. Each report exports as one `.xlsx` (streamed by the API): one sheet named for the report, right-to-left, Arabic headers, a title row with the period and the export time, the totals row computed on the server in integer units (no formulas), dates as dates, money as numbers from the contracts' exact decimal strings with a `$#,##0.00` format (`#,##0` for pounds).
- X2. Text cells are written as strings, never as formulas, whatever they start with (formula injection).
- X3. File name `vertex-<report>-<from>-<to>.xlsx`, Latin. No codes, phone numbers, player IDs or IPs (owner, 2026-10-11).
- X4. Each export writes an audit entry (`report.exported`); 10 exports a minute at most (`RATE_LIMITED`).

## Money flows
- LS1 (correction of S08 M2): **Cost of goods** per delivered attempt, journal `cost_of_goods`, key `order:<id>:cost:<attempt>`: `cost_of_goods:USD` **−cost**, `supplier_prepaid:<supplier>` **+cost**. Also for S11's manual fulfil (MF-M1).
- M1. **Transfer, same currency** (journal `treasury`, key `treasury:<movement id>`): source account **+sent**, destination account **−received**, `transfer_fees:<currency>` **−(sent − received)** when above zero. Example: funding WDGZone with 500 USDT that arrives as 499: `usdt_receipts:usdt_trc20` +500, `supplier_prepaid:wdgzone` −499, `transfer_fees:USD` −1. A supplier's held amount (rule LS2) rises by 499 and falls by each delivery's cost.
- M2. **Transfer, two currencies**: source **+sent** (its currency), `currency_exchange:<source currency>` **−sent**, `currency_exchange:<destination currency>` **+received**, destination **−received**. Balances per currency; the implied rate is on the movement.
- M3. **Supplier correction**: `increase`: `supplier_prepaid:<code>` **−amount**, `supplier_corrections:USD` **+amount**; `decrease`: the signs swapped.
- M4. **Reversal**: the original's postings with opposite signs, key `treasury:<reversal id>`.
- M5. Opening balances are transfers from `outside` (`owner`) and follow M1 or M2.
- Nothing else in S13 moves money: runs, counts, explanations, settings and reports post nothing.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/admin/reconciliation` | Admin | — | `reconciliationOverviewSchema` (latest finished nightly run, running run, open mismatches, warnings, last Sham Cash counts, settings) | — |
| `GET /api/admin/reconciliation/runs` | Admin | cursor, `trigger?` | page of `reconciliationRunSchema` | `VALIDATION_FAILED` |
| `GET /api/admin/reconciliation/runs/:id` | Admin | — | run with its results and explanations | `NOT_FOUND` |
| `POST /api/admin/reconciliation/runs` | Admin | — | `202` run | `RECONCILIATION_RUNNING`, `RATE_LIMITED` |
| `POST /api/admin/reconciliation/results/:id/explanation` | Admin | `explainResultSchema` (`note`) | `201` result with explanation | `NOT_FOUND`, `RESULT_NOT_EXPLAINABLE` |
| `POST /api/admin/reconciliation/sham-cash-counts` | Admin, `Idempotency-Key` | `shamCashCountSchema` (`currency`, `countedUnits`) | `201` count run with its result | `VALIDATION_FAILED`, `RECONCILIATION_RUNNING`, `IDEMPOTENCY_KEY_REUSED` |
| `GET /api/admin/reconciliation/settings` · `PUT` | Admin; `PUT` re-authentication | `reconciliationSettingsSchema` | settings | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` |
| `GET /api/admin/treasury/places` | Admin | — | `moneyPlacesSchema` (per place: books held, last external balance and time, difference, opening recorded) | — |
| `GET /api/admin/treasury/movements` | Admin | cursor, `place?` | page of `treasuryMovementSchema` | `VALIDATION_FAILED` |
| `POST /api/admin/treasury/movements` | Admin, re-authentication, `Idempotency-Key` | `createTreasuryMovementSchema` (`from`, `to`, `sentUnits`, `receivedUnits`, `outsideCategory?`, `openingBalance?`, `externalReference?`, `reason`, `amountConfirmationUnits?`) | `201` movement (`200` replay) | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`, `TREASURY_PLACES_INVALID`, `MOVEMENT_RECEIVED_EXCEEDS_SENT`, `OPENING_BALANCE_EXISTS`, `EXTERNAL_REFERENCE_TAKEN`, `AMOUNT_CONFIRMATION_REQUIRED`, `AMOUNT_CONFIRMATION_MISMATCH`, `IDEMPOTENCY_KEY_REUSED` |
| `POST /api/admin/treasury/supplier-corrections` | Same | `createSupplierCorrectionSchema` (`supplier`, `direction`, `amountUnits`, `orderNumber?`, `externalReference?`, `reason`, `amountConfirmationUnits?`) | `201` movement | as above, `NOT_FOUND` (order) |
| `POST /api/admin/treasury/movements/:id/reverse` | Same | `reverseTreasuryMovementSchema` (`reason`, `amountConfirmationUnits?`) | `201` movement | `NOT_FOUND`, `MOVEMENT_ALREADY_REVERSED`, `MOVEMENT_NOT_REVERSIBLE`, `AMOUNT_CONFIRMATION_*`, `IDEMPOTENCY_KEY_REUSED` |
| `GET /api/admin/reports/:kind` | Admin | `reportQuerySchema` | the report's schema | `VALIDATION_FAILED`, `REPORT_PERIOD_INVALID` |
| `GET /api/admin/reports/:kind/export` | Admin, audited | `reportQuerySchema` | `.xlsx` stream (`Content-Disposition: attachment`) | as above, `RATE_LIMITED` |

- Every admin route answers the guard's codes (S01). Responses are `Cache-Control: no-store`.
- Statuses: `409` for `RECONCILIATION_RUNNING`, `RESULT_NOT_EXPLAINABLE`, `OPENING_BALANCE_EXISTS`, `EXTERNAL_REFERENCE_TAKEN`, `MOVEMENT_ALREADY_REVERSED`, `MOVEMENT_NOT_REVERSIBLE`, `IDEMPOTENCY_KEY_REUSED`; `400` for `TREASURY_PLACES_INVALID`, `MOVEMENT_RECEIVED_EXCEEDS_SENT`, `REPORT_PERIOD_INVALID`, `AMOUNT_CONFIRMATION_*`.
- New error codes: `RECONCILIATION_RUNNING`, `RESULT_NOT_EXPLAINABLE`, `TREASURY_PLACES_INVALID`, `MOVEMENT_RECEIVED_EXCEEDS_SENT`, `OPENING_BALANCE_EXISTS`, `MOVEMENT_ALREADY_REVERSED`, `MOVEMENT_NOT_REVERSIBLE`, `REPORT_PERIOD_INVALID`.
- After the change: `openapi:export` and the admin client regenerated.

## Jobs and integrations
- `reconciliation.run` (new queue, `singleton`): cron `30 0 * * *` in `Asia/Damascus` with `{ businessDate }`; the API queues `{ runId }` for manual runs. Creates or loads the run (unique `business_date`), runs C1–C9, then E2 and E3, stores results, queues the recheck or finishes (RN3–RN5). Safe twice: results are unique per `(run, check, subject)` and a finished run is not run again.
- `reconciliation.recheck` (new, `stately` by run): at `recheck_at`, repeats only the external checks that were off, stores their results, finishes the run and queues the alert.
- Chain readers gain `getUsdtBalance(address): Promise<bigint raw>` (TronGrid TRC-20 balance; BSC `eth_call balanceOf` on the official contract at the latest finalized block); the fake reader returns the sum of the fake transfers to the address plus a scripted offset (money moved in or out outside the deposit flow). New command `pnpm --filter @vertex-digital/worker usdt:fake-balance --method <usdt_trc20|usdt_bep20> --adjust <±usd> | --reset` (the `AGENTS.md` table gains it).
- Supplier balances: the run calls each adapter's existing balance read (S07 H5), inserting a `supplier_balance_reads` row; the fake supplier's `--balance` scripts it.
- Telegram: new message kind `reconciliation_alert` (rule NT1); the `daily_summary` params gain `reconciliation: { date, status, mismatches, open } | null`.
- No email, no push, no customer notification.

## Screens

### Admin (Arabic, RTL)
- **`/reconciliation`** (navigation "المطابقة", with a red count badge of open mismatches):
  - Status card: the last nightly run ("آخر مطابقة: ليلة 10 تشرين الأول، 00:31") with "الدفاتر سليمة" (success) or "N حالات عدم تطابق" (danger), warnings, the running run with a spinner, "تشغيل الآن".
  - "حالات مفتوحة" list: each open mismatch with its check label, subject, books, actual, allowed range, difference, the time first seen, the offending ids as links (orders, deposits, adjustments, movements), and "شرح" (a dialog with the note). Internal mismatches first and in the danger color with "خطأ في الدفاتر: يحتاج مراجعة فنية".
  - "أماكن المال" table: each place with books held, the last external balance and its time, the difference, and actions "تسجيل حركة" and, for Sham Cash, "جرد الرصيد" (a dialog: currency, the amount typed from the app, the books shown only after saving so the count is not anchored). The `manual` supplier shows "مستحق لك" when below zero.
  - "الحركات" tab: the movements list (date, from → to, sent, received, fee or rate, category, reference, reason, admin), filter by place, "عكس" on movements not reversed. The movement dialog: from, to, amounts (received prefilled with sent for the same currency), category when outside, opening balance switch (with the proposed amount), reference, reason, the confirmation field above $100, re-authentication. The supplier correction dialog from the supplier row.
  - "السجل" tab: past runs with their counts; a run's page lists every check with its result.
  - Settings drawer: tolerance and stale days, re-authentication.
  - Loading: skeletons; empty (no run yet): "لم تجرِ أي مطابقة بعد" with "تشغيل الآن"; error: the standard block with retry.
- **`/reports`** (navigation "التقارير"): tabs R1–R6, a period picker with the presets, the breakdown selector on R2, a table with a totals row (and a daily sales and profit line above R1), "تصدير Excel". Empty period: "لا بيانات في هذه الفترة". Sorting by column on the client. Customer rows link to `/customers/$id`, products and games to the catalog.
- **Dashboard** (S11): attention items `reconciliation_open` (count, link `/reconciliation`), `reconciliation_missing` (no finished nightly run in 26 hours), `sham_cash_count_due` (rule E5).
- E2E with RTL screenshots: the reconciliation page with an open mismatch, the movement dialog, the count dialog, a report with data.

## Audit and notifications
- Audit entity types `treasury_movement`, `reconciliation_run`, `reconciliation_result`, `reconciliation_settings`, `report`. Actions, in the transaction of the change:
  - `treasury_movement.created` (kind, from, to, sent, received, currencies, rate, category, opening balance, order id, reference, journal id), `treasury_movement.reversed` (the same plus the original id); re-authenticated, reason = the reason.
  - `reconciliation_run.started` (manual and count runs: trigger; for a count, currency and counted amount).
  - `reconciliation_result.explained` (result, check, subject, difference; reason = the note).
  - `reconciliation_settings.changed` (before, after).
  - `report.exported` (kind, breakdown, from, to, row count).
  - Nightly and recheck runs are system actions recorded on the run itself, not in the audit log.
- NT1. **Telegram** (`reconciliation_alert`, `dedupe_key` `reconciliation:<run id>`), at most one per run, sent when the run `failed`, or found a mismatch that is new (not open in the previous result for the same check and subject) or whose difference moved by more than the tolerance, or a warning new since the previous nightly run (owner, 2026-10-11: problems only). Content: the date, "⚠️ عاجل" when any internal check failed, up to 10 lines (check label, subject, difference), the open total, a link to `/reconciliation`. No customer data.
- NT2. **Daily summary** (22:30): one line with the last nightly run's state and the open count.
- Customers are never notified.

## Abuse and fraud
| Threat | Control |
|---|---|
| A stolen admin session moves money out (records a fake withdrawal to hide real theft, or funds a supplier twice) | Re-authentication and the typed confirmation above $100; audit entry; movements are append-only and reversible only by a new row; the nightly external checks compare with real balances, so a recorded movement that did not happen shows as a mismatch |
| Explaining a mismatch away | The Telegram alert is sent before any note; a note closes only that result and the next run reopens a lasting difference (RN7); notes are audited |
| Booking the same outgoing transfer twice | Unique external reference per source place (T8); `Idempotency-Key`; journal key `treasury:<id>` |
| A supplier charging twice (double delivery) or not refunding | E2 against the supplier's own balance with the in-flight range; `order_conflicts` warning; settled by a supplier correction with the order number |
| A lying or compromised chain reader or supplier API | Internal checks do not depend on them; a balance that does not match alerts; one reader per network is an accepted risk (ADR 0018) |
| A wrong Sham Cash count to hide a shortfall | The count is audited with its amount; the books are shown only after saving; a count below the books is a mismatch and alerts |
| Formula injection in Excel (a product or customer name starting with `=`) | Text cells are strings, never formulas (X2) |
| Exports leaking personal data | Name and email only, no phones, player IDs, IPs or codes; admin-only route; audited; rate-limited |
| Running reconciliation in a loop to load the database | One running run at a time; manual runs at most one per 5 minutes; read-only snapshot transaction |
| Test money inflating reports | R1–R5 exclude test customers; R6 shows their share separately |

## Edge cases
1. A delivery posts its cost between the supplier read and the books read: the books include it (RN4 reads the books second); an attempt still open is in the in-flight range.
2. A USDT deposit lands minutes before the run and is credited by the scan during the recheck window: the recheck sees it in the books.
3. A supplier read fails at night: `skipped` with `reader_failed`; an alert only if it is new; the next run or a manual run tries again.
4. The nightly job runs twice for the same date (restart): the unique `business_date` makes the second one load the same run and stop if it is finished.
5. A manual run is requested while the nightly run is running: `RECONCILIATION_RUNNING`.
6. A count is entered while a run is running: `RECONCILIATION_RUNNING`; the dialog keeps the amount and retries.
7. A Sham Cash deposit is credited after a count was typed: the count is compared with the books at the moment of saving; later credits do not change it.
8. The owner withdraws more than a place holds: allowed (T9); the place shows a negative held amount and its external check mismatches until fixed.
9. A supplier is archived with money left: still a place; a movement back out or a correction brings it to zero.
10. A supplier reports its balance in another currency: E2 `skipped` with the reason; the books still show USD.
11. A development database holds cost journals with S08's old signs: C5 fails with their ids; reset it with `pnpm db:setup-local`.
12. Reversing an opening balance: allowed; the place has no opening again (rule T6 then allows a new one).
13. A report for a period with no data: empty tables and totals of zero; the export still has the title and header rows.
14. A report across the day of a rate change: no effect (USD only; R3's pounds are the amounts received).
15. An order finished at 23:59:59 Damascus time counts on that day in R1 and on the dashboard alike (`Asia/Damascus` day boundaries).
16. Midnight passes while the nightly run is running: `business_date` was fixed when it was queued.
17. A large history: the internal checks are SQL aggregates over indexed columns; acceptable for V1 volumes (a few million postings); the run's duration is shown on its page.

## Open questions
None. Every point above was answered by the owner on 2026-10-11 or follows from the ADRs. The ledger sign correction (LS1) is a technical fix recorded in ADR 0027.

## Acceptance
- End-to-end in the browser (development, fake supplier and fake chain reader):
  1. Reset the development database (`pnpm db:setup-local`), start `pnpm dev`, sign in to the panel. Open `/reconciliation`: "لم تجرِ أي مطابقة بعد". Press "تشغيل الآن": internal checks pass; the fake supplier and both USDT networks show `opening_missing`.
  2. `supplier:fake --balance 200`; on the fake supplier's row record an opening balance from outside (owner): the dialog proposes 200; save with re-authentication and the typed confirmation.
  3. `usdt:fake-balance --method usdt_trc20 --adjust 10`; record the TRC20 opening of 10 from outside (owner). Credit a fake USDT deposit of 25.0037 (`usdt:fake-transfer`); the fake balance follows the transfer. Record a Sham Cash USD count of 0. Run: everything `ok`, BEP20 still `opening_missing`.
  4. Record a TRC20 → outside (owner) withdrawal of 5 by mistake, then reverse it: both rows show, the place is back to its amount.
  5. Buy "60 UC" for a real customer (`order:place`) delivered by the fake supplier at its cost; set `supplier:fake --balance` to 200 minus that cost; run: all `ok`.
  6. Set `supplier:fake --balance 150` and run: the run waits for its 10-minute recheck, then a `supplier_balance` mismatch appears and a Telegram message is written to the log transport (`TELEGRAM_TRANSPORT=log`); explain it; run again: it reopens.
  7. Record a supplier correction `decrease` of the difference with a reason; run: `ok`.
  8. Record a transfer TRC20 → fake supplier, 20 sent and 19 received: the $1 fee shows; run `usdt:fake-balance --method usdt_trc20 --adjust -20` and `supplier:fake --balance` 19 higher; run: `ok`.
  9. Open `/reports`: R1 shows today's sale with the same sales and profit as the dashboard; R2 by supplier shows the fake supplier; R3 the USDT deposit; R6 the deposit, purchase, cost, transfer and fee. Export R1 and R6: the files open in Excel right-to-left with the totals.
- Tests:
  - Unit (contracts): `heldUnits`, `withinRange`, `impliedRate`, the place map, schemas (amount rules T3, categories T4).
  - Database (`packages/db`): each check C1–C9 passes on a clean ledger and fails, with the offending ids, on a planted fault (a raw insert as the owner role in the test); the cost journal signs (LS1) and an S08/S11 regression; movement postings M1–M4; append-only triggers and grants on the new tables; one running run (partial unique index); one nightly run per date.
  - API: each route's success, `401`, the guard's codes; re-authentication on movements, reversals and settings; idempotent replays and `IDEMPOTENCY_KEY_REUSED`; concurrent reversals (one wins); `OPENING_BALANCE_EXISTS`; `RESULT_NOT_EXPLAINABLE` on an old or explained result; report period limits; the export's content type, audit entry, string cells for a name starting with `=`, and no phone column.
  - Worker: the run with the fake reader and supplier (ok, mismatch, recheck clears, recheck confirms, reader failure skipped), the alert rules (new, unchanged, moved beyond tolerance, failed run), the cron date, a stale `running` run marked failed.
  - Reports: R1 equals the dashboard's figures for the same day; test customers excluded; supplier attribution of a split order; day boundaries in `Asia/Damascus`.
  - E2E and RTL screenshots: `/reconciliation` (open mismatch, movement dialog, count dialog), `/reports` (R1 with data, R2 by supplier).

## Implementation plan
Three PRs, each with its checks:
1. Contracts, db (new tables and migration, the LS1 sign fix with its tests, treasury posting functions, the checks as queries in `packages/db/src/reconciliation`) and api (`reconciliation`, `treasury`, `reports` modules, the Excel writer).
2. Worker: the run and recheck jobs, chain balance reads (live and fake) and the `usdt:fake-balance` command, Telegram alert and daily summary line.
3. Admin: `/reconciliation` (status, open mismatches, places, movements, counts, history, settings), `/reports` with export, dashboard items, E2E.

## Settled in implementation
- PR 1 (contracts, db, api):
  - `outside_funds` is shown as stored, not flipped: a transfer from outside posts +sent on it (M1), so its balance is what the owner and others brought in, net. LS2's "−balance" for it contradicted M1 and its own label; `heldUnits` flips the asset and expense accounts only.
  - `treasury_movements` lives in its own schema file, owned by the api `treasury` module; the reconciliation tables are the `reconciliation` module's. A movement's currencies are tied to its accounts by composite foreign keys on `(account, currency)`, as postings are, instead of a trigger; `treasury_movements_guard` (migration 0045) checks the account kinds, the outside category, the opening and the reversal.
  - A reversal repeats its original's kind, accounts and amounts, with mirrored postings (M4) and no external reference, so the reference stays claimed by the original.
  - Rule T6 with edge case 12: a movement and its reversal cancel out, so a place whose movements are all reversed counts as empty and may take an opening.
  - `reconciliation_runs.idempotency_key` holds a count's `Idempotency-Key` (set exactly for `count` runs).
  - Warnings are results: `count_stale` and `order_conflicts` are checks answering `ok` or `warning`; a skipped external check carries its reason (`opening_missing`, `reader_failed`, `currency_unsupported`) in `details.reason`, and every reason but the currency counts as a warning.
  - The implied rate is SYP per USD with 4 decimals, rounded half-up, as the store's rates; the postings carry the exact amounts.
  - A failing check lists its 50 newest offending ids (UUIDv7 order).
  - A manual run asked while a run is running answers `RECONCILIATION_RUNNING` before the 5-minute rate.
  - R6 counts a treasury movement at its USD side; a movement in pounds only (Sham Cash SYP from or to outside in pounds) is left out of R6, as RP9 keeps reports in USD.
  - The Excel export uses `exceljs` (streamed); text is written as string cells, which `exceljs` never turns into formulas.
  - Moved to the PR that first uses them: the `reconciliation_alert` Telegram kind, the daily summary line and the chain readers' balance read (PR 2); the dashboard's attention kinds (PR 3, with the `/reconciliation` page they link to).
- PR 2 (worker):
  - The nightly cron cannot carry a date (a schedule's data is fixed): it sends `{}`, and the job names the Damascus day 12 hours before it runs, so a late or retried job still names the night that ended. The payload `{ businessDate }` stays for a replay.
  - A nightly run waits while another run is running: the job sends itself again (`{ businessDate }`) to start two minutes after the blocking run's recheck, or in two minutes, so a manual run waiting for its 10-minute recheck at 00:30 never loses the night; a stale run (over an hour) is failed first. A run job is retried twice (one minute, then doubling); after the last try the run is `failed` with the error's class and message and its alert.
  - The recheck reads again the external checks of the run that have no result yet (the ones off their range), so nothing extra is stored on the run; a second delivery of the run job finds `recheck_at` set and does nothing.
  - The run's supplier read is the balance job's own read (`SupplierBalancesJob.read`): recorded in `supplier_calls`, appended to `supplier_balance_reads` with rule H5's repricing and messages. Suppliers checked are those the balance job reads (configured, in this build, not `manual`); a read that fails, or credentials that do not decrypt, is `reader_failed`, and `opening_missing` wins while the place has none. An adapter without a balance read is not checked.
  - The TRON balance is TronGrid's `/v1/accounts/<address>?only_confirmed=true` (the TRC-20 list, official contract only; an account never activated is 0); the BSC balance is `eth_call balanceOf` at the `finalized` block. Both floor to USD units.
  - The fake chain keeps each network's offset in the same file as its transactions (`{ transactions, offsets }`; a file of transactions only still reads). Its balance is the final official-USDT transfers to the address, less those from it, plus the offset; `usdt:fake-balance` prints the balance the worker will read.
  - `count_stale` (subject `sham_cash`) warns only once Sham Cash is in use (its receipts accounts hold postings), so a new store gets no warning before its first deposit. `order_conflicts` (subject `orders`) covers the night's Damascus day; a manual run covers the day so far.
  - Alert rule NT1: a mismatch is new when the previous result of its check and subject (in an earlier run) is not an open mismatch; an internal check "moves" on any change of its difference or count (exact checks); an external one when its difference moved by more than the tolerance (SYP at today's rate). A warning is new when the previous finished nightly run has no warning on that check and subject. A count run alerts by the same rule, in the count's transaction (`finishReconciliationRun`, shared by the API and the worker).
  - A stale run failed by the next run (RN5) gets no alert of its own: the next run's results and the overview show it.
- PR 3 (admin screens):
  - The navigation badge reads `GET /api/admin/reconciliation/counts` (`{ open }`, `ReconciliationCounts`) every minute in the background, as the orders badge does, instead of the overview with its per-mismatch reads.
  - Dashboard items: `reconciliation_open` counts the open mismatches; `reconciliation_missing` shows while no `schedule` run finished in the last 26 hours, a new store included, with the last finished one's time; `sham_cash_count_due` is the `count_stale` rule (E5) read live with the current settings. All three link to `/reconciliation`.
  - Supplier amounts are typed with up to 6 decimals (`parseUsd(text, { subCent: true })`, rule T3); an opening into a supplier from outside proposes the sent amount rounded up to the cent and the received amount exact, the difference a fee. Pounds are typed as whole pounds.
  - The movement dialog shows the typed confirmation above $100 with pounds at today's rate (or always without a rate); an `AMOUNT_CONFIRMATION_REQUIRED` answer shows it too.
  - Reports show USD rounded half-up to the cent (`formatUsdCents`, rule RP9). The period defaults to the last 7 days; R1's daily sales and profit are two small lines. Product rows link to their game's catalog page, supplier rows to the supplier.
