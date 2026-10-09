# S02 — Wallet and ledger (F03)

Status: Approved · Date: 2026-10-07 · Scope: `docs/product/v1-scope.md` §F03 (and §F27 for the adjustment email) · ADRs: 0003, 0011, 0014, 0016

## Summary
Every customer holds one USD wallet on the append-only double-entry ledger that Phase 0 built (`postJournal`, ADR 0003). S02 makes the wallet visible and usable: the customer sees a wallet card (balance in USD, its SYP value once S03 adds the rate) and a timeline of every movement with its running balance; a balance chip in the store header. The admin finds a customer's wallet, reads it with internal reasons, and moves money by hand through **adjustments**: five categories, a mandatory internal reason, re-authentication, an audit entry, an email to the customer, a typed confirmation above $100, and a one-time "reverse" for mistakes. A ledger summary shows what the store owes its customers. Adjustments are also how test customers get money before deposits exist (S03, S04).

## In scope / out of scope
- In:
  - Customer wallet accounts, created on the first posting (rule W1), linked to the customer.
  - Store: wallet page (card and timeline), header balance chip.
  - Admin: wallet search, a customer's wallet page with the timeline, adjust dialog, reverse action, ledger summary card.
  - Wallet adjustments (table, five categories, reversal) and their journals, audit entries and email.
  - The timeline entry contract that later specs fill for their journal kinds (deposit, purchase, refund).
- Out (later or never):
  - Deposits (S03 Sham Cash, S04 USDT) and the "Deposit" button: the button appears with S03.
  - The exchange rate and the SYP line of the card: S03 (F04). Until then the card shows USD only (rule W9).
  - Purchases and refunds: S08 (F11).
  - In-site notification center and email preferences: S05 (F27) adds the adjustment event to both.
  - Live balance updates over SSE: S05 (notification center); S02 refreshes on navigation and after actions.
  - Freezing, limits, archiving customers and the full customer page: S12 (F19).
  - Reconciliation and reports: S13 (F20, F22).
  - Customer withdrawals and transfers between customers: never in V1 (ADR 0003).
  - Adjustments in SYP or any currency other than USD: not in V1.
  - A settings screen for the confirmation threshold: not in V1 (a constant, rule J6).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read own balance and timeline | Customer | Signed-in customer with a verified email |
| Search wallets, read a wallet and its timeline, read the ledger summary | Admin | The admin |
| Adjust a wallet, reverse an adjustment | Admin, re-authentication (rule D5 of S01) | The admin |

A customer can only ever read their own wallet: the customer routes take no customer id.

## Data

### `ledger_accounts` (exists; owner: `wallet`)
- Added `customer_id` uuid, nullable, foreign key to `customers`, unique. A check: `customer_id` is set if and only if `kind = 'customer_wallet'`.
- `ledger_accounts_keep_identity` (migration 0001) is extended: `customer_id` never changes either.
- Codes (unchanged rule, values fixed here): customer wallet `customer_wallet:<customer id>`; adjustment counter-accounts `adjustments:<category>` (kind `adjustments`, currency USD), one per category (rule J2).
- No rows exist in any environment, so the migration needs no backfill; it fails loudly if a `customer_wallet` row without a customer exists.

### `wallet_adjustments` (new; owner: `wallet`; append-only)
- `id` uuid v7, primary key.
- `customer_id` uuid, required, foreign key to `customers`.
- `direction` enum `adjustment_direction`: `credit` (adds to the wallet), `debit` (takes from it).
- `amount_usd_units` bigint, required, `> 0`, whole cents (a check: `% 10000 = 0`).
- `category` enum `adjustment_category`: `compensation`, `correction`, `cash_refund`, `manual_deposit`, `test_funds` (rule J1).
- `customer_note` text, nullable, 1–200 characters: shown to the customer on the timeline.
- `reason` text, required, 5–500 characters: internal; also the audit entry's `reason`.
- `deposit_method` enum `manual_deposit_method`: `sham_cash`, `usdt_trc20`, `usdt_bep20`; required if and only if `category = 'manual_deposit'` and the row is not a reversal.
- `external_reference` text, 1–100 characters (trimmed, stored as entered, compared upper-cased): the Sham Cash transaction number or the TXID; required with `deposit_method`. Unique index on `(deposit_method, upper(external_reference))` (rule J8).
- `reverses_adjustment_id` uuid, nullable, foreign key to `wallet_adjustments`, **unique**: an adjustment is reversed at most once (rule R2).
- `journal_id` uuid, required, foreign key to `ledger_journals`, unique.
- `idempotency_key` uuid, required, unique: the request's `Idempotency-Key` (rule J9).
- `admin_id` uuid, required, indexed, **no foreign key** (as `audit_entries.actor_id`): an append-only row must not pin the single admin row, which the CLI and the tests replace (settled in implementation, 2026-10-07).
- `created_at` timestamptz, required, default `now()`.
- Checks: a reversal has the opposite direction and the same amount and category as the original (enforced by the service and a trigger, since a check cannot read another row); a `test_funds` row belongs to a test customer (service, rule J4).
- Indexes: `(customer_id, created_at desc)`, the unique ones above.
- No `updated_at` or `archived_at`. A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`; the app role has `INSERT` and `SELECT` only (as `audit_entries`, ADR 0014).

### Contracts (`packages/contracts/src/wallet.ts`)
- `ADJUSTMENT_DIRECTIONS`, `ADJUSTMENT_CATEGORIES` with the directions each allows (rule J1), `MANUAL_DEPOSIT_METHODS`.
- `ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS = 100 * CURRENCY_SCALE.USD` (rule J6).
- `walletSchema` (balance), `walletEntrySchema` and `walletEntryPageSchema` (timeline, customer view), `adminWalletEntrySchema` (admin view), `walletSearchQuerySchema`, `walletSearchResultSchema`, `adminWalletSchema`, `createAdjustmentSchema`, `reverseAdjustmentSchema`, `adjustmentSchema`, `ledgerSummarySchema`.
- `walletSypValue(usdUnits, rate, stepUnits)` in `money.ts`: USD × rate rounded **down** to the step (rule W9), next to `sypDisplayPrice`, with its tests (the 100% coverage gate holds).

## States and rules

An adjustment has no states: it is written once, with its journal, and never changes. A reversal is a second adjustment that points at the first.

### Wallet rules
- W1. A customer's wallet account is created on the first posting to it, inside the posting transaction: `ensureCustomerWallet(tx, customerId)` in `packages/db/src/ledger` inserts it (`ON CONFLICT (code) DO NOTHING`) and returns its id. A customer without an account has a balance of 0 and an empty timeline; reading never creates an account.
- W2. The balance is the sum of the wallet's postings (`accountBalance`); no stored balance (ADR 0003).
- W3. A timeline entry is one journal that touches the wallet: its time, kind, the net signed amount on the wallet, the balance right after it, its reference, and the extras of its kind (rule W5). Newest first in **write order**: `ledger_postings.position`, an identity assigned when `postJournal` inserts the postings, after it locked and checked the wallets (settled in review, 2026-10-07). The journal's `created_at` is its transaction's start, so a debit begun before the credit it spends would sort before it and show a negative running balance; write order puts every debit after everything its balance check saw.
- W4. `balanceAfterUnits` of an entry = the sum of the wallet's postings up to and including its own, in the order of rule W3. It is computed by the query, never stored.
- W5. Entry extras by kind. S02 fills `adjustment`; later specs fill theirs without changing the shape:
  - `adjustment`: `{ category, customerNote, reversal: boolean }` (and, admin view only, the internal `reason`, the `adminName`, `depositMethod`, `externalReference`, and whether it has been reversed).
  - `deposit` (S03, S04): method, the deposit's reference code, and for SYP deposits the SYP amount and the rate used.
  - `purchase` and `refund` (S08): the order number and product name.
  - `checkout` (S10 rule M1): a cart's one `purchase` entry names its checkout, the order count and each order's number and product, in line order; `order` is then null.
- W6. Customer-facing labels come from i18n keys per kind and per adjustment category; a reversal shows "عكس: <category>". The customer never sees the internal reason, the admin's name, journal ids or account codes.
- W7. Timeline pages are cursor lists (ADR 0011, `lists.ts`): 30 entries by default, "load more".
- W8. The store header shows a balance chip (USD) for a signed-in customer, linking to the wallet page. It is read in the browser with the session cookie (as the account link is), so every page stays cached; signed-out visitors see no chip (settled in implementation, 2026-10-07: the store's rule for customer-specific parts, `apps/store/CLAUDE.md`).
- W9. The SYP value under the balance is `≈ <SYP>` from `walletSypValue`: USD × today's rate rounded **down** to the display step, so the store never shows more than the customer holds, with today's rate under it. S02 renders it only when a rate exists; the rate arrives with S03, so in S02 the card shows USD only and the code path is exercised by unit tests.
- W10. Wallet responses are never cached (`Cache-Control: no-store`).

### Adjustment rules
- J1. Categories and their allowed directions:

  | Category | Arabic label (i18n) | Credit | Debit | Notes |
  |---|---|---|---|---|
  | `compensation` | تعويض | ✓ | — | Goodwill or a make-good |
  | `correction` | تصحيح خطأ | ✓ | ✓ | Any mistake the ledger must fix |
  | `cash_refund` | استرداد نقدي | — | ✓ | The owner paid money back outside the system (ADR 0003, no withdrawals) |
  | `manual_deposit` | إيداع مسجَّل يدوياً | ✓ | — | A real payment that reached the store outside the deposit flow; method and external reference required |
  | `test_funds` | رصيد تجريبي | ✓ | ✓ | Test customers only (rule J4) |

  A direction a category does not allow fails validation (`VALIDATION_FAILED`). The table applies to new adjustments; a reversal always takes the opposite of its original's direction (rule R1), so a `manual_deposit` reversal is a debit.
- J2. Journal: kind `adjustment`, idempotency key `adjustment:<adjustment id>`, two postings: the customer wallet and the category's counter-account `adjustments:<category>` (created on first use like rule W1, via `ensureSystemAccount`). Amounts in rule M1.
- J3. The adjustment row, its journal and its audit entry are written in one READ COMMITTED transaction; any refusal rolls all three back.
- J4. `test_funds` is refused for a customer whose `is_test` is false (`ADJUSTMENT_NOT_ALLOWED`). Every other category is allowed for test customers too.
- J5. A debit never takes the wallet below zero: `postJournal` locks the wallet and refuses with `INSUFFICIENT_BALANCE`; the dialog shows the current balance. Money a customer owes beyond their balance is not tracked in V1 (freezing is S12).
- J6. Above $100 (`ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS`), the request must carry `amountConfirmationUnits` equal to `amountUnits`; otherwise `AMOUNT_CONFIRMATION_REQUIRED` (missing) or `AMOUNT_CONFIRMATION_MISMATCH`. The panel asks for the amount typed a second time, without paste. The server enforces it, not only the UI. There is no upper cap (owner, 2026-10-07).
- J7. Re-authentication (S01 rule D5) is required for adjusting and reversing (`REAUTHENTICATION_REQUIRED`).
- J8. `manual_deposit` needs `depositMethod` and `externalReference`; the reference is unique per method among adjustments (`EXTERNAL_REFERENCE_TAKEN`). S03 and S04 must refuse a Sham Cash transaction number or a TXID already recorded here, and S02's check must look at their tables once they exist (both specs carry this rule). A manual deposit is in USD only; the amount is what the admin decides to credit.
- J9. The panel sends an `Idempotency-Key` (UUID per dialog opening). The same key with the same body returns the first adjustment (`200`, no new journal, audit or email); with another body, `IDEMPOTENCY_KEY_REUSED`.
- J10. Amounts are whole cents, `> 0`, at most `Number.MAX_SAFE_INTEGER` units (the contract's `usdCentsSchema` minus zero).

### Reversal rules
- R1. "Reverse" on an adjustment creates a new adjustment with the opposite direction, the same amount, the same category, `reverses_adjustment_id` set, its own internal reason (required) and an optional customer note; same re-authentication, audit, email and idempotency as rule J9. Rule J6's confirmation applies to its amount too.
- R2. An adjustment is reversed at most once (unique `reverses_adjustment_id`): a second reversal, even concurrent, gets `ADJUSTMENT_ALREADY_REVERSED`.
- R3. A reversal cannot itself be reversed (`ADJUSTMENT_NOT_REVERSIBLE`); a further fix is a new `correction` adjustment.
- R4. Reversing a credit is a debit: refused with `INSUFFICIENT_BALANCE` when the customer already spent it. The admin then decides (a partial `correction` debit; freezing in S12).
- R5. Reversing a `test_funds` adjustment is allowed even if the customer is no longer a test customer (the flag cannot change in V1 anyway). Reversing a `manual_deposit` keeps its external reference claimed (rule J8): a wrong amount is fixed with a `correction` for the difference, a wrong reference by reversing and recording again with the right one.

### Ledger summary rules
- L1. The summary shows: the total of all customer wallets (what the store owes), split into real and test customers; the number of wallets with a balance above zero; and every system account with its kind, code and balance. Balances are computed from postings at read time.
- L2. The summary is read-only; nothing in S02 writes to a system account except adjustment journals.

## Money flows
- M1. **Credit adjustment** (`compensation`, `correction`, `manual_deposit`, `test_funds`): journal `adjustment`, key `adjustment:<id>`; postings: `customer_wallet:<customer>` **+amount** USD, `adjustments:<category>` **−amount** USD. No rate (USD only). Reversed by a debit reversal (R1).
- M2. **Debit adjustment** (`correction`, `cash_refund`, `test_funds`): same journal shape with the signs swapped: wallet **−amount**, `adjustments:<category>` **+amount**. Locks the wallet and checks the balance (rule J5). Reversed by a credit reversal (R1).
- M3. **Reversal**: the original's postings with opposite signs, journal key `adjustment:<reversal id>`; the original journal is never touched.
- Nothing else in S02 moves money. Deposits (S03, S04), purchases and refunds (S08) post their own journals through the same `postJournal` and show on the same timeline.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/wallet` | Customer | — | `walletSchema` (`balanceUnits`; `syp: { valueUnits, rate } \| null`) | `UNAUTHORIZED`, `EMAIL_NOT_VERIFIED` |
| `GET /api/wallet/entries` | Customer | `cursorQuerySchema` (limit default 30) | `walletEntryPageSchema` | `VALIDATION_FAILED` |
| `GET /api/admin/wallets` | Admin | `walletSearchQuerySchema` (`q`: 3–100 chars, matches email or phone prefix or name substring, case-insensitive; cursor) | page of `walletSearchResultSchema` (customer id, name, email, phone, is test, balance) | `VALIDATION_FAILED` |
| `GET /api/admin/wallets/:customerId` | Admin | — | `adminWalletSchema` (customer summary, balance, adjustment count) | `NOT_FOUND` |
| `GET /api/admin/wallets/:customerId/entries` | Admin | cursor | page of `adminWalletEntrySchema` | `NOT_FOUND` |
| `POST /api/admin/wallets/:customerId/adjustments` | Admin, re-authentication, `Idempotency-Key` | `createAdjustmentSchema` (`direction`, `amountUnits`, `amountConfirmationUnits?`, `category`, `reason`, `customerNote?`, `depositMethod?`, `externalReference?`) | `201` `adjustmentSchema` with `balanceAfterUnits` (`200` on a replay) | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`, `NOT_FOUND`, `INSUFFICIENT_BALANCE`, `ADJUSTMENT_NOT_ALLOWED`, `AMOUNT_CONFIRMATION_REQUIRED`, `AMOUNT_CONFIRMATION_MISMATCH`, `EXTERNAL_REFERENCE_TAKEN`, `IDEMPOTENCY_KEY_REUSED` |
| `POST /api/admin/wallet-adjustments/:id/reverse` | Admin, re-authentication, `Idempotency-Key` | `reverseAdjustmentSchema` (`reason`, `customerNote?`, `amountConfirmationUnits?`) | `201` `adjustmentSchema` (`200` on a replay) | `REAUTHENTICATION_REQUIRED`, `NOT_FOUND`, `INSUFFICIENT_BALANCE`, `ADJUSTMENT_ALREADY_REVERSED`, `ADJUSTMENT_NOT_REVERSIBLE`, `AMOUNT_CONFIRMATION_*`, `IDEMPOTENCY_KEY_REUSED` |
| `GET /api/admin/ledger/summary` | Admin | — | `ledgerSummarySchema` | — |

- Every admin route also answers the guard's codes (S01: `UNAUTHORIZED`, `FORBIDDEN`, `SESSION_IDLE_EXPIRED`, `TWO_FACTOR_REQUIRED`, `PASSWORD_CHANGE_REQUIRED`, `CROSS_ORIGIN_REFUSED`). A missing or non-UUID `Idempotency-Key` is `VALIDATION_FAILED`.
- Statuses (settled in implementation): `400` for `ADJUSTMENT_NOT_ALLOWED` and `AMOUNT_CONFIRMATION_*`; `409` for `INSUFFICIENT_BALANCE` (with `details.balanceUnits`, the balance the debit met), `EXTERNAL_REFERENCE_TAKEN`, `ADJUSTMENT_ALREADY_REVERSED`, `ADJUSTMENT_NOT_REVERSIBLE`, `IDEMPOTENCY_KEY_REUSED`. Adjustments of one wallet are serialized by a lock on its account row, so a parallel request with the same key or the same reversal is answered as a replay or `ADJUSTMENT_ALREADY_REVERSED`, never as a balance refusal.
- New error codes in `packages/contracts/src/errors.ts`: `ADJUSTMENT_NOT_ALLOWED`, `AMOUNT_CONFIRMATION_REQUIRED`, `AMOUNT_CONFIRMATION_MISMATCH`, `EXTERNAL_REFERENCE_TAKEN`, `ADJUSTMENT_ALREADY_REVERSED`, `ADJUSTMENT_NOT_REVERSIBLE`.
- After the change: `openapi:export` and the admin client regenerated (commands table in `AGENTS.md`).

## Jobs and integrations
- Email: each adjustment and reversal enqueues one `customer_wallet_adjusted` email in the same transaction (S01 outbox and `email.send` job, already safe to run twice). Params: `direction`, `amountUnits`, `category`, `reversal`, `at`. No reason, no note, no admin name (S01 email rule: no free text typed by someone else). Normal priority. The body links to the wallet page.
- No new worker jobs; no supplier, blockchain or Telegram calls.

## Screens

### Store (Arabic, RTL, phone width first; wallet pages are dynamic and never cached)
- **Header balance chip** (every page, signed in): wallet icon and `$12.50`; links to `/wallet`. Loading: a skeleton of the chip's width; error: the chip hides (the page still works).
- **`/wallet`**:
  - Card: "رصيدك" with the USD balance large; under it the `≈ … ل.س` line and "حسب سعر اليوم …" when a rate exists (S03). The "إيداع" button arrives with S03.
  - Timeline: one row per entry: an icon and label per kind (an adjustment shows its category, "عكس: …" for a reversal), the customer note on a second line when present, date and time, the signed amount (credit in the success color with `+`, debit neutral with `−`), and "الرصيد بعدها" with the running balance. "تحميل المزيد" at the end.
  - Empty: an illustration-free empty state "لا توجد حركات بعد" and, with S03, the deposit button.
  - Error: the standard error block with retry.
  - Signed-out visitors are redirected to sign-in and back.

### Admin (Arabic, RTL)
- **`/wallets`** (navigation item "المحافظ"):
  - Summary card (rule L1): total owed to real customers, to test customers, wallets above zero; a "الحسابات النظامية" expandable table (kind, code, balance).
  - Search box (3 characters minimum): results table (name, email, phone, a "تجريبي" badge, balance), cursor "load more"; row opens the wallet. Empty: "لا نتائج". Loading: table skeleton.
- **`/wallets/$customerId`**:
  - Header: name, email, phone, test badge, balance (and SYP with S03).
  - Timeline table: time, kind and category (with the customer note and, for a manual deposit, the method and reference), signed amount, balance after, internal reason (with the admin's name under it); a reversed adjustment shows "معكوس" linking to its reversal; a reversal links to its original. "عكس" action on adjustments that are not reversals and not reversed.
  - **Adjust dialog** ("تعديل الرصيد"): direction (إضافة / خصم), amount in USD (cents), category (only those allowed for the direction and the customer; `test_funds` only for test customers), method and external reference when `manual_deposit`, internal reason (required), customer note (optional, with "يظهر للعميل"), the current balance and the balance after; above $100 a second "أعد كتابة المبلغ" field (no paste). Submitting opens the re-authentication dialog when needed (S01) and retries. Errors show inline by code.
  - **Reverse dialog**: shows the original (direction, amount, category, date), the resulting balance, reason and note fields, the confirmation field above $100.
- Audit log (S01): the new actions and the `wallet_adjustment` entity type appear in its filters.

## Audit and notifications
- Audit actions (in `AUDIT_DETAILS`), entity type `wallet_adjustment` (added to `AUDIT_ENTITY_TYPES`), actor the admin, channel `admin`, `reason` = the internal reason:
  - `wallet_adjustment.created`: `{ customerId, direction, amountUnits, category, customerNote, depositMethod, externalReference, journalId, balanceAfterUnits }`.
  - `wallet_adjustment.reversed`: on the reversal row: `{ customerId, reversedAdjustmentId, direction, amountUnits, category, customerNote, journalId, balanceAfterUnits }`.
- Reads (wallet pages, search, summary) are not audited.
- Customer: the `customer_wallet_adjusted` email (owner, 2026-10-07); S05 adds the event to the notification center and to the email preferences (F27's event list gains "wallet adjusted").

## Abuse and fraud
| Threat | Control |
|---|---|
| A customer reads another wallet | Customer routes take no id; the wallet is the session's customer. API tests per route |
| Double submit or a retried request credits twice | `Idempotency-Key` unique on `wallet_adjustments`; journal key `adjustment:<id>` unique; replays return the first result |
| Two reversals at once reverse twice | Unique `reverses_adjustment_id`; the loser gets `ADJUSTMENT_ALREADY_REVERSED` |
| A debit races a purchase and the wallet goes negative | `postJournal` locks the wallet `FOR UPDATE` and checks the balance in the same transaction (ADR 0003) |
| A fat-finger amount (1000 for 10) | Typed confirmation above $100, enforced by the server; the dialog shows the balance after; reversal |
| A stolen admin session drains or inflates wallets | Re-authentication (password + TOTP within 5 minutes) for every adjustment and reversal; audit entry; customer email on every adjustment, so the customer notices |
| The same real payment credited twice (manual deposit, then the normal deposit flow) | External reference unique per method here, and S03/S04 check it against their own records (rule J8) |
| Test money mixed into real balances | `test_funds` only for test customers; the summary splits test from real; reports exclude test customers (S01) |
| Editing history to hide a mistake | Ledger, adjustments and audit tables are append-only (trigger + grants); fixes are new rows |
| Searching customers to enumerate personal data | Admin-only route; 3-character minimum; results capped per page; standard admin rate limits |

## Edge cases
1. A customer with no wallet account yet: balance 0, empty timeline, the chip shows `$0.00`; the first credit creates the account (W1). Two first credits at once: both `ensureCustomerWallet` calls end with the same account (`ON CONFLICT DO NOTHING`, then select).
2. A debit adjustment while a purchase debits the same wallet (from S08): the locks queue; the second one sees the first's posting and may get `INSUFFICIENT_BALANCE`.
3. The admin opens the adjust dialog, the customer spends meanwhile: the shown "balance after" is stale; the server decides and returns `INSUFFICIENT_BALANCE` with the dialog refreshing the balance.
4. Re-authentication expires between opening the dialog and submitting: `REAUTHENTICATION_REQUIRED`, the dialog re-authenticates and retries with the **same** `Idempotency-Key`.
5. The network drops after the server committed: the panel retries with the same key and gets the first adjustment; no second email.
6. Same key, different body (an edited dialog after a failure): `IDEMPOTENCY_KEY_REUSED`; the dialog generates a new key whenever a field changes after an error response.
7. Reversing a credit already spent: `INSUFFICIENT_BALANCE` (R4).
8. Reversing a reversal: `ADJUSTMENT_NOT_REVERSIBLE` (R3); the button is not shown.
9. An amount exactly $100.00: no confirmation needed (the rule is "above").
10. `amountConfirmationUnits` sent below the threshold: ignored if equal, `AMOUNT_CONFIRMATION_MISMATCH` if different.
11. A `manual_deposit` external reference differing only by case or surrounding spaces from an existing one: treated as the same (`EXTERNAL_REFERENCE_TAKEN`).
12. An unknown or non-UUID customer id or adjustment id: `NOT_FOUND`.
13. Timeline entries with the same `created_at` (journals of one transaction): ordered by write position (W3), so the running balance is stable across pages.
14. A customer's timeline grows long: pages use the `(account_id, position)` posting index; the running balance is computed per page as `balance − sum(newer entries)`.
15. A journal with two postings on the same wallet (none in S02, possible later): one timeline entry with the net amount (W3).
16. The admin adjusts a test customer that later stops being a test customer: not possible in V1 (`is_test` never changes).
17. No rate set yet (until S03): `walletSchema.syp` is null, the card shows USD only.

## Implementation notes
- `packages/db/src/ledger`: add `ensureCustomerWallet`, `ensureSystemAccount` and a `walletTimeline` read (shared by the api's customer and admin routes; S03/S08 extend the per-kind extras by joining their tables).
- `apps/api/src/modules/wallet`: controller(s), service, repository per ADR 0011; the adjustment service is the only writer of `wallet_adjustments`.
- Migration through `/db-migration`: `ledger_accounts.customer_id` and the trigger change; `wallet_adjustments` with its enums, checks, the reversal trigger (opposite direction, same amount and category, original not itself a reversal) and the append-only trigger and grants; the email template enum value.
- i18n keys for every journal kind, adjustment category, the reversal label, error codes and the email.

## Open questions
None. The SYP value of the balance depends on the rate and step from S03 (Q6), which S02 does not need to start.

## Acceptance
Owner's browser check (local, `pnpm dev`, emails written to files):
1. Panel: create a test customer (S01). Open "المحافظ": the summary shows $0 owed; search the customer by 3 letters of the name, then by phone.
2. Open the wallet, add a `test_funds` credit of $25.00 with a reason and a note: the re-authentication dialog appears, then the timeline shows `+25.00`, balance after `25.00`; the summary shows $25 owed to test customers.
3. Try $250 `compensation`: the second amount field appears; a different second value is refused; the same value succeeds.
4. Try a `cash_refund` debit of $1,000: refused with the insufficient-balance message showing the balance.
5. Reverse the $250 compensation: the timeline shows the reversal linked to the original; "عكس" is gone on both; a second reverse attempt (another tab) is refused.
6. Record a `manual_deposit` (Sham Cash, reference `ABC123`); record another with ` abc123 `: refused as already used.
7. Store: sign in as the test customer: the header chip shows the balance; `/wallet` shows each entry with its category label, note, sign and running balance, and never the internal reason; the email files for each adjustment exist and carry no reason or note.
8. Audit log: filter by entity type `wallet_adjustment`: every adjustment and reversal is there with the reason.
9. Try `test_funds` on a real (non-test) customer through the API: refused.

Tests:
- API: every route for success and 401; customer routes refuse admin sessions and admin routes refuse customer sessions; a customer only ever sees their own entries (two customers, each reads only theirs); adjust and reverse without re-authentication → `REAUTHENTICATION_REQUIRED`; each error code above.
- Money and concurrency (real PostgreSQL): 20 parallel debits on one wallet never go below zero; two parallel first credits create one account; parallel reversals of one adjustment → exactly one succeeds; the same `Idempotency-Key` in parallel → one adjustment, one journal, one audit entry, one email; a failed debit leaves no adjustment, journal, audit or email row.
- Database: `UPDATE`/`DELETE` on `wallet_adjustments` fail as the app role; the reversal trigger refuses a same-direction or different-amount reversal and a reversal of a reversal; `customer_id` on `ledger_accounts` cannot change; the `customer_id`/kind check.
- Timeline: running balance correct across page boundaries and equal timestamps; net amount for a journal with two wallet postings (fixture); the customer schema has no reason, admin or journal fields (schema test).
- Unit: `walletSypValue` (rounds down to the step, zero balance, large balances), category/direction table, `createAdjustmentSchema` (whole cents, confirmation rule at $100.00 and $100.01, method and reference only for `manual_deposit`).
- E2E with RTL screenshots: store wallet page (empty and with entries) and header chip in the dark theme at phone width; panel wallets search with summary, wallet page, adjust dialog (with the confirmation field), reverse dialog, in both themes.
