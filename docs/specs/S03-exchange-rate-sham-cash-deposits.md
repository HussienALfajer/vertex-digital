# S03 — Exchange rate and Sham Cash deposits (F04, F05)

Status: Approved · Date: 2026-10-08 · Scope: `docs/product/v1-scope.md` §F04, §F05 (A10, A12, A16; A02 and A09 hooks) · ADRs: 0003, 0006, 0008, 0011, 0014, 0016, 0017

## Summary
Customers in Syria pay through Sham Cash, a wallet app with no merchant API, so the transfer is checked by hand. Today there is no way for a customer to fund their wallet. S03 adds the admin's USD→SYP exchange rate with its history and the SYP value shown next to USD, and a Sham Cash deposit wizard. The customer picks SYP or USD and an amount. SYP amounts get a rate locked for 15 minutes. The wizard shows the store's Sham Cash account (QR and copy buttons) and a unique reference code for the transfer note, and takes the receipt by paste or upload. A status page then shows the real review ETA. The admin works a review queue: the receipt, the customer's history and fraud signals, then approve (with the Sham Cash transaction number and the amount received), reject with a reason, or ask once for a clearer receipt. An approval credits the wallet in one transaction with its journal, audit entry and email.

## In scope / out of scope
- In:
  - Exchange rate (F04): the admin sets the SYP-per-USD rate and the display step, with history, re-authentication and a typed confirmation for large changes. The SYP value is shown on the wallet card, in the admin wallet header, in the deposit wizard and on deposit entries. A stale-rate banner appears in the panel.
  - Sham Cash deposits (F05): deposit settings (account, QR images, limits, working hours, flag thresholds), the wizard, receipts (upload, re-encoding, hashes), the deposit list and status pages, the review queue and the decision actions, fraud flags (A10), the quote lock and requote (A12), and expiry of deposits that never got a receipt.
  - Deposit journals on the ledger (with SYP held in the books) and deposit entries on the wallet timeline (S02 rule W5).
  - One table that claims external payment references (Sham Cash transaction numbers, later TXIDs) across deposits and S02 manual-deposit adjustments (rule SC14).
  - Emails: deposit credited, deposit rejected, clearer receipt requested (A16, email part).
- Out (later or never):
  - The Telegram deposit card, approval from Telegram and the review-time reminder (A09): S05 (F07). S03 stores everything they need: flags, the target review time.
  - The in-site notification center and email preferences for deposit events: S05 (F27).
  - The per-method deposit switch and the emergency stop: S05 (F26). Until then, removing the Sham Cash account details or disabling a currency in the deposit settings stops new Sham Cash deposits.
  - Paying `awaiting_balance` orders after a credit (A02): S08/S09 hook into the credit transaction's after-commit point. S03 credits only.
  - USDT deposits: S04 (F06). The deposit page shows Sham Cash only until then.
  - Per-customer limit overrides and freezing: S12 (F19). S03 reads limits from the deposit settings only.
  - SYP prices on products: S06/S09. The ADR 0003 rule that refuses a step adding more than 2% to the cheapest active product is enforced once products exist (S06). S03 bounds the step to 1–50 SYP (rule FX3).
  - Reversing a credited deposit: not a deposit action. A mistaken credit is fixed with an S02 `correction` adjustment.
  - Sham Cash automation (Phase 4), deposit fees (none in V1, owner 2026-10-08), customer withdrawals (never in V1).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the Sham Cash deposit options, create, requote, submit a receipt, cancel, list and read own deposits | Customer | Signed-in customer with a verified email |
| Read the QR image of an enabled currency | Customer | Signed-in customer with a verified email |
| Read rates and their history, the deposit settings, the queue, a deposit, its receipts | Admin | The admin |
| Change the rate or step; change deposit settings; upload a QR image | Admin, re-authentication | The admin |
| Approve a deposit | Admin; re-authentication when the credit is above $100 or any flag is present (rule RV4) | The admin |
| Reject a deposit; ask for a clearer receipt | Admin | The admin |
| Expire deposits that got no receipt | Worker job | System |

A customer only ever reaches their own deposits. Customer routes look the deposit up by id **and** the session's customer, and answer `NOT_FOUND` for anyone else's.

## Data

### `exchange_rates` (new; owner: `rates`; append-only)
- `id` uuid v7, primary key.
- `syp_per_usd` numeric(12,4), required, `> 0`: new Syrian pounds per 1 USD (`exchangeRateSchema`).
- `display_step_syp_units` bigint, required, between 100 and 5,000 (1–50 SYP): the clean step for SYP display (rule FX3).
- `admin_id` uuid, required, no foreign key (as S02's `wallet_adjustments.admin_id`).
- `created_at` timestamptz, required, default `now()`.
- The current rate is the newest row. Index `(created_at desc)`.
- Append-only: a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`. The app role has `INSERT` and `SELECT` only.

### `deposit_settings` (new; owner: `deposits`; append-only versions)
One row per saved version; the current settings are the newest row. Before the first save, Sham Cash deposits are unavailable (rule SC1).
- `id` uuid v7; `admin_id` uuid (no foreign key); `created_at`.
- `sham_cash_account_name` text, 1–100 characters; `sham_cash_account_number` text, 1–64 characters: what the customer copies.
- `syp_enabled`, `usd_enabled` boolean. Enabling a currency requires its QR file.
- `syp_qr_file_id`, `usd_qr_file_id` uuid, nullable, foreign keys to `stored_files`.
- Limits, USD units in whole cents (checks: `> 0`, `% 10000 = 0`, min ≤ per-deposit ≤ daily for each tier):
  - `min_deposit_usd_units` (default $2);
  - `new_account_per_deposit_usd_units` ($50), `new_account_daily_usd_units` ($100);
  - `established_per_deposit_usd_units` ($300), `established_daily_usd_units` ($1,000).
- `review_hours_start`, `review_hours_end` time (default 10:00 and 22:00, `Asia/Damascus`, start < end); `review_target_minutes` integer 1–1440 (default 15).
- Flag thresholds: `flag_new_account_usd_units` ($25, whole cents), `flag_velocity_count` integer 1–50 (3: the fourth submission within 24 hours is flagged).
- The defaults live in `packages/contracts` (`DEPOSIT_SETTINGS_DEFAULTS`) and prefill the first save. They are not seeded.
- Append-only trigger and grants, as for `exchange_rates`.

### `stored_files` (new; owner: `files`)
- `id` uuid v7; `kind` enum `stored_file_kind`: `deposit_receipt`, `sham_cash_qr`; `storage_key` text, unique (a random path under the files root, never derived from user input); `content_type` text (`image/webp` for receipts, `image/png` for QR images); `byte_size` integer; `width`, `height` integer; `created_at`.
- Files live under `FILES_ROOT` (`shared/files/` on the server, ADR 0009; a git-ignored folder locally), outside the web root. A row and its file are never updated. Deleting files is out of V1 (receipts are evidence).

### `deposits` (new; owner: `deposits`)
- `id` uuid v7, primary key.
- `customer_id` uuid, required, foreign key to `customers`, indexed with `created_at desc`.
- `method` enum `deposit_method`: `sham_cash` (S04 adds `usdt_trc20`, `usdt_bep20`).
- `status` enum `deposit_status`: `pending`, `submitted`, `credited`, `rejected`, `expired`, `cancelled` (ADR 0006, 0017).
- `reference_code` text, unique: `VD-` + 5 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0, O, 1, I, L). Generated with a CSPRNG and retried on the unique conflict.
- `currency` enum `currency` (`SYP` or `USD`): what the customer sends.
- `declared_amount_units` bigint, `> 0`: the amount to send, in `currency` units. SYP in whole pounds (`% 100 = 0`); USD in whole cents.
- `declared_usd_units` bigint: the USD the customer expects. USD: equal to the declared amount. SYP: `sypToUsd(declared, rate, 'down')`, floored to whole cents (rule FX6).
- Quote (SYP only, null for USD): `rate_id` foreign key to `exchange_rates`; `rate` numeric(12,4), a copy of the rate's value; `quote_expires_at` timestamptz (quote time + 15 minutes). A check: all three set if and only if `currency = 'SYP'`.
- `rate_fixed_at` timestamptz, nullable: set at the first submission made within a valid quote. From then on, the deposit's rate never changes (rule SC9).
- `expires_at` timestamptz: 24 hours after creation, or after a clearer-receipt request (rule SC12).
- `receipt_requested_at` timestamptz, nullable; `receipt_request_count` smallint, default 0, at most 1 (rule RV8).
- `submitted_at`, `decided_at` timestamptz, nullable.
- Decision, set once when credited:
  - `transaction_number` text, trimmed. Compared upper-cased; unique through `payment_references`.
  - `received_currency` enum `currency`; `received_amount_units` bigint `> 0`.
  - `credited_usd_units` bigint, whole cents `> 0`.
  - `credit_rate_id`, `credit_rate`: the rate the credit used when SYP was received (rule RV3), else null.
  - `reference_check` enum `deposit_reference_check`: `matches`, `missing`, `different`.
  - `journal_id`, foreign key to `ledger_journals`, unique.
- Rejection, set once when rejected: `reject_reason` enum `deposit_reject_reason` (rule RV6); `customer_note` text, 1–300, nullable.
- `idempotency_key` uuid, required; unique `(customer_id, idempotency_key)`.
- `decision_idempotency_key` uuid, nullable, unique: the approval's or rejection's `Idempotency-Key`.
- `admin_id` uuid, nullable, no foreign key: who decided.
- `created_at`, `updated_at`.
- Checks:
  - the decision fields are set if and only if `status = 'credited'`;
  - `reject_reason` is set if and only if `status = 'rejected'`;
  - `submitted_at` is set when `status` is `submitted`, `credited` or `rejected`.
- Indexes:
  - partial unique `(customer_id) where status = 'pending'`: one deposit awaiting a receipt per customer (rule SC4);
  - `(status, submitted_at)` for the queue;
  - `(status, expires_at)` for the expiry job.
- Deposits are never deleted or archived. A trigger refuses `DELETE` and `TRUNCATE`, and refuses an `UPDATE` that leaves a final state (`credited`, `rejected`, `expired`, `cancelled`) or changes `customer_id`, `currency`, `declared_*`, `reference_code` or a decision field once set. The app role has `SELECT`, `INSERT` and `UPDATE`.

### `deposit_receipts` (new; owner: `deposits`; append-only)
- `id`; `deposit_id` foreign key; `file_id` foreign key to `stored_files`, unique; `created_at`.
- `original_sha256` bytea (32 bytes): the hash of the uploaded bytes. Indexed, not unique: reuse is a flag, not a refusal (rule FL1).
- `perceptual_hash` bigint: a 64-bit dHash of the decoded image (rule FL2).
- A deposit has one receipt, or two after a clearer-receipt request. The newest is the current one.

### `deposit_flags` (new; owner: `deposits`; append-only)
- `id`; `deposit_id` foreign key, indexed; `code` enum `deposit_flag_code` (rules FL1–FL6); `details` jsonb (validated by `DEPOSIT_FLAG_DETAILS` in contracts, as audit details are); `created_at`.
- Unique `(deposit_id, code, receipt_id)`, with `receipt_id` nullable: a flag is raised once per receipt.

### `payment_references` (new; owner: `wallet`; append-only)
Claims each real-world payment once across every table that can credit it (rule SC14). Unique constraints across two tables are racy, so one table holds the claims.
- `id`; `method` enum `payment_method` (`sham_cash`, `usdt_trc20`, `usdt_bep20`); `reference` text: trimmed and upper-cased, 1–100 characters.
- `deposit_id` and `wallet_adjustment_id`: nullable foreign keys, exactly one set.
- `created_at`.
- Unique `(method, reference)`.
- The migration backfills the S02 `manual_deposit` adjustments. They are not reversals, so each has a reference. S02's `wallet_adjustments` unique index stays.
- Written only through `claimPaymentReference(tx, method, reference, owner)` in `packages/db/src/ledger`. It answers `EXTERNAL_REFERENCE_TAKEN` on conflict. The S02 adjustment service switches to it. A claim from a reversed manual deposit stays (S02 rule R5).
- Append-only trigger and grants.

### Ledger (exists)
- `LEDGER_ACCOUNT_KINDS` gains `currency_exchange` (enum migration).
- System accounts, created on first use with `ensureSystemAccount`: `sham_cash_receipts:USD`, `sham_cash_receipts:SYP`, `currency_exchange:USD`, `currency_exchange:SYP`.

### Contracts
- `rates.ts`:
  - `exchangeRateRecordSchema`, `changeRateSchema`, `ratePageSchema`;
  - `RATE_CONFIRMATION_THRESHOLD_PERCENT = 5`, `RATE_STALE_AFTER_HOURS = 48`, `QUOTE_LOCK_MINUTES = 15`;
  - `DISPLAY_STEP_MIN_SYP_UNITS = 100`, `DISPLAY_STEP_MAX_SYP_UNITS = 5000`;
  - `rateChangePercent(old, new)`, exact, in `money.ts` with tests.
- `deposits.ts`:
  - the statuses and their transition table (as `orders.ts`), flag codes and their details, reject reasons, reference checks, `DEPOSIT_SETTINGS_DEFAULTS`;
  - `DEPOSIT_APPROVAL_REAUTH_THRESHOLD_USD_UNITS = 100 * CURRENCY_SCALE.USD`, `DEPOSIT_PENDING_HOURS = 24`, `MAX_DEPOSITS_IN_REVIEW = 3`, `RECEIPT_SIMILAR_MAX_DISTANCE = 6`;
  - `REFERENCE_CODE_ALPHABET` with `referenceCodeSchema` (accepts lower case and a missing dash, normalizes to `VD-XXXXX`);
  - schemas for the options, create, deposit (customer view), admin deposit, approve, reject, request receipt, settings and the queue query.
- `money.ts`: `floorToWholeCents(usdUnits)`.
- New error codes in `errors.ts` (API section).
- Audit entity types `exchange_rate`, `deposit_settings` and `deposit`, with their actions (Audit section).
- Email templates `customer_deposit_credited`, `customer_deposit_rejected` and `customer_deposit_receipt_requested`.
- Queue `deposits.expire` in `jobs.ts`.

## States and rules

### Deposit states

| From | To | Who | When |
|---|---|---|---|
| — | `pending` | Customer | Creates the deposit (rules SC1–SC6) |
| `pending` | `submitted` | Customer | Submits a receipt (SC8, SC9) |
| `pending` | `cancelled` | Customer | Cancels before submitting |
| `pending` | `expired` | Worker | `expires_at` passed without a receipt (SC12) |
| `submitted` | `credited` | Admin | Approves (RV1–RV5) |
| `submitted` | `rejected` | Admin | Rejects with a reason (RV6) |
| `submitted` | `pending` | Admin | Asks for a clearer receipt, once per deposit (RV8) |

`credited`, `rejected`, `expired` and `cancelled` are final. Every transition locks the deposit row (`SELECT … FOR UPDATE`), checks the transition table, and writes its audit entry in the same transaction. A transition that is not in the table answers `DEPOSIT_STATE_CONFLICT`, with the current status in `details`.

### Exchange rate rules
- FX1. One rate (SYP per 1 USD) for display and for SYP deposits (owner, 2026-10-08). It is set by the admin only, with re-authentication. Every change, of the rate or the step, inserts a new `exchange_rates` row with an audit entry. Nothing is ever edited in place.
- FX2. When the new rate differs from the current one by more than 5% (`|new − old| / old`, exact), the request must carry `rateConfirmation` equal to the new rate. A missing value answers `RATE_CONFIRMATION_REQUIRED`; a different one answers `RATE_CONFIRMATION_MISMATCH`. The panel asks for the rate a second time, without paste. The first rate ever needs no confirmation.
- FX3. The display step is in SYP units, between 1 and 50 SYP (100–5,000 units). Default 5 SYP (owner, 2026-10-08). Store prices round **up** to it (`sypDisplayPrice`). The wallet value rounds **down** to it (`walletSypValue`, S02 rule W9).
- FX4. A rate change applies at once to every display and to new quotes. Existing quotes keep their locked rate until they expire (FX5). Fixed deposits keep theirs for good (SC9).
- FX5. A SYP quote locks the current rate for 15 minutes (`quote_expires_at`, A12). A quote is valid while `now() < quote_expires_at`, checked by the server.
- FX6. Conversion of a SYP amount to the USD the customer gets: `floorToWholeCents(sypToUsd(syp, rate, 'down'))`. The store never credits more than the pounds are worth.
- FX7. The panel shows a banner on every page while the newest rate is older than 48 hours. No rate yet counts as stale. Nothing is blocked (owner, 2026-10-08).
- FX8. Until the first rate exists: the wallet's `syp` is null (S02 rule W9), SYP deposits are unavailable (`RATE_UNAVAILABLE`), and USD Sham Cash deposits still work.
- FX9. The current rate is read with each request that uses it, never cached across requests. Reports convert with the rate stored on each record (ADR 0003).

### Sham Cash deposit rules
- SC1. Sham Cash deposits are available when deposit settings exist and at least one currency is enabled. SYP also needs a rate. The options route tells the store what is available. A create call for an unavailable currency answers `DEPOSIT_METHOD_UNAVAILABLE` (or `RATE_UNAVAILABLE`).
- SC2. Creating a deposit takes the currency and the amount in that currency. SYP is in whole pounds; USD in whole cents. The deposit then gets a reference code, `expires_at` 24 hours later, and, for SYP, a quote (FX5, FX6). It requires an `Idempotency-Key`. The same key with the same body returns the first deposit (`200`); with another body, `IDEMPOTENCY_KEY_REUSED`.
- SC3. Limits, in USD (the declared USD for SYP), from the current settings (owner, 2026-10-08). A customer is **new** until they have one `credited` deposit of any method.
  - Every deposit: at least the minimum ($2).
  - New account: at most $50 per deposit, and $100 in any 24 hours.
  - Established account: at most $300 per deposit, and $1,000 in any 24 hours.
  - The 24-hour sum is the declared USD of the customer's `pending` and `submitted` deposits plus the credited USD of `credited` ones, all created in the last 24 hours, plus the new deposit.
  - A breach answers `DEPOSIT_LIMIT_EXCEEDED`, with `details` `{ limit: 'minimum' | 'per_deposit' | 'daily', limitUnits, remainingUnits }`.
  - Limits apply when the deposit is created. An approval credits what was received, even above a limit (RV2): the money has already moved.
- SC4. A customer has at most one `pending` deposit (partial unique index). Creating another answers `DEPOSIT_ALREADY_PENDING` with `details.depositId`, and the store opens that deposit. The customer can cancel it first.
- SC5. A customer has at most 3 `submitted` deposits. A fourth create answers `TOO_MANY_DEPOSITS_IN_REVIEW`.
- SC6. Creation, requote, submission and cancellation are rate-limited per customer: 10 creations per hour, 20 receipt uploads per hour (ADR 0008). nginx keeps its deposit and receipt-upload zones.
- SC7. The pending deposit's page shows:
  - the account name and number, with copy buttons;
  - the QR of the deposit's currency;
  - the exact amount to send, with a copy button;
  - the reference code, large, with a copy button and the instruction "اكتب هذا الرمز في ملاحظة التحويل";
  - for SYP, the countdown to `quote_expires_at`;
  - the time left before the deposit expires.
- SC8. Submitting a receipt takes one image file (by paste, picker or camera) as multipart, at most 5 MB, JPEG, PNG or WebP.
  - The server decodes it with sharp (input pixel limit 40 MP), strips metadata, resizes it to fit 2000 px and re-encodes it as WebP. It stores the WebP and records the original's SHA-256 and the dHash.
  - A file that is not a decodable image answers `RECEIPT_INVALID`; an oversized one answers `PAYLOAD_TOO_LARGE`.
  - The deposit moves to `submitted`, with its flags computed (FL1–FL5) and its audit entry, in one transaction. The file is written before the transaction and its row inside it. An orphan file from a rolled-back request is harmless and never referenced.
- SC9. Rate at submission (SYP), owner 2026-10-08 (A12):
  - Within a valid quote, the first submission sets `rate_fixed_at`; the rate never changes after that, including after a clearer-receipt request.
  - After the quote expired, without `rate_fixed_at`, submission answers `QUOTE_EXPIRED`, with `details` holding the current rate and the USD the amount would get. The wizard shows it and asks the customer to accept. Accepting calls requote (SC10), then submits again, all within the new 15 minutes.
  - The submit request carries the `rateId` the customer saw. A mismatch with the deposit's quote answers `QUOTE_EXPIRED`, so a customer never submits at a rate they did not see.
- SC10. Requote: a `pending` SYP deposit without `rate_fixed_at` gets the current rate, a new 15-minute `quote_expires_at` and recomputed `declared_usd_units`. The declared SYP never changes, because the customer may already have sent it. The audit entry records the old and new rate. Limits are not re-checked: the pounds are already declared and possibly sent.
- SC11. Cancelling: only `pending`. A customer who already sent money and cancels can create a new deposit and submit that receipt there. The reference mismatch is the admin's to judge (RV1).
- SC12. Expiry: a worker job every 5 minutes moves `pending` deposits past `expires_at` to `expired` (actor `system`, channel `worker`), in batches with `FOR UPDATE SKIP LOCKED`. A clearer-receipt request sets a new `expires_at` 24 hours after the request. A submission racing the job is settled by the row lock: whichever commits first wins, and the other sees the new status (`DEPOSIT_STATE_CONFLICT` for the customer, a skip for the job).
- SC13. The customer's review ETA (ADR 0006, "show the truth"):
  - Within working hours (10:00–22:00 `Asia/Damascus`), it is the median of `decided_at − submitted_at` over the last 20 decided Sham Cash deposits of the past 14 days that were submitted within working hours. It is rounded up to 5 minutes, at least 5. With fewer than 5 such decisions, the target (15 minutes) is shown.
  - Outside hours, the page says reviews run 10:00–22:00 and the deposit will be reviewed after the next opening, with the date and time.
  - The ETA is computed per request.
- SC14. External references are claimed once across the system (`payment_references`). An approval claims its transaction number. An S02 `manual_deposit` adjustment claims its reference. S04 claims TXIDs. A second claim, from any source, answers `EXTERNAL_REFERENCE_TAKEN`, with `details` naming the source kind (deposit or adjustment) and its id, shown in the panel only.
- SC15. Deposit responses are never cached (`Cache-Control: no-store`). The QR image is `private, max-age=300`.

### Review rules
- RV1. Approving requires:
  - the Sham Cash **transaction number** (1–64 characters, from the store's Sham Cash account history: the dialog states that the admin must see the transfer in the account itself, never trust the image alone);
  - the **received currency** and the **received amount** (in whole pounds or whole cents);
  - the **reference check**: `matches`, `missing` or `different`. A reference that belongs to another customer is not an approval option: the admin rejects with `reference_other_customer`;
  - **acknowledgement** of every flag (RV5);
  - an optional internal note.
- RV2. The credit follows what was received (ADR 0006):
  - USD received: the credit is the received amount.
  - SYP received: the credit is converted with FX6 at the rate of RV3.
  - The credit must be at least $0.01 (`VALIDATION_FAILED`).
  - The panel shows the computed credit before the admin confirms. The admin cannot type a different credit: a different outcome is a rejection plus an S02 adjustment.
- RV3. The rate for SYP received:
  - a SYP deposit uses its own rate (the fixed one, or the locked one if the quote is still valid);
  - a SYP deposit whose quote expired unfixed cannot reach review, because submission requires a valid quote (SC9);
  - a USD deposit paid in SYP by mistake uses the current rate at approval. The `amount_mismatch` flag explains it to the admin.
- RV4. Re-authentication (S01 rule D5) is required when the credit is above $100 or the deposit has any flag, including the approval-time flags of RV5 (owner, 2026-10-08). Rejecting and asking for a clearer receipt need none: they move no money.
- RV5. Approval-time flags are computed from the request: `amount_mismatch` (a received currency or amount different from the declared one) and `reference_missing` / `reference_different` (from the reference check). They are inserted with the approval.
  - The request's `acknowledgedFlags` must equal the set of submission flags plus approval-time flags. Otherwise the answer is `FLAGS_NOT_ACKNOWLEDGED`, with the expected set in `details`.
  - Flags never block an approval. They require an explicit acknowledgement and re-authentication (owner, 2026-10-08).
- RV6. Reject reasons (customer-visible through i18n):
  - `not_received` (لم يصل التحويل إلى حسابنا);
  - `receipt_invalid` (الإيصال غير صالح أو معدَّل);
  - `receipt_used` (الإيصال مستخدم في إيداع سابق);
  - `reference_other_customer` (رمز المرجع يخص حساباً آخر);
  - `wrong_account` (التحويل إلى حساب غير حساب المتجر);
  - `other` (requires `customerNote`).

  An optional `customerNote` (1–300) is shown on the deposit page only, never in the email (S01 email rule). An internal note (5–500) is required and goes to the audit `reason`.
- RV7. Approval transaction, READ COMMITTED, in this order:
  1. lock the deposit;
  2. check `submitted`;
  3. claim the transaction number (SC14);
  4. `ensureCustomerWallet`;
  5. `postJournal` (Money flows);
  6. update the deposit;
  7. insert the approval-time flags;
  8. audit;
  9. enqueue the email.

  Any refusal rolls everything back. The after-commit hook for A02 is left as a no-op with a comment pointing to S08/S09.
- RV8. "Request a clearer receipt": once per deposit (`receipt_request_count` ≤ 1; the second answers `RECEIPT_ALREADY_REQUESTED`). It moves `submitted` back to `pending`, sets `receipt_requested_at` and a new `expires_at`, writes an optional customer note and a required internal note, and sends the email. It does not count toward SC4: a customer with another `pending` deposit keeps it, so the partial unique index refuses the move. The panel then explains it and offers reject instead.
- RV9. Approval and rejection carry an `Idempotency-Key` (`decision_idempotency_key`). A replay with the same key and body returns the decided deposit (`200`), with no second journal, audit entry or email. The same key with another body answers `IDEMPOTENCY_KEY_REUSED`. A different key on a decided deposit answers `DEPOSIT_STATE_CONFLICT`.
- RV10. Queue order: flagged deposits first, then oldest `submitted_at` first (owner, 2026-10-08).

### Fraud flag rules (A10)
Computed at submission for that receipt, in the submission transaction:
- FL1. `receipt_reused`: another receipt with the same `original_sha256`, on any deposit of any customer. `details`: the other deposit ids and their customers.
- FL2. `receipt_similar`: another receipt whose dHash is within Hamming distance 6, not already caught by FL1. A linear scan with `bit_count` is fine at V1 volumes; an index is a later concern. `details`: deposit ids and distances.
- FL3. `new_account_large`: the customer is new (SC3) and the declared USD is at least the setting ($25).
- FL4. `velocity`: this is at least the 4th submission by the customer in 24 hours (the setting is 3).
- FL5. `shared_phone`: another non-archived customer has the same phone. `details`: the count, plus the other customer ids for the panel.

Computed at approval (RV5):
- FL6. `amount_mismatch`, `reference_missing`, `reference_different`.

A flag is information for the admin. The customer never sees flags or their codes.

## Money flows
- M1. **USD received** (journal kind `deposit`, idempotency key `deposit:<deposit id>`):
  - `customer_wallet:<customer>` **+credit** USD;
  - `sham_cash_receipts:USD` **−credit** USD.
- M2. **SYP received** (same kind and key), four postings that balance per currency:
  - `sham_cash_receipts:SYP` **−received** SYP;
  - `currency_exchange:SYP` **+received** SYP;
  - `currency_exchange:USD` **−credit** USD;
  - `customer_wallet:<customer>` **+credit** USD.

  `sham_cash_receipts:SYP` tracks the pounds the store holds in Sham Cash, for reconciliation (F20). The `currency_exchange` pair is the store's conversion position: pounds held against dollars owed. The rate used is stored on the deposit (`credit_rate_id`, `credit_rate`), and the deposit links to the journal (`journal_id`).
- M3. Rounding: the credit is floored to whole cents (FX6). The fraction of a cent stays as pounds in `currency_exchange:SYP`. The customer is never credited more than they paid.
- M4. Nothing else moves money. Rejection, expiry, cancellation and a clearer-receipt request post nothing. A wrong credit is never undone by touching the journal: the admin posts an S02 `correction` debit, which refuses to take the wallet below zero. The deposit stays `credited`, and the audit trail links the two.
- M5. Money received for a deposit that is then rejected (for example a fraud case where the transfer was real) is not in the ledger. The owner settles it outside the system and records it, if needed, as an S02 `manual_deposit` or `cash_refund`. The rejection's internal note says so.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/deposits/sham-cash/options` | Customer | — | `shamCashOptionsSchema`: availability per currency, account name and number, QR URLs, the customer's min, per-deposit max and remaining daily limit, current rate (id, value, step) or null, review hours, current ETA or the next opening, `pendingDepositId` | — |
| `GET /api/deposits/sham-cash/qr/:currency` | Customer | — | the image (`image/png`) | `NOT_FOUND` (currency disabled or no QR) |
| `POST /api/deposits/sham-cash` | Customer, `Idempotency-Key` | `createShamCashDepositSchema` (`currency`, `amountUnits`) | `201` `depositSchema` (`200` on a replay) | `DEPOSIT_METHOD_UNAVAILABLE`, `RATE_UNAVAILABLE`, `DEPOSIT_LIMIT_EXCEEDED`, `DEPOSIT_ALREADY_PENDING`, `TOO_MANY_DEPOSITS_IN_REVIEW`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMITED`, `VALIDATION_FAILED` |
| `GET /api/deposits` | Customer | cursor | page of `depositSchema` (newest first) | `VALIDATION_FAILED` |
| `GET /api/deposits/:id` | Customer | — | `depositSchema` (status, amounts, reference, quote, ETA while `submitted`, reject reason and note, credited amount) | `NOT_FOUND` |
| `POST /api/deposits/:id/quote` | Customer | — | `depositSchema` | `NOT_FOUND`, `DEPOSIT_STATE_CONFLICT` (not `pending`, not SYP, or already fixed), `RATE_UNAVAILABLE` |
| `POST /api/deposits/:id/receipt` | Customer, multipart (`file`, `rateId?`) | — | `depositSchema` | `NOT_FOUND`, `DEPOSIT_STATE_CONFLICT`, `QUOTE_EXPIRED`, `RECEIPT_INVALID`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED` |
| `POST /api/deposits/:id/cancel` | Customer | — | `depositSchema` | `NOT_FOUND`, `DEPOSIT_STATE_CONFLICT` |
| `GET /api/admin/rates` | Admin | cursor | `{ current, stale, history page }` | — |
| `POST /api/admin/rates` | Admin, re-authentication | `changeRateSchema` (`sypPerUsd`, `displayStepSypUnits`, `rateConfirmation?`) | `201` `exchangeRateRecordSchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`, `RATE_CONFIRMATION_REQUIRED`, `RATE_CONFIRMATION_MISMATCH` |
| `GET /api/admin/deposit-settings` | Admin | — | `depositSettingsSchema` or the defaults with `saved: false` | — |
| `PUT /api/admin/deposit-settings` | Admin, re-authentication | `depositSettingsInputSchema` | `depositSettingsSchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` (including a currency enabled without its QR) |
| `POST /api/admin/deposit-settings/qr` | Admin, re-authentication, multipart (`file`) | — | `{ fileId }` (re-encoded PNG, at most 1000 px) | `REAUTHENTICATION_REQUIRED`, `RECEIPT_INVALID`, `PAYLOAD_TOO_LARGE` |
| `GET /api/admin/deposit-settings/qr/:fileId` | Admin | — | the image | `NOT_FOUND` |
| `GET /api/admin/deposits` | Admin | `adminDepositQuerySchema` (`status` default `submitted`, `flagged?`, `q?` reference code or customer email, cursor) | page of `adminDepositListItemSchema` (RV10 order for `submitted`, otherwise newest first) | `VALIDATION_FAILED` |
| `GET /api/admin/deposits/counts` | Admin | — | `{ submitted, submittedFlagged, pending }` (navigation badge) | — |
| `GET /api/admin/deposits/:id` | Admin | — | `adminDepositSchema`: everything in the deposit, receipts, flags with details, customer summary (name, email, phone, test, account age, new or established, credited count and total, last 10 deposits, the wallet balance), the computed ETA, the audit trail of the deposit | `NOT_FOUND` |
| `GET /api/admin/deposits/:id/receipts/:receiptId` | Admin | — | the image (`private, no-store`; in production through `X-Accel-Redirect`) | `NOT_FOUND` |
| `POST /api/admin/deposits/:id/approve` | Admin, `Idempotency-Key`, re-authentication per RV4 | `approveDepositSchema` (`transactionNumber`, `receivedCurrency`, `receivedAmountUnits`, `referenceCheck`, `acknowledgedFlags`, `internalNote?`) | `200` `adminDepositSchema` | `REAUTHENTICATION_REQUIRED`, `DEPOSIT_STATE_CONFLICT`, `EXTERNAL_REFERENCE_TAKEN`, `FLAGS_NOT_ACKNOWLEDGED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/deposits/:id/reject` | Admin, `Idempotency-Key` | `rejectDepositSchema` (`reason`, `customerNote?`, `internalNote`) | `200` `adminDepositSchema` | `DEPOSIT_STATE_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/deposits/:id/request-receipt` | Admin | `requestReceiptSchema` (`customerNote?`, `internalNote`) | `200` `adminDepositSchema` | `DEPOSIT_STATE_CONFLICT`, `RECEIPT_ALREADY_REQUESTED`, `DEPOSIT_ALREADY_PENDING`, `NOT_FOUND` |

- Every route also answers its guard's codes (S01).
- Statuses:
  - `400`: `VALIDATION_FAILED`, `RECEIPT_INVALID`, `RATE_CONFIRMATION_*`;
  - `409`: `DEPOSIT_*`, `TOO_MANY_DEPOSITS_IN_REVIEW`, `QUOTE_EXPIRED`, `RATE_UNAVAILABLE`, `EXTERNAL_REFERENCE_TAKEN`, `FLAGS_NOT_ACKNOWLEDGED`, `RECEIPT_ALREADY_REQUESTED`, `IDEMPOTENCY_KEY_REUSED`;
  - `422`: `DEPOSIT_LIMIT_EXCEEDED`.
- New error codes: `RATE_UNAVAILABLE`, `RATE_CONFIRMATION_REQUIRED`, `RATE_CONFIRMATION_MISMATCH`, `QUOTE_EXPIRED`, `DEPOSIT_METHOD_UNAVAILABLE`, `DEPOSIT_LIMIT_EXCEEDED`, `DEPOSIT_ALREADY_PENDING`, `TOO_MANY_DEPOSITS_IN_REVIEW`, `DEPOSIT_STATE_CONFLICT`, `RECEIPT_INVALID`, `FLAGS_NOT_ACKNOWLEDGED`, `RECEIPT_ALREADY_REQUESTED`. Each comes with its Arabic text in the store and admin catalogs.
- `GET /api/wallet` and the admin wallet now fill `syp` from the current rate. Wallet timeline `deposit` entries carry `{ method, referenceCode, syp: { amountUnits, rate } | null }` (S02 rule W5); the admin view adds the deposit id.
- Receipt and QR uploads take multipart bodies on these routes only. The API body limit for them is 5 MB, and nginx raises its body size on these locations only (ADR 0008).
- After the change: `openapi:export` and the admin client regenerated.

## Jobs and integrations
- `deposits.expire` (worker, cron every 5 minutes; singleton): moves overdue `pending` deposits to `expired`, 100 per batch, `FOR UPDATE SKIP LOCKED`, one audit entry each. It is safe to run twice: the status check makes a second run a no-op. No email: the customer did nothing after creating the deposit, and the page shows the state.
- Emails through the S01 outbox and `email.send`, enqueued in the decision's transaction, with normal priority:
  - `customer_deposit_credited`: params `creditedUsdUnits`, `referenceCode`, `at`;
  - `customer_deposit_rejected`: params `reason` (code), `referenceCode`;
  - `customer_deposit_receipt_requested`: params `referenceCode`.

  Each links to the deposit page. None carries free text, the transaction number or the receipt.
- Files: a `FileStorage` interface in the `files` module (local disk under `FILES_ROOT`: `put`, `read`, and the internal path for `X-Accel-Redirect`). `FILES_ROOT` and `FILES_ACCEL_PREFIX` go in the env schema and `.env.example`.
- Deploy: the admin host gets an `internal` nginx location mapping `FILES_ACCEL_PREFIX` to `shared/files/`, and both hosts get raised body limits on the two upload paths. Applied with the Phase 1 deploy.
- No Telegram, blockchain or supplier calls (Telegram: S05).

## Screens

### Store (Arabic, RTL, phone width first; dynamic, never cached)
- **`/wallet`**:
  - The card shows `≈ <SYP> ل.س` and "حسب سعر اليوم <rate>" when a rate exists.
  - The "إيداع" button links to `/wallet/deposit`.
  - Deposit timeline entries show "إيداع شام كاش", the reference code and, for SYP, "<SYP> ل.س بسعر <rate>".
  - A "إيداعاتي" link goes to `/wallet/deposits`.
- **`/wallet/deposit`**: the method picker shows only Sham Cash until S04, so it opens the Sham Cash form directly. When a pending deposit exists, it redirects to that deposit.
  - Currency toggle: ل.س or $ (an unavailable currency is disabled, with a reason).
  - Amount field with a numeric keyboard and Latin digits, plus presets in USD ($5, $10, $25, $50), converted for SYP to pounds rounded up to the display step.
  - For SYP, a live preview "ستحصل على $X" (FX6) with the rate and "السعر مقفل 15 دقيقة بعد المتابعة".
  - Limits line: minimum, maximum per deposit, remaining today.
  - The review hours and the current ETA.
  - Errors appear inline by code.
- **`/wallet/deposits/[id]`** by status:
  - `pending`: steps as SC7 (1 send to the account, 2 write the code in the note, 3 add the receipt). Copy buttons give a "نُسخ" feedback. The QR enlarges on tap. Receipt by paste (`Ctrl+V` and the paste button), file picker or camera, with a preview before submitting. Submit and cancel.
    - For SYP, the quote countdown. At zero it reads "انتهت مدة السعر". Submitting then shows the requote sheet: the new rate and the new USD, with "أوافق وأرسل".
    - A clearer-receipt request shows a notice at the top, with its note.
  - `submitted`: "قيد المراجعة", the ETA (or the next opening), the amount and the reference. It refreshes every 30 seconds while visible.
  - `credited`: the credited USD (and, for SYP, the pounds and rate), the time, and a link to the wallet.
  - `rejected`: the reason in words, the note, and "إيداع جديد".
  - `expired` and `cancelled`: a short explanation and "إيداع جديد".
  - Loading: skeleton. Error: the standard block with retry. Not the customer's deposit: the 404 page.
- **`/wallet/deposits`**: a list (date, amount and currency, reference, status badge), cursor "تحميل المزيد", and an empty state with the deposit button.

### Admin (Arabic, RTL)
- **Navigation**: "الإيداعات" with a badge (submitted count; red when any is flagged), refreshed every 30 seconds. "سعر الصرف". "إعدادات الإيداع". The stale-rate banner (FX7) appears on every page.
- **`/deposits`**:
  - Tabs: قيد المراجعة (RV10 order), بانتظار الإيصال, الكل (status filter, search by reference or email).
  - Columns: reference, customer (test badge), declared amount and currency with the USD equivalent, waiting time since submission, and flag chips.
  - Empty: "لا إيداعات بانتظار المراجعة". Loading: table skeleton.
- **`/deposits/$id`**:
  - The receipt viewer: zoom and rotate, with both receipts after a request.
  - The deposit facts: reference, currency, declared amount, the rate and its fixing, timestamps.
  - The flags, each with its words and details. Links open the other deposits and receipts for FL1/FL2.
  - The customer panel: account age, new or established, credited deposits count and total, last deposits, balance, link to the wallet, a shared-phone note.
  - **Approve form**:
    - the transaction number field;
    - the received currency (defaulting to the declared one) and amount (prefilled with the declared amount);
    - the reference-check radio (يطابق / مفقود / مختلف);
    - the computed credit, live;
    - the list of flags, including approval-time flags as they appear, each to tick;
    - an internal note;
    - "اعتماد وإضافة $X". It opens the re-authentication dialog when RV4 requires it, then retries with the same `Idempotency-Key`.
  - **Reject dialog**: reason select, customer note (required for `other`, "يظهر للعميل"), internal note.
  - **Request clearer receipt dialog**: only when not used yet. Customer note and internal note.
  - Decided deposits show the decision, the admin's name, the journal and the audit trail, read-only.
- **`/rates`**:
  - The current rate, step and age.
  - The change form: rate and step. When the change exceeds 5%, the percentage is shown and a "أعد كتابة السعر" field appears, without paste. Then re-authentication.
  - History table: time, rate, step, change percent, admin. Cursor.
- **`/settings/deposits`**:
  - The account name and number.
  - SYP and USD toggles, each with its QR upload and preview.
  - The limits (five amounts), working hours and target, and the flag thresholds.
  - Save, with re-authentication. Validation is inline.
  - On a fresh install, a notice says Sham Cash deposits stay unavailable until the first save.
- **`/wallets/$customerId`**: the header shows SYP. Deposit entries link to the deposit.
- **Audit log**: the new entity types and actions appear in its filters, with detail labels.

## Audit and notifications
Every entry is written in its transaction.
- `exchange_rate.changed` (admin; `reason` null): `{ rateId, before: { sypPerUsd, displayStepSypUnits } | null, after: {…}, changePercent }`.
- `deposit_settings.changed` (admin): `{ settingsId, before, after }`, with the changed fields only and file ids for QR.
- `deposit.created` (customer, channel `store`): `{ depositId, method, currency, declaredAmountUnits, declaredUsdUnits, rateId }`.
- `deposit.requoted` (customer): `{ depositId, before: { rateId, rate, declaredUsdUnits }, after: {…} }`.
- `deposit.submitted` (customer): `{ depositId, receiptId, rateFixed, flags }`.
- `deposit.cancelled` (customer): `{ depositId }`.
- `deposit.expired` (system, channel `worker`): `{ depositId }`.
- `deposit.credited` (admin; `reason` = internal note or null): `{ depositId, customerId, transactionNumber, receivedCurrency, receivedAmountUnits, creditedUsdUnits, creditRateId, referenceCheck, acknowledgedFlags, journalId, balanceAfterUnits }`.
- `deposit.rejected` (admin; `reason` = internal note): `{ depositId, customerId, rejectReason, customerNote }`.
- `deposit.receipt_requested` (admin; `reason` = internal note): `{ depositId, customerNote }`.
- Reads are not audited. Receipt views are not audited: only the admin can read them.

Customer notifications:
- Emails as in Jobs: credited, rejected, clearer receipt requested.
- S05 adds these events to the notification center and the email preferences. F27's list already names "deposit credited" and "deposit rejected"; "clearer receipt requested" joins it.

Admin: the panel badge. The Telegram card and reminder arrive in S05 (A09).

## Abuse and fraud
| Threat | Control |
|---|---|
| Edited or fake receipt | The admin approves only after seeing the transfer in the Sham Cash account and typing its transaction number (RV1); flags for reused and similar receipts (FL1, FL2) |
| The same transfer claimed twice (two deposits, or a deposit and a manual adjustment) | `payment_references` unique `(method, reference)` across sources (SC14); a lock on the deposit row; one journal per deposit (`deposit:<id>` unique) |
| A customer claims someone else's transfer | The reference code in the transfer note; the admin's reference check; `reference_other_customer` rejection; FL1 shows the other deposit's customer |
| Double approval (two tabs, retries) | The row lock and state check; `decision_idempotency_key`; the journal key; a replay returns the first result |
| A rate change mid-flow, or gaming the lock | The 15-minute quote; a submission must carry the `rateId` the customer saw; after expiry only the current rate (SC9); the rate is fixed at the first valid submission and never re-quoted after a clearer-receipt request |
| A fat-fingered rate (1,180 for 118) | A typed confirmation above a 5% change, re-authentication, history and audit (FX2) |
| A stolen admin session credits fake deposits | Re-authentication above $100 and on any flag (RV4); an audit entry per decision; the customer email; the reconciliation of `sham_cash_receipts` against the real account (F20) |
| Bots or spam filling the queue | Verified-email customers only; one `pending` and at most 3 `submitted` per customer (SC4, SC5); rate limits per customer and nginx zones; registration closed until the pilot (S01) |
| New fake accounts depositing with stolen funds | Low new-account limits (SC3); FL3, FL4, FL5 |
| Malicious image files (decompression bombs, polyglots, EXIF location) | Type and size checks; sharp with a pixel limit; re-encoding to WebP with metadata stripped; random storage keys outside the web root; served only to the admin with `no-store` and `X-Content-Type-Options: nosniff` |
| Reading other customers' deposits or receipts | Customer routes scope by session customer; receipts have no customer route at all; API tests per route |
| Enumerating reference codes | Codes are not secrets and grant nothing; deposit ids are UUIDv7 and scoped |
| Editing history | Append-only rates, settings, receipts, flags and payment references; a final deposit cannot change (trigger); the ledger as ADR 0003 |

## Edge cases
1. Rate changes while a customer is on the SYP form: the form previews with the rate it loaded. Creation quotes at the then-current rate and the deposit page shows it. The customer sees the locked rate before sending.
2. A quote expires while the customer is in the Sham Cash app: the submission answers `QUOTE_EXPIRED`, and the requote sheet shows the new USD. If the customer refuses, they can cancel the deposit. Money already sent is then settled by a new deposit or the admin.
3. A customer sends more or less than declared: the admin enters what was received. The credit follows it, the `amount_mismatch` flag is acknowledged, and an amount above the limits is still credited (SC3).
4. A customer sends USD on a SYP deposit, or the reverse: the admin chooses the received currency. SYP received on a USD deposit converts at the current rate (RV3), with the mismatch flag.
5. A customer sends two transfers for one deposit: the admin credits the transfer with its transaction number. The second transfer is recorded as an S02 `manual_deposit` with its own transaction number (SC14 keeps them apart).
6. Two approvals at once (two tabs): the row lock lets one win. The other gets `DEPOSIT_STATE_CONFLICT`, or, with the same key and body, the replay.
7. The same transaction number on two deposits approved at once: the `payment_references` unique index lets one claim win. The other rolls back with `EXTERNAL_REFERENCE_TAKEN`.
8. Submission racing the expiry job: the row lock decides (SC12).
9. A clearer receipt is requested while the customer has opened another pending deposit: refused (`DEPOSIT_ALREADY_PENDING`), and the admin rejects instead (RV8).
10. Settings change while deposits are open: existing deposits keep their amounts and quotes. New limits apply to new deposits. A disabled currency stops new deposits only. The QR shown on an open deposit is the current one, so the admin does not disable a currency with deposits open without reason (the panel shows the open count before saving).
11. No settings or no rate yet: SC1 and FX8. The store's deposit button still shows, and the page explains that deposits are not available yet.
12. Very large SYP amounts: the safe-integer bounds of `money.ts`. The per-deposit limit stops them first.
13. The credit computes to $0.00 (a tiny SYP amount received): `VALIDATION_FAILED`. The admin rejects or records an adjustment.
14. The receipt is a PDF or HEIC: `RECEIPT_INVALID`, with a message asking for a screenshot image. HEIC support is out of V1.
15. A customer pastes a non-image clipboard: the wizard ignores it with a hint.
16. Expired deposit, money sent: the customer creates a new deposit and submits the receipt there. The admin sees `reference_different` (the note has the old code), and the deposit page lists the customer's expired deposits with their codes, so the admin can verify.
17. A test customer deposits: allowed (the owner's acceptance tests use it). Test totals are split in the ledger summary as S02 does.
18. An archived customer (S12) can no longer sign in. Their submitted deposits stay in the queue for a decision.
19. The worker is down: pending deposits stay `pending` past `expires_at`. The customer routes treat a `pending` deposit past `expires_at` as expired for submission (`DEPOSIT_STATE_CONFLICT`) without waiting for the job.
20. Daylight saving: `Asia/Damascus` has a fixed UTC+3 offset since 2022. Hours are still computed with the IANA zone.

## Open questions
None. Q4 (currencies, QR source), Q5 (Sham Cash limits), Q6 (rate policy and step) and Q9 (hours, target) were answered by the owner on 2026-10-08 (`docs/open-questions.md`, ADR 0017). The Sham Cash account name, number and QR images are data the admin enters in the panel, so they are not repository content. USDT limits stay open for S04 (Q5, remaining part).

## Acceptance
The owner's browser check (local, `pnpm dev`, emails written to files, a test customer from S01):
1. Panel: set the rate to 118 with step 5. Change it to 130: the 5%+ confirmation appears, then re-authentication. The history shows both. The stale banner is gone.
2. Panel: deposit settings: enter an account name and number, upload a QR for SYP and for USD, keep the default limits, save (with re-authentication).
3. Store, as the test customer: `/wallet` shows the SYP line. "إيداع" → choose ل.س, enter 2,000: the preview shows the USD and the rate. Continue: the deposit page shows the account, QR, amount, reference code and countdown. Copy buttons work.
4. Try a second deposit: you land on the open one. Try $60 in USD on a new account (after cancelling): refused by the $50 limit.
5. Paste a receipt image and submit: the status reads "قيد المراجعة" with the ETA (or the next opening outside 10:00–22:00).
6. Panel: the queue badge shows 1. Open it: the receipt, the flags (`new_account_large` if ≥ $25), the customer panel. Approve with transaction number `TEST-001` and a received amount 1,900 SYP. `amount_mismatch` appears, must be ticked, and re-authentication is asked. The wallet shows the deposit entry with the pounds and rate. The email file exists with no note or transaction number.
7. A second deposit with the same receipt image: `receipt_reused`, linking the first deposit. Approve with `TEST-001` again: refused as already used. Also try an S02 `manual_deposit` with ` test-001 `: refused.
8. A USD deposit: ask for a clearer receipt, and the store shows the notice and accepts a new receipt. Then reject with `receipt_invalid`. The store shows the reason, and the email exists.
9. A SYP deposit: create it, change the rate in the panel, wait 15 minutes, then submit the receipt: the requote sheet shows the new rate and USD. Accept, and the submission succeeds at the new rate.
10. The audit log shows every entry above, filtered by entity type.

Tests:
- API, every route:
  - success, 401, and the customer/admin separation;
  - a customer reads only their own deposits (two customers);
  - every error code above;
  - re-authentication: none for a $100.00 unflagged approval, required at $100.01 or with any flag;
  - `no-store` headers.
- Money and concurrency (real PostgreSQL):
  - two parallel approvals → one journal, one audit entry, one email;
  - two deposits approved in parallel with the same transaction number → one credit;
  - a parallel claim from an adjustment and a deposit → one wins;
  - the same `Idempotency-Key` on create in parallel → one deposit;
  - submission against expiry → one outcome;
  - a failed approval (taken reference) leaves no journal, flag, audit or email row;
  - the SYP journal balances per currency, with the exact postings of M2.
- Database:
  - the append-only triggers and grants on the new tables (as the app role);
  - the deposit trigger refuses changes out of final states and changes to declared or decision fields;
  - the partial unique pending index;
  - the `payment_references` backfill from S02 rows;
  - the checks.
- Unit (contracts, 100% coverage):
  - `floorToWholeCents`, `rateChangePercent` (at 5% and just above);
  - the FX6 conversion at boundaries;
  - the transition table;
  - the reference code schema (normalization);
  - limit computation (new and established, daily window);
  - ETA median and next opening (fixed instants, the boundaries 09:59, 10:00, 21:59, 22:00);
  - the dHash distance;
  - the settings schema cross-field rules.
- Files: a JPEG with EXIF GPS comes back without metadata; a decompression bomb is refused; a PNG renamed `.jpg` is accepted by content; a PDF is refused.
- Worker: `deposits.expire` (batching, idempotent second run, skips locked rows); the three emails render (Arabic HTML + text, no free text).
- E2E with RTL screenshots:
  - store, dark theme at phone width: the deposit form (SYP preview), the pending deposit page (QR, code, countdown), the submitted status, credited, rejected, and the wallet card with SYP;
  - admin, light and dark: the queue with flags, the deposit page with the approve form and its flags, the reject dialog, rates with the confirmation field, deposit settings.

## Implementation notes
- Suggested PR split, each leaving `main` green:
  1. contracts, db, `rates`, `files` and the `deposits` api with the worker job and emails;
  2. store and admin screens, with E2E.
- Time rules (quote lock, expiry, the 24-hour windows) compare with the database's `now()` inside the transaction. Tests move time by writing past timestamps into the rows they set up, so no injectable clock is needed. The ETA and next-opening functions take `now` as an argument and are unit-tested with fixed instants. Deposit expiry (24 hours) is covered by the worker test, not the browser check.
- dHash: resize to 9×8 grayscale with sharp, compare neighbours, 64 bits as a signed bigint.
- The `wallet` module exports the deposit-credit posting through `packages/db/src/ledger`. `deposits` never queries `ledger_*` tables directly. `deposits` reads the customer's balance through the wallet service for the admin panel.
- Update `docs/architecture.md` (modules `rates`, `deposits`, `files`; job `deposits.expire`), `deploy/` nginx, `.env.example`, and the commands table if a command changes.
