# S04 — USDT deposits (F06)

Status: Approved · Date: 2026-10-08 · Scope: `docs/product/v1-scope.md` §F06 (A01, A16; A02 and A13 hooks) · ADRs: 0003, 0006, 0008, 0011, 0014, 0016, 0017, 0018

## Summary
Customers who hold USDT, in Syria or abroad, have no way to fund their wallet today without a manual review. S04 adds USDT deposits on TRON (TRC20) and BNB Smart Chain (BEP20), verified on chain without the admin. The customer picks a network and a USD amount. The store gives an **exact amount with a unique sub-cent tail** (for example `25.0037` USDT for $25.00) and the store's receiving address (QR and copy). The customer sends exactly that amount. The worker **detects the transfer on its own** by watching the store's address, or faster when the customer pastes the TXID or an explorer link. Once the transfer is final on chain it credits the wallet, 1 USDT = 1 USD, in one transaction with the journal, the audit entry and the email. Anything that does not match exactly (a different amount, the wrong network, a transfer sent before the deposit) goes to the admin's review queue with the reason. Transfers that match no deposit are listed for the admin.

## In scope / out of scope
- In:
  - USDT deposits on `usdt_trc20` and `usdt_bep20`: options, creation with the exact amount, the deposit page, the optional TXID submission, cancellation and expiry (S03 job).
  - A chain reader per network (`ChainReader` interface: TronGrid for TRON, a BSC JSON-RPC provider for BEP20, and a `fake` reader for development and tests), the address scanner (automatic detection, owner 2026-10-08) and the TXID verifier (A01).
  - Automatic credit on an exact match; admin review for mismatches (approve with the received amount, or reject); a re-check action.
  - The incoming-transfers list in the panel (every official USDT transfer to the store's addresses, matched or not), with a link to the S02 `manual_deposit` form for transfers that match no deposit.
  - USDT settings in the panel: one switch per network and the USDT minimum. The receiving addresses come from the server environment and are shown read-only (owner 2026-10-08).
  - Ledger: `usdt_receipts:<network>` system accounts and a `deposit_rounding` account for the sub-cent tails.
  - Emails: deposit credited and deposit rejected (S03 templates, A16).
- Out (later or never):
  - Per-customer HD addresses, sweeping, or any private key on the server (ADR 0006: never).
  - Refunding USDT on chain, and withdrawals (ADR 0003: never in V1). A transfer the store cannot credit is settled by the owner outside the system.
  - Networks other than TRC20 and BEP20 (ERC20 and others), and tokens other than official USDT.
  - The Telegram card for deposits in review and the alert channel for unmatched transfers: S05 (F07). The scanner's health alert uses the existing Telegram alert channel (A13).
  - The per-method switch and the emergency stop: S05 (F26). Until then the per-network switches in the deposit settings stop new USDT deposits.
  - The in-site notification center and email preferences: S05 (F27).
  - Paying `awaiting_balance` orders after a credit (A02): S08/S09, through the same after-commit hook as S03.
  - Per-customer limit overrides and freezing: S12 (F19).
  - Reconciling `usdt_receipts:<network>` against on-chain balances: F20 (S13). S04 records every transfer it sees, so F20 has the data.

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the USDT options, create a USDT deposit, submit a TXID, cancel, list and read own deposits | Customer | Signed-in customer with a verified email |
| Read the queue, a deposit, the incoming transfers | Admin | The admin |
| Change the USDT settings (switches, minimum) | Admin, re-authentication | The admin |
| Approve a USDT deposit in review | Admin, `Idempotency-Key`, re-authentication (always: a review always carries a flag, S03 rule RV4) | The admin |
| Reject a USDT deposit in review; re-check a deposit | Admin | The admin |
| Scan addresses, verify TXIDs, credit exact matches, bounce failed TXIDs, send to review | Worker jobs | System |

A customer only ever reaches their own deposits (S03: lookup by id **and** session customer, `NOT_FOUND` otherwise).

## Data

### Contracts
- `usdt.ts` (new):
  - `USDT_METHODS = ['usdt_trc20', 'usdt_bep20']`.
  - `USDT_NETWORKS`, one entry per method:
    - `contract`: TRON `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, BSC `0x55d398326f99059fF775485246999027B3197955` (ADR 0006; re-checked against Tether's and the explorers' pages when the constants are written, and the source noted in a comment);
    - `decimals`: 6 (TRON), 18 (BSC);
    - `confirmations`: 19 on TRON (a solidified block), 15 on BSC (and the block at or below the `finalized` block);
    - `explorerTxUrl`: `https://tronscan.org/#/transaction/<txid>`, `https://bscscan.com/tx/0x<txid>`.
  - `USDT_TAIL_MIN_UNITS = 100`, `USDT_TAIL_MAX_UNITS = 9_900`, `USDT_TAIL_STEP_UNITS = 100`: tails 0.0001–0.0099 USDT in USD units (rule U3).
  - `USDT_RESERVATION_GRACE_DAYS = 7` (rule U4), `USDT_DUST_THRESHOLD_UNITS = 1 * CURRENCY_SCALE.USD` (rule U14), `MAX_TXID_SUBMISSIONS = 5`, `TXID_SUBMISSIONS_PER_HOUR = 20`, `TXID_SEARCH_MINUTES = 30`, `USDT_SCANNER_STALE_MINUTES = 10`.
  - `txidSchema`: accepts a bare 64-hex hash, a `0x`-prefixed one, or a Tronscan / BscScan transaction link, in any case, trimmed; normalizes to 64 lower-case hex characters without `0x`. Anything else fails (`TXID_INVALID`).
  - `usdtPayAmount(declaredUsdUnits, tailUnits)` and `formatUsdtAmount(units)` (`"25.0037"`, always 4 decimals), `rawToUsdUnits(raw, decimals)` (BigInt, floored to USD units), `usdtRawForUnits(units, decimals)` (exact) in `money.ts`, with tests.
  - `addressSchema` per network: TRON base58check (`T…`, 34 characters, checksum verified), BSC 20-byte hex with the EIP-55 checksum when mixed case. Used by the environment check (rule U1).
- `deposits.ts`:
  - `DEPOSIT_METHODS` gains `usdt_trc20`, `usdt_bep20`.
  - The transition table is unchanged. `submitted → pending` gains a second use: the worker bounces a USDT deposit whose TXID failed (rule U10).
  - Flag codes gain `wrong_network` and `sent_before_deposit` (review reasons, rule U11). `amount_mismatch` is reused with USD on both sides.
  - Reject reasons gain `wrong_network` (التحويل على شبكة غير الشبكة المختارة) and `transfer_other_customer` (التحويل يخص طلب إيداع آخر).
  - `USDT_CHECK_STATUSES = ['awaiting_transfer', 'searching', 'confirming', 'review', 'done']` and `USDT_CHECK_ERRORS = ['not_found', 'tx_failed', 'not_to_store', 'wrong_token']`.
  - `DEPOSIT_DECIDERS = ['admin', 'system']`.
  - Schemas: `usdtOptionsSchema`, `createUsdtDepositSchema` (`method`, `amountUnits`), `submitTxidSchema` (`txid`), `approveUsdtDepositSchema` (`acknowledgedFlags`, `internalNote?`), `adminUsdtTransferSchema` and its page and query. `depositSchema` and `adminDepositSchema` gain an optional `usdt` block (below).
  - `DEPOSIT_SETTINGS_DEFAULTS` gains `usdtMinDepositUsdUnits: 5 USD`, `usdtTrc20Enabled: false`, `usdtBep20Enabled: false`.
- `wallet.ts`: `LEDGER_ACCOUNT_KINDS` gains `deposit_rounding`.
- `jobs.ts`: queues `deposits.usdt-scan` (payload `{ method }`) and `deposits.usdt-verify` (payload `{ depositId }`).
- `errors.ts`: `TXID_INVALID`, `TXID_ATTEMPTS_EXCEEDED`, `DEPOSIT_AMOUNT_BUSY`.
- `audit.ts`: the actions of the Audit section.

### `deposits` (exists; owner: `deposits`)
A USDT deposit is a `deposits` row like a Sham Cash one:
- `method` `usdt_trc20` or `usdt_bep20`;
- `currency` `USD`;
- `declared_amount_units` = `declared_usd_units` = the amount the customer asked for, in whole cents;
- a `reference_code`, used as the deposit's support identifier only (it is not written anywhere on chain);
- no quote.

Changes (expand-only migration):
- `decided_by` enum `deposit_decider` (`admin`, `system`), nullable, set if and only if `status` is `credited` or `rejected`. Existing decided rows are backfilled `admin`.
- The checks change:
  - `admin_id` and `decision_idempotency_key` are set if and only if `decided_by = 'admin'`;
  - `reference_check` is set if and only if credited **and** `method = 'sham_cash'`;
  - `transaction_number` holds the normalized TXID (64 characters, within the existing 1–64 bound) for USDT.
- `deposits_guard` (migration 0012) allows `submitted → pending` for a USDT deposit only together with a `usdt_deposits.check_error` (rule U10), and keeps refusing it beyond the S03 receipt-request rule for Sham Cash.

### `usdt_deposits` (new; owner: `deposits`; one row per USDT deposit)
- `deposit_id` uuid, primary key, foreign key to `deposits` (a natural key, in `NATURAL_KEYS` with the reason).
- `method` enum `payment_method`, check in (`usdt_trc20`, `usdt_bep20`), equal to the deposit's (set at creation, never changed).
- `receiving_address` text: the address shown to the customer, copied from the environment at creation (rule U1).
- `tail_units` bigint, `between 100 and 9900`, `% 100 = 0`.
- `pay_amount_units` bigint: `declared_usd_units + tail_units`, the exact USDT to send in USD units (1 USDT = 1 USD, and USD units have the same 6 decimals as TRON USDT).
- `check_status` enum `usdt_check_status`, default `awaiting_transfer`.
- `check_error` enum `usdt_check_error`, nullable: the last TXID failure shown to the customer (rule U10).
- `txid` text, nullable, 64 lower-case hex: the TXID being verified or found.
- `txid_source` enum (`customer`, `scan`), nullable, set with `txid`.
- `txid_submissions` smallint, default 0, at most `MAX_TXID_SUBMISSIONS`.
- `search_started_at` timestamptz, nullable: when the current TXID was first looked for (rule U9).
- `confirmations` integer, nullable: the last count read, for the customer's progress.
- `transfer_id` uuid, nullable, unique, foreign key to `usdt_transfers`: the transfer this deposit is bound to.
- `last_checked_at` timestamptz, nullable; `created_at`, `updated_at`.
- Indexes:
  - partial unique `(method, pay_amount_units)` where the deposit is open. The deposit's status is mirrored as `deposit_open boolean`, kept by the deposit service in the same transaction and checked by the guard: a backstop for rule U3;
  - `(method, pay_amount_units)` for matching;
  - `(check_status)` for the verifier.
- Not append-only (it carries the verification state); never deleted. A trigger refuses `DELETE`, `TRUNCATE`, and any change of `deposit_id`, `method`, `receiving_address`, `tail_units`, `pay_amount_units`, or of `transfer_id` once set.

### `usdt_transfers` (new; owner: `deposits`; append-only)
Every confirmed, official-USDT transfer to a store address that the scanner or the verifier has seen (rule U13). One row per transaction: several matching transfer events in one transaction are summed.
- `id` uuid v7; `method` enum `payment_method` (`usdt_trc20`, `usdt_bep20`).
- `txid` text, 64 lower-case hex. **Unique `(method, txid)`.**
- `from_address`, `to_address` text.
- `raw_amount` numeric(78,0): the exact on-chain sum. `amount_units` bigint: `rawToUsdUnits`, floored.
- `block_number` bigint, `block_time` timestamptz.
- `source` enum (`scan`, `txid`): who saw it first.
- `created_at`.
- Index `(method, block_time desc)`, `(method, amount_units)`.
- Append-only trigger and grants (`APPEND_ONLY_TABLES`). Its status in the panel is derived: credited (claimed in `payment_references` by a deposit or an adjustment), bound (a deposit's `transfer_id`), or unmatched.

### `usdt_scan_cursors` (new; owner: `deposits`)
- `method` primary key (natural key); `cursor` text (TRON: the last block timestamp in ms; BSC: the last scanned block number); `last_success_at` timestamptz; `updated_at`.
- Not a business record (`NOT_BUSINESS_RECORDS`): the scanner's position, safe to move back (rule U12).

### `deposit_settings` (exists; append-only versions)
- Gains `usdt_trc20_enabled` and `usdt_bep20_enabled` boolean (default false), and `usdt_min_deposit_usd_units` (default $5; whole cents; at most both per-deposit limits). The new columns have defaults, so older versions read as disabled.
- The S03 account fields stay required. The first save of the settings form needs them even to enable USDT only (the form says so).

### `payment_references` (exists)
- USDT claims use the method and the normalized TXID, upper-cased by the table's rule.
- The S02 `manual_deposit` service normalizes a USDT reference with `txidSchema` before claiming it, and refuses a reference that is not a TXID (`VALIDATION_FAILED`). So a TXID typed with `0x` or as a link is the same claim as the one the worker makes.
- `paymentReferenceOwner` also looks up the `0X`-prefixed form, for development data entered before S04. No production USDT adjustment exists: Phase 1 is not deployed.

### Ledger (exists)
- System accounts created on first use: `usdt_receipts:usdt_trc20`, `usdt_receipts:usdt_bep20` (USD) and `deposit_rounding:USD`.

### Environment (api and worker; `.env.example` with fake values)
- `USDT_TRC20_ADDRESS`, `USDT_BEP20_ADDRESS`: the owner's receiving addresses. Optional: a missing address makes its network unavailable. An invalid one fails the boot (`addressSchema`).
- `CHAIN_READER`: `live` or `fake`. `fake` is refused when `NODE_ENV=production`.
- `TRONGRID_API_URL` (default `https://api.trongrid.io`), `TRONGRID_API_KEY`.
- `BSC_RPC_URL`, `BSC_RPC_API_KEY` (optional, depending on the provider).

## States and rules

### Deposit states (S03 table, USDT use)
| From | To | Who | When |
|---|---|---|---|
| — | `pending` | Customer | Creates the deposit (U2–U5) |
| `pending` | `submitted` | Customer or worker | A TXID is submitted (U8), or the scanner binds an exact-match transfer (U12) |
| `pending` | `cancelled` | Customer | Cancels before submitting (S03 SC11) |
| `pending` | `expired` | Worker | `expires_at` passed (S03 SC12) |
| `submitted` | `credited` | Worker, or the admin from review | Exact match final (U7), or approved in review (U15) |
| `submitted` | `rejected` | Admin | Rejects in review (U16) |
| `submitted` | `pending` | Worker | The TXID failed (U10) |

`check_status` refines `pending` and `submitted` for the customer and the admin:
- `pending`: `awaiting_transfer`;
- `submitted`: `searching` (a TXID not found yet), `confirming` (found, matching, waiting for finality), or `review` (found, not matching: in the admin queue);
- final: `done`.

Every transition locks the deposit row (`SELECT … FOR UPDATE`), checks the transition table, and writes its audit entry in the same transaction (S03).

### USDT rules
- U1. **Addresses** come from the server environment only (owner, 2026-10-08). The panel shows them read-only and cannot change them. A network is **available** when:
  - its address is set;
  - the deposit settings exist and its switch is on;
  - its scanner is not stale (U12).

  The options route says why a network is unavailable: `not_configured`, `disabled` or `delayed`. Each deposit stores the address it showed (`receiving_address`). Changing an address is a server change, and open deposits keep the address they showed (edge case 12).
- U2. **Creation** takes the method and the USD amount in whole cents. It requires an `Idempotency-Key` and ALTCHA, as S03 SC2 does (the same replay rules).
- U3. **Exact amount.** The deposit gets a random free tail `t` in {0.0001, 0.0002, …, 0.0099} USDT. The amount to pay is `declared + t` (for example `25.0037`).
  - "Free" means no **reserved** USDT deposit on the same network has the same `pay_amount_units`. A deposit is reserved while `pending` or `submitted`, and while `expired` or `cancelled` for 7 more days after `expires_at` or its cancellation (U4).
  - Tails are chosen under a transaction-level advisory lock per network, with the partial unique index as the backstop.
  - When all 99 tails of that amount are reserved, creation answers `DEPOSIT_AMOUNT_BUSY`, and the store suggests the same amount plus or minus one cent.
  - The tail is below one cent, so the credit of an exact match is exactly the declared amount (U7). The customer pays at most $0.0099 more, which goes to `deposit_rounding`.
- U4. **Validity**: `expires_at` is 24 hours after creation (owner, 2026-10-08), with S03's `deposits.expire` job and edge case 19. After expiry or cancellation, the amount stays reserved for 7 days. A late exact transfer then matches no live deposit and lands in the unmatched list with this deposit as its **candidate** (U13), so the admin knows whose it is.
- U5. **Limits**, shared with Sham Cash (owner, 2026-10-08):
  - the S03 SC3 tiers and the one 24-hour window across all methods (new account $50 per deposit and $100 per 24 hours; established $300 and $1,000);
  - the USDT minimum, $5 (`usdt_min_deposit_usd_units`), instead of the Sham Cash $2;
  - S03 SC4 (one `pending` deposit of any method per customer) and SC5 (at most 3 `submitted`, any method).

  The 24-hour sum counts the declared amount (not the tail).
- U6. **Never credit on doubt.** A chain reader error, a timeout, or an answer that is not an explicit result changes nothing: the job retries. Only a successful read can say "not found", "failed" or "confirmed". Confirmed means:
  - on TRON, the transaction info is returned by the solidity node (a solidified block, about 19 blocks);
  - on BSC, the receipt's block is at or below the `finalized` block and has at least 15 confirmations.
- U7. **Exact match, automatic credit (A01).** A transfer matches a deposit exactly when all of these hold:
  - the transaction succeeded;
  - the summed official-contract USDT transfers in it go to the deposit's `receiving_address`, on the deposit's network;
  - the raw sum equals `usdtRawForUnits(pay_amount_units)`;
  - the block time is at or after the deposit's `created_at`.

  When the transfer is also confirmed (U6), the worker credits the declared amount (Money flows M1) in the credit transaction:
  1. lock the deposit and check it is still `submitted` and bound to this transfer;
  2. `lockCustomerWallet`;
  3. claim the TXID (`claimPaymentReference`, the deposit's method);
  4. `postUsdtDepositCredit`;
  5. update the deposit (`decided_by = 'system'`, `transaction_number`, `received_currency = 'USD'`, `received_amount_units`, `credited_usd_units`, `journal_id`, `decided_at`);
  6. set `check_status = 'done'`;
  7. audit (actor `system`, channel `worker`);
  8. enqueue the email.

  The A02 after-commit hook stays a no-op, as in S03. Flags are not computed on exact matches: the money has arrived on chain, irreversibly.
- U8. **TXID submission** (optional, makes verification start at once):
  - only on a `pending` deposit not past `expires_at`;
  - `txidSchema`, at most 5 submissions per deposit (`TXID_ATTEMPTS_EXCEEDED`), and 20 per customer per hour (`RATE_LIMITED`, counted in `customer_rate_limits`, refused attempts included);
  - a TXID already claimed in `payment_references`, or bound to another deposit, answers `EXTERNAL_REFERENCE_TAKEN` (with no details for the customer).

  The deposit moves to `submitted` with `check_status = 'searching'`, `txid_source = 'customer'` and `search_started_at = now()`. A `deposits.usdt-verify` job is sent in the same transaction. A TXID on another network's link is accepted: the verifier looks on both networks (U11).
- U9. **Verification** (`deposits.usdt-verify`) reads the TXID on the deposit's network:
  - not found: retry every 15 seconds for 5 minutes, then every minute. Once 30 minutes have passed since `search_started_at` **and** at least 10 successful reads said not found, look on the other network (U11), then bounce `not_found` (U10). Failed reads (U6) count toward neither;
  - found, exact match: record the transfer, bind it, set `check_status = 'confirming'` and the confirmations; re-check every 10 seconds until confirmed, then credit (U7);
  - found, not matching: U10 or U11.
- U10. **Bounce** (`submitted → pending`, `check_error` set, `txid` cleared, `check_status = 'awaiting_transfer'`), when the transaction:
  - is not found (`not_found`);
  - failed or was reverted (`tx_failed`);
  - moves no token at all to the store address (`not_to_store`);
  - moves only a token other than the official USDT contract to the store address (`wrong_token`; fake "USDT" tokens are a common scam; amends ADR 0006, see ADR 0018).

  The deposit page explains the error. The customer can send a TXID again (U8), and the scanner keeps watching. If `expires_at` has passed, the bounce goes to `expired` instead. A bounce is audited.
- U11. **Review** (`check_status = 'review'`, deposit stays `submitted`, shown in the S03 queue). An official USDT transfer to a store address that does not match exactly goes to review with its flag, and the transfer is recorded and bound:
  - `amount_mismatch`: a different sum (an exchange took its fee from the amount, a partial payment, an over-payment);
  - `wrong_network`: the TXID is on the other network, to the store's address there;
  - `sent_before_deposit`: the block time is before the deposit's `created_at`.

  The admin page lists **candidate deposits**: reserved USDT deposits of any customer on the transfer's network whose `pay_amount_units` equals the received amount, or whose tail equals the received amount's sub-cent part. So a transfer that belongs to someone else is visible.
- U12. **Scanner** (`deposits.usdt-scan`, automatic detection, owner 2026-10-08):
  - Per network, it reads confirmed official-USDT transfers to the configured address since its cursor, with an overlap of 2 minutes (TRON) or 100 blocks (BSC). Duplicates are absorbed by `unique (method, txid)`.
  - On TRON, it reads only confirmed TRC20 transfers to the address, filtered by contract. On BSC, `eth_getLogs` for `Transfer` to the address on the USDT contract, up to the `finalized` block, in ranges within the provider's limit.
  - For each new transfer of at least $1 (U14), it inserts `usdt_transfers` (`source = 'scan'`). Then:
    - **one** reserved deposit on that network that is `pending` with `pay_amount_units` equal to the amount and `created_at` before the block time: bind it (`txid_source = 'scan'`, `pending → submitted`, `check_status = 'confirming'`) and credit it at once (the scanner only sees final transfers);
    - a `submitted` deposit still `searching` a customer TXID that is not this one, with an equal amount: the scanned transfer replaces the TXID (the customer probably pasted a wrong one), then the same credit;
    - otherwise the transfer stays unmatched (U13).
  - It runs every 20 seconds while the network has an open USDT deposit, and every 5 minutes otherwise (singleton per network).
  - `last_success_at` older than 10 minutes makes the network `delayed` in the options (new deposits wait) and sends a Telegram alert, rate-limited (A13). Open deposits keep their page, with a notice that verification is delayed.
- U13. **Unmatched transfers** are listed in the panel with their candidate deposits (U11 rule) and any expired or cancelled deposit of U4. The admin settles one through the S02 `manual_deposit` form, prefilled with the customer, the method, the TXID and the amount floored to whole cents. That form claims the TXID, so the same transfer can never be credited twice. Typical causes:
  - a late transfer for an expired deposit;
  - a second payment for a credited deposit;
  - a transfer with no deposit at all.
- U14. **Dust**: transfers below $1 are not recorded (address-poisoning spam). Their count per scan is logged.
- U15. **Approving a review**:
  - The credit is the received amount floored to whole cents (`floorToWholeCents`), at least $0.01. The admin cannot type an amount: a different outcome is a rejection plus an S02 adjustment, as in S03 RV2.
  - The request must acknowledge every flag (S03 RV5) and always needs re-authentication.
  - The transaction follows U7 with `decided_by = 'admin'`, the `decision_idempotency_key`, `admin_id`, and the claim under the **transfer's** network (a `wrong_network` credit posts from that network's receipts account).
  - An amount above the deposit limits is credited, as in S03 SC3: the money already moved.
- U16. **Rejecting a review**: S03 RV6 reasons plus `wrong_network` and `transfer_other_customer`, an internal note, and an optional customer note. The TXID stays unclaimed, so the right customer can still be credited through S02 (U13). Rejection never moves money. The rejection's internal note says how the owner settles a real transfer outside the system (as S03 M5).
- U17. **Re-check**: the admin can re-send `deposits.usdt-verify` for a `submitted` deposit, for example after a reader outage. It changes nothing by itself and is audited.
- U18. Deposit responses are `Cache-Control: no-store` (S03 SC15). The address QR is generated in the browser from the address text: no image route.

## Money flows
- M1. **Credit** (journal kind `deposit`, idempotency key `deposit:<deposit id>`, `postUsdtDepositCredit` in `packages/db/src/ledger/deposits.ts`):
  - `usdt_receipts:<transfer's method>` **−received** USD units (the exact received amount, sub-cent included);
  - `customer_wallet:<customer>` **+credit** USD (whole cents);
  - `deposit_rounding:USD` **+(received − credit)** when above zero (the tail, or the cents' fraction of a reviewed amount).

  The journal balances in USD; no rate is involved (1 USDT = 1 USD, ADR 0006). The deposit links to the journal (`journal_id`), and the TXID is claimed in `payment_references`.
- M2. Rounding: the credit is always floored to whole cents. The customer is never credited more than they sent. The store's gain from tails is visible in `deposit_rounding`.
- M3. Nothing else moves money. Creation, TXID submission, bounces, review, rejection, expiry and cancellation post nothing. A wrong credit is fixed by an S02 `correction` debit (S03 M4). Money received but not credited (rejected, unmatched, wrong token, dust) is outside the ledger until the owner records it with S02, and F20 reconciles the on-chain balance against `usdt_receipts` and the unmatched transfers.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/deposits/usdt/options` | Customer | — | `usdtOptionsSchema`: per network `{ method, available, unavailableReason, address, confirmations }`, the customer's USDT minimum, per-deposit max and remaining daily limit, `pendingDepositId` | — |
| `POST /api/deposits/usdt` | Customer, `Idempotency-Key`, ALTCHA | `createUsdtDepositSchema` (`method`, `amountUnits`) | `201` `depositSchema` (`200` on a replay) | `DEPOSIT_METHOD_UNAVAILABLE`, `DEPOSIT_LIMIT_EXCEEDED`, `DEPOSIT_ALREADY_PENDING`, `TOO_MANY_DEPOSITS_IN_REVIEW`, `DEPOSIT_AMOUNT_BUSY`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMITED`, `VALIDATION_FAILED` |
| `POST /api/deposits/:id/txid` | Customer | `submitTxidSchema` | `depositSchema` | `NOT_FOUND`, `DEPOSIT_STATE_CONFLICT` (not `pending`, not USDT, or past `expires_at`), `TXID_INVALID`, `TXID_ATTEMPTS_EXCEEDED`, `EXTERNAL_REFERENCE_TAKEN`, `RATE_LIMITED` |
| `GET /api/deposits`, `GET /api/deposits/:id`, `POST /api/deposits/:id/cancel` | Customer | as S03 | `depositSchema` with `usdt`: `{ method, address, payAmount` (string, 4 decimals)`, payAmountUnits, checkStatus, checkError, txid, explorerUrl, confirmations, requiredConfirmations, delayed }` | as S03 |
| `GET /api/admin/deposits` | Admin | S03 query plus `method?` | as S03; items carry the method | `VALIDATION_FAILED` |
| `GET /api/admin/deposits/counts` | Admin | — | S03 counts plus `usdtReview`, `unmatchedTransfers` (last 30 days) | — |
| `GET /api/admin/deposits/:id` | Admin | — | `adminDepositSchema` with `usdt`: the customer view's fields, `tailUnits`, the bound transfer (from, to, amount, block, time), `candidates` (U11) | `NOT_FOUND` |
| `POST /api/admin/deposits/:id/approve-usdt` | Admin, `Idempotency-Key`, re-authentication | `approveUsdtDepositSchema` | `200` `adminDepositSchema` | `REAUTHENTICATION_REQUIRED`, `DEPOSIT_STATE_CONFLICT` (not in review), `EXTERNAL_REFERENCE_TAKEN`, `FLAGS_NOT_ACKNOWLEDGED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/deposits/:id/reject` | Admin, `Idempotency-Key` | S03 `rejectDepositSchema` (new reasons) | `200` `adminDepositSchema` | as S03; a USDT deposit is rejectable only in review |
| `POST /api/admin/deposits/:id/recheck` | Admin | — | `202` `adminDepositSchema` | `DEPOSIT_STATE_CONFLICT` (not `submitted` or not USDT), `NOT_FOUND` |
| `GET /api/admin/usdt-transfers` | Admin | `method?`, `state?` (`unmatched` default, `all`), cursor | page of `adminUsdtTransferSchema` (the transfer, its state, the deposit or adjustment that holds it, candidates), newest first | `VALIDATION_FAILED` |
| `GET` / `PUT /api/admin/deposit-settings` | Admin (`PUT`: re-authentication) | S03 plus `usdtTrc20Enabled`, `usdtBep20Enabled`, `usdtMinDepositUsdUnits` | S03 plus `usdt`: per network the configured address or null, the switch, `lastScanAt`, `delayed` | S03; `VALIDATION_FAILED` when a switch is on without its address |

- The S03 Sham Cash approve route refuses a USDT deposit (`DEPOSIT_STATE_CONFLICT`), and `approve-usdt` refuses a Sham Cash one. The S03 request-receipt route refuses USDT.
- Statuses: `400` `TXID_INVALID`; `409` `TXID_ATTEMPTS_EXCEEDED`, `DEPOSIT_AMOUNT_BUSY`; the rest as S03.
- Wallet timeline `deposit` entries carry `method` (`usdt_trc20` or `usdt_bep20`) and the reference code. The admin view adds the deposit id and the TXID.
- After the change: `openapi:export` and the admin client regenerated.

## Jobs and integrations
- `ChainReader` interface in the worker's `deposits` module (an adapter per network, as the supplier adapters are), with one implementation per network and a `fake`:
  - `getTransfer(txid)` → `not_found` | `{ status: 'failed' }` | `{ status: 'succeeded', blockNumber, blockTime, confirmations, final, transfers: [{ contract, from, to, raw }] }`;
  - `listIncoming(address, cursor)` → final official-USDT transfers grouped by transaction, and the next cursor;
  - `head()` for health.

  Errors throw a typed `ChainReaderError` (timeout, rate limited, bad response) and never mean "not found" (U6). HTTP timeouts are 10 seconds, with no automatic retry inside the reader: the job retries.
  - TRON (TronGrid): `/walletsolidity/gettransactioninfobyid` (final info, receipt result, logs), `/wallet/gettransactioninfobyid` (seen but not solidified, for the progress), and `/v1/accounts/<address>/transactions/trc20?only_confirmed=true&only_to=true&contract_address=<USDT>&min_timestamp=…`.
  - BSC (JSON-RPC): `eth_getTransactionReceipt`, `eth_getBlockByNumber` (`finalized`, `latest`, and the receipt's block for its time), `eth_getLogs`.
  - The exact endpoints, limits and response shapes are confirmed with recorded, sanitized fixtures at implementation (no real customer TXIDs; public sample transactions only).
  - The `fake` reader keeps transfers in a table of the test database only, never in production. A development CLI, `pnpm --filter @vertex-digital/worker usdt:fake-transfer --method usdt_trc20 --amount 25.0037 [--txid <hex>] [--to <address>] [--contract <address>] [--failed]`, adds one, so the owner can run the acceptance locally.
- `deposits.usdt-verify` (sent by TXID submission, the re-check, and its own retries with `startAfter`; singleton key `depositId`): it loads the deposit fresh, does nothing unless it is `submitted` and `searching` or `confirming`, and applies U9–U11. Every write locks the deposit row and re-checks its state, so a second run, or a run racing the scanner, is a no-op or finds the transfer already bound.
- `deposits.usdt-scan` (U12; singleton per method; also a cron every 5 minutes as a safety net). The cursor moves only after the transfers of the read range are committed. Moving it back only re-reads transfers that `unique (method, txid)` absorbs.
- Emails: S03's `customer_deposit_credited` (params `creditedUsdUnits`, `referenceCode`, `depositId`, `at`) and `customer_deposit_rejected` (`reason`, `referenceCode`, `depositId`). No free text, TXID or address in emails. A bounce sends no email: the deposit page shows it, and the scanner keeps watching.
- Telegram: only the scanner stale alert and reader error bursts, through the existing worker alert channel (A13). The review card arrives with S05.
- Deploy: the server environment gains the address and reader variables. nginx needs no change (no uploads).

## Screens

### Store (Arabic, RTL, phone width first; dynamic, never cached)
- **`/wallet/deposit`**: the method picker now lists شام كاش, USDT (TRC20) and USDT (BEP20). Unavailable ones are disabled with the reason ("غير متاح حالياً", "التحقق متأخر حالياً"). A pending deposit redirects to its page (S03).
  - USDT form:
    - a network note ("أرسل على شبكة TRON فقط" / "BNB Smart Chain فقط");
    - the USD amount (numeric keyboard, Latin digits);
    - presets $10, $25, $50, $100 within the limits;
    - the limits line (minimum $5, per deposit, remaining today);
    - "رسوم الشبكة والمنصة على المرسل".
  - Errors appear inline by code. `DEPOSIT_AMOUNT_BUSY` offers ±$0.01.
- **`/wallet/deposits/[id]`** for USDT, by `checkStatus`:
  - `awaiting_transfer`:
    1. "أرسل هذا المبلغ بالضبط": the exact amount, large, the tail digits highlighted, copy;
    2. the network badge;
    3. the address: QR, full text in groups of 4 for a visual check, copy, and "انسخ العنوان من هنا دائماً، لا من سجل محفظتك";
    4. a warning: "إن كانت منصتك تقتطع رسوم السحب من المبلغ فأضفها، ليصل المبلغ المطلوب كاملاً؛ أي فرق يحوّل الإيداع إلى المراجعة";
    5. "ننتظر وصول التحويل وسنكتشفه تلقائياً" with a live dot;
    6. an optional "سرّع التحقق" field for the TXID or explorer link;
    7. the time left; cancel.

    A `checkError` shows above, in words (لم نجد العملية / العملية فاشلة على الشبكة / التحويل ليس إلى عنوان المتجر / العملة المرسلة ليست USDT الرسمية).
  - `searching`: "نبحث عن العملية على الشبكة" with the TXID and its explorer link.
  - `confirming`: "وصل التحويل، ننتظر تأكيد الشبكة" with a progress bar `confirmations / required`.
  - `review`: "قيد المراجعة" with the reason in plain words (for example "المبلغ المستلم 24.0037 يختلف عن المطلوب 25.0037"), and the S03 review ETA or the next opening.
  - `credited` (USD credited, the TXID link, time), `rejected` (reason, note, "إيداع جديد"), `expired` and `cancelled`: "إن كنت أرسلت المبلغ بعد انتهاء المهلة فتواصل معنا مع رقم العملية".
  - The page refreshes every 10 seconds while open and not final, and every 30 seconds when hidden. Loading: skeleton. Error: the standard block with retry. Not the customer's: 404.
- **`/wallet/deposits`** and the wallet timeline: method labels "USDT (TRC20)" / "USDT (BEP20)".

### Admin (Arabic, RTL)
- **Navigation**: the الإيداعات badge counts USDT reviews too. A new "تحويلات USDT" entry has its own badge (unmatched transfers of the last 30 days).
- **`/deposits`**: a method filter, a method chip per row. USDT rows in review show the reason flag.
- **`/deposits/$id`** (USDT):
  - facts: network, address shown, exact amount, tail, declared amount, times;
  - the TXID with its explorer link and source (customer or scan);
  - the bound transfer: from, to, received amount (with the difference highlighted), block, time, confirmations;
  - flags; candidate deposits with links; the S03 customer panel.
  - **Approve**: "اعتماد وإضافة $X" (X = received floored, shown live), flag ticks, internal note, re-authentication.
  - **Reject** (S03 dialog, new reasons). **إعادة التحقق** while `submitted`.
  - Decided deposits are read-only, with the decider ("تلقائي" or the admin).
- **`/deposits/transfers`**: a table (time, network, from, amount, TXID link, state: مُضاف / قيد المراجعة / غير مطابق), filters (network, unmatched or all), cursor.
  - Unmatched rows show candidates and the button "تسجيل إيداع يدوي", opening the S02 `manual_deposit` form prefilled (U13).
  - Empty: "لا تحويلات غير مطابقة".
- **`/settings/deposits`**: a USDT section:
  - per network, the configured address (read-only, with "يُغيَّر من إعدادات الخادم فقط"), the switch, the last successful scan and a delayed badge;
  - the USDT minimum.
- **Audit log**: the new actions in its filters.

## Audit and notifications
Every entry is written in its transaction.
- `deposit.created` (customer): S03 details. `method` is the USDT method and `rateId` is null. Plus `payAmountUnits`.
- `deposit.txid_submitted` (customer): `{ depositId, txid }`.
- `deposit.transfer_bound` (system, channel `worker`): `{ depositId, transferId, txid, source, receivedUnits, match: 'exact' | 'review', flags }`.
- `deposit.txid_bounced` (system): `{ depositId, txid, error }`.
- `deposit.credited`: S03 details, with `referenceCheck`, `creditRateId` and `acknowledgedFlags` nullable for USDT, and `decidedBy`. Actor `system` (channel `worker`) for exact matches, the admin for reviews.
- `deposit.rejected` (admin): S03.
- `deposit.rechecked` (admin): `{ depositId }`.
- `deposit.cancelled`, `deposit.expired`: S03.
- `deposit_settings.changed`: S03, with the new fields.
- Scans and reads are not audited. Transfers are themselves an append-only record.

Customer notifications: the credited and rejected emails (A16). S05 adds the notification center.

Admin: the panel badges; the scanner alert on Telegram (A13). S05 adds the review card.

## Abuse and fraud
| Threat | Control |
|---|---|
| A customer claims another customer's on-chain transfer (the address is public, so every transfer is visible) | Auto-credit only on an exact amount whose tail is reserved for this deposit alone (U3, U7) and sent after it was created. Anything else goes to review with the candidate deposits shown (U11). `transfer_other_customer` rejection |
| The same transfer credited twice (two deposits, the scanner and a TXID, a deposit and a manual adjustment) | `usdt_transfers` unique `(method, txid)`; `usdt_deposits.transfer_id` unique; `payment_references` claim of the normalized TXID across sources; journal key `deposit:<id>`; the deposit row lock |
| Fake USDT token sent to the store | Only the official contract counts (constants in contracts); a fake token bounces as `wrong_token` (U10); the scanner filters by contract |
| Reorganization or unconfirmed transaction credited | Credit only on a final read: TRON solidified, BSC finalized with 15 confirmations (U6); the scanner reads final data only |
| Reader outage taken as "not found" | Errors never conclude anything (U6); bounces only on an explicit answer after 30 minutes; delayed state shown to customers (U12) |
| Stolen admin session redirects deposits to the attacker's wallet | Addresses in the server environment, not editable in the panel (U1, owner 2026-10-08); the boot checks address checksums |
| Stolen admin session approves a fake review | Re-authentication on every USDT approval; the credit is the on-chain received amount, never typed; audit; customer email |
| Address poisoning (look-alike addresses, zero or dust transfers) | The address is copied only from the deposit page, with the warning; dust under $1 is not recorded (U14); the admin list shows full addresses |
| Exhausting the tails of a popular amount | One `pending` deposit per customer, creation limits (10 per hour), ALTCHA, verified emails, registration closed until the pilot; 99 tails per amount and network; `DEPOSIT_AMOUNT_BUSY` with ±1 cent |
| TXID spam to load the chain reader | 5 submissions per deposit, 20 per customer per hour; one verification job per deposit (singleton) |
| A compromised or wrong reader endpoint | HTTPS only; keys in the environment; nightly reconciliation of `usdt_receipts` against the on-chain balance (F20). One provider per network in V1, accepted risk (ADR 0018) |
| Wrong network or a non-USDT token by mistake | Network shown in large type; `wrong_network` review; other cases are settled by the owner outside the system and recorded with S02 |

## Edge cases
1. **Exchange fee taken from the amount** (the customer withdraws 25.0037 from an exchange that deducts 1 USDT, so 24.0037 arrives): `amount_mismatch` review if the customer sent the TXID. Otherwise the transfer is unmatched, with the deposit as a candidate (same tail). The admin credits $24.00.
2. **A platform that cannot send 4 decimals** (it rounds to 2): every transfer from it mismatches and is reviewed. Not confirmed for the main exchanges: Binance's withdrawal step for USDT was not verified (searched 2026-10-08). The owner's live check (Acceptance) tests one real exchange withdrawal. If it rounds, ADR 0018 is revisited before the pilot.
3. The customer pays twice: the first transfer credits; the second matches no live deposit and is listed unmatched with the credited deposit as candidate (U13).
4. Two partial transfers: each mismatches. The admin approves one in review and records the other through S02.
5. A transfer arrives after `expires_at`, deposit still `pending` (worker down): treated as expired (S03 edge case 19). When the job runs, the transfer goes to the unmatched list with the candidate.
6. Scanner and TXID verification find the same transaction at once: one transfer row wins the unique insert, and the deposit lock lets one binder win. The other sees it bound and stops.
7. The customer pastes a wrong TXID while the exact transfer has arrived: the scanner replaces it (U12) and credits.
8. A TXID on BSC submitted for a TRC20 deposit (or the reverse) that pays the store there: `wrong_network` review. The credit posts from the actual network's receipts account and claims under its method.
9. A transaction with several transfers to the store (a batch from an exchange): summed. A multi-recipient transaction with exactly our amount still matches; the from address does not matter.
10. ERC20 (Ethereum) USDT sent to the BEP20 address: not found on BSC or TRON, so it bounces `not_found`. The owner holds the same key on Ethereum and settles it by hand (S02).
11. The reader is down for hours: deposits stay `searching` or `confirming`. The customer sees "التحقق متأخر". No bounce, because a bounce needs 10 successful not-found reads (U9), and nothing expires once `submitted`.
12. The owner changes an address in the environment: new deposits show the new one. Open deposits keep the old address. The scanner watches only the configured one, so their transfers are caught by TXID or appear after the old address is re-added. The deploy notes say to change addresses with no open USDT deposits.
13. A switch turned off with deposits open: existing ones keep working (verification and scanning continue); new ones are refused.
14. A credit with an amount under the limits but the customer now frozen (S12): S12 decides. S04 credits, because the money arrived.
15. Concurrency: a parallel credit by the scanner and an admin approval of a reviewed deposit cannot both happen, because the deposit row lock and the state check let one pass.
16. Very large over-payment (for example $5,000 on a $50 deposit by a typo): review. The admin credits it (re-authentication, flag acknowledged) or rejects it and settles outside, as the owner judges.
17. An address in the environment that fails its checksum: the api and worker refuse to boot, with a clear log line, and no deposit shows a bad address.
18. A test customer: allowed, with the fake reader locally. On the server with the live reader, the owner's live check uses a test customer and real USDT (Acceptance).

## Open questions
None blocking. Q5 (USDT part) and Q8 were answered by the owner on 2026-10-08 (`docs/open-questions.md`, ADR 0018).

Owner actions before the Phase 1 production deploy, not needed for implementation:
- the two receiving addresses (owner-held wallets);
- a TronGrid API key;
- the BSC RPC provider account, if the chosen provider needs one. The implementation names the provider and its `eth_getLogs` limits, verified with recorded fixtures.

## Acceptance
The owner's browser check (local, `pnpm dev`, `CHAIN_READER=fake`, fake addresses in `.env`, emails written to files, a test customer from S01):
1. Panel: deposit settings: turn on TRC20 and BEP20 (re-authentication). The addresses show read-only, with the last scan time.
2. Store: "إيداع" → USDT (TRC20), $25. The page shows `25.00xx` USDT with the tail highlighted, the network badge, the QR, the address in groups and the copy buttons.
3. Terminal: `usdt:fake-transfer --method usdt_trc20 --amount <exact>`. Within about 20 seconds the page moves to credited without a TXID. The wallet shows +$25.00, and the email file exists with no TXID.
4. New deposit, $10 on BEP20. Paste a made-up TXID: "نبحث عن العملية". Add a fake transfer with that TXID and the exact amount but `--failed`: it bounces with "العملية فاشلة". Add a fake transfer of `9.00xx` (the same tail, $1 less) with a new TXID and paste it: review with the amount difference.
5. Panel: the queue shows the USDT review with `amount_mismatch` and the deposit as candidate. Approve: $9.00 is shown, the flag tick and re-authentication are required. Credited.
6. A fake transfer of `7.1234` with no deposit: it appears in "تحويلات USDT" as unmatched. "تسجيل إيداع يدوي" opens the S02 form prefilled. Save it, and the transfer shows as added. Try the same TXID on a new deposit: refused as already used.
7. A fake transfer to the store from a non-USDT contract with a pasted TXID: bounces "ليست USDT الرسمية".
8. Turn TRC20 off: the store shows it unavailable. Stop the worker for 10 minutes (or set the cursor's `last_success_at` back): the network shows "التحقق متأخر".
9. The audit log shows every entry above.

Owner live check (with the Phase 1 deploy, on the server, live readers; approved by the owner in that session): send $5 + tail on each network from the owner's usual exchange or wallet to a test customer's deposit, and confirm the automatic credit, the journal, and that the exchange sent the exact amount (edge case 2).

Tests:
- API, every route:
  - success, 401, and the customer/admin separation;
  - a customer reads only their own deposits;
  - every error code above;
  - re-authentication always required on `approve-usdt`;
  - `no-store`.
- Money and concurrency (real PostgreSQL):
  - the scanner and the verifier crediting the same transaction in parallel → one journal, one audit entry, one email;
  - two deposits with the same TXID → one claim;
  - an S02 manual deposit and a deposit claiming one TXID in parallel → one wins, including `0x`, link and case variants;
  - parallel creations of the same amount on one network → different tails, and the 100th refused with `DEPOSIT_AMOUNT_BUSY`;
  - an approval racing a re-check → one outcome;
  - the M1 journal: exact postings, `deposit_rounding` only when above zero, balanced.
- Rules (worker, with the fake reader and recorded fixtures of the live readers):
  - exact match;
  - each bounce error;
  - each review reason;
  - the reader error is never "not found", and the 30-minute window;
  - TRON solidified versus not;
  - BSC finalized and 15 confirmations;
  - summing several transfers in one transaction;
  - the BEP20 18-decimal amount with a remainder below a micro-unit (a mismatch);
  - the cursor overlap and duplicates;
  - dust ignored;
  - the stale scanner marks the network delayed and alerts once per window.
- Database:
  - the `deposits` check changes (system decisions, `reference_check` for Sham Cash only) and the guard's USDT bounce;
  - the `usdt_deposits` immutable fields and the open-amount unique index;
  - `usdt_transfers` append-only for the app role and the owner;
  - the settings defaults for older versions.
- Unit (contracts, 100% coverage): `txidSchema` (hex, `0x`, Tronscan and BscScan links, case, garbage), the address schemas (good and bad checksums), `usdtPayAmount`, `formatUsdtAmount`, `rawToUsdUnits` and `usdtRawForUnits` at 6 and 18 decimals, the tail bounds, the limit computation with the USDT minimum.
- E2E with RTL screenshots:
  - store, dark, phone width: the method picker, the USDT form, the awaiting page (amount, QR, address groups, warning), searching, confirming with progress, review, credited, a bounce error;
  - admin, light and dark: the queue with a USDT review, the USDT deposit page with the transfer and candidates, the transfers list, the settings section.

## Implementation notes
- Suggested PR split, each leaving `main` green:
  1. contracts, db (migration and guards), the `postUsdtDepositCredit` path, the readers (fake, TronGrid, BSC with fixtures), the worker jobs, the api routes, and the S02 TXID normalization;
  2. store and admin screens, with E2E.
- The readers follow the `packages/suppliers` pattern: one adapter per network behind the interface, recorded and sanitized fixtures, and no live call in tests. They live in the worker's `deposits` module unless a second consumer appears.
- Time rules compare with the database's `now()` (S03). The verifier's retry schedule is computed from `search_started_at`, so tests set past timestamps instead of waiting.
- Update `docs/architecture.md` (the `deposits` module's USDT parts, jobs `deposits.usdt-scan` and `deposits.usdt-verify`, the chain readers), `.env.example`, `docs/deployment.md` (the new variables and the address-change note), and the commands table for `usdt:fake-transfer`.
- Settled in PR 1 (contracts, db, api):
  - PRs: three instead of two. PR 1 is contracts, db and api; PR 2 the chain readers and the worker jobs; PR 3 the screens. Until PR 2, no scanner writes `usdt_scan_cursors`, so every network reads `delayed` and creation is refused (rule U1).
  - Reservation (U3, U4): a deposit's amount is reserved while open and for 7 days after its last change, whatever its final status, credited and rejected included, so a customer's second payment of a credited amount never matches another customer's new deposit (edge case 3). Candidates use the same set.
  - `deposit_open` is kept by a database trigger on the deposit's status (`deposits_sync_usdt_open`, migration 0014), not by the service; the USDT row's guard refuses any other value.
  - A deposit's USDT check becomes `done` when it is credited, rejected, cancelled or expired.
  - `POST /api/deposits/:id/txid` takes the pasted text (`submitTxidSchema`: up to 300 characters); the API normalizes it and answers `TXID_INVALID`. A TXID held by another deposit (bound, or being verified) or claimed on either network is `EXTERNAL_REFERENCE_TAKEN`.
  - The customer's `usdt` block carries `receivedAmountUnits` and `reviewReasons` for the review page's sentence (U11); the admin's adds the tail, the TXID source and count, the transfer and the candidates.
  - `deposits.usdt-verify` and `deposits.usdt-scan` are pg-boss `stately` queues (one job queued and one active per deposit or network), declared in `QUEUE_POLICIES` and created that way by the API and the worker.
  - `approve-usdt` is a `@Sensitive()` route; `reject` refuses a USDT deposit not in review.
  - The all-zero addresses an older `.env.example` shipped count as unset. `CHAIN_READER` and the reader variables arrive with PR 2, in the worker.
  - The TRON contract was checked on Tronscan's contract page (2026-10-08); Tether's own page could not be reached from the build environment, so the BSC contract rests on BscScan and its EIP-55 checksum until the owner's live check.
  - A TXID whose official-USDT transfer to the store is under $1 (rule U14 keeps it out of `usdt_transfers`) bounces the deposit back to `pending` with a clear reason instead of going to review (owner, 2026-10-08); PR 2 adds the reason.
- Settled in PR 2 (chain readers and worker jobs):
  - Two TXID failures were added to `USDT_CHECK_ERRORS` (migrations 0016 and 0017), both bounces to `pending`: `amount_too_small` (official USDT reached the store, but under $1, never recorded; the owner's choice of 2026-10-08) and `txid_used` (the transfer is already bound to another deposit or claimed by an S02 manual deposit: two customers pasted one TXID; a final outcome, never a retry loop).
  - A transfer is recorded in `usdt_transfers` and bound only once it is final: until then a found TXID shows `confirming` with its count, whether or not it matches, and a reorganization that drops it returns the search to `not_found`. So `confirming` never carries a `transfer_id`; an exact final match is bound and credited in one transaction, a mismatch is bound and sent to review in one transaction.
  - A bounce, a review and a credit all wait for finality; only "not found" (after 30 minutes and 10 successful reads) is concluded from unconfirmed data.
  - The count of successful "not found" reads travels in the verify job's payload (`notFoundReads`); a re-check or the API's first job starts it at zero. A reader error is caught, alerted (one text per network and kind, so the alert channel suppresses repeats), and the next read scheduled: it never fails the pg-boss job.
  - The scanner's listing only names transactions; each new one of $1 or more is then read with `getTransfer`, so its block, time, finality and exact sum come from the transaction itself. `last_success_at` moves only when a scan reaches the final head (a scanner catching up keeps the network `delayed`). Every scan also re-sends the verification of an open deposit with no read for 5 minutes (a lost chain of jobs).
  - The scanner credits a `pending` deposit only when the transfer's block is before its `expires_at` (edge case 5); a `searching` deposit whose TXID it replaces is the oldest one asking for that exact amount.
  - Creating a USDT deposit also sends the network's scan job (one per network), so an exact transfer is found within about 20 seconds.
  - `getTransfer` and `listIncoming` are the interface; `head()` was not needed (health is the scanner's `last_success_at`).
  - The `fake` reader keeps its transactions in a git-ignored JSON file (`FAKE_CHAIN_FILE`, default `./.data/fake-chain.json`, written by `usdt:fake-transfer`), not in a database table: it then cannot exist where the live readers run. Tests use an in-memory store. `CHAIN_READER=stub` (an older `.env.example`) still reads as `fake`.
  - BSC: one provider URL (`BSC_RPC_URL`, its key inside the URL); `BSC_RPC_API_KEY` is not used. Logs are read 1,000 blocks per `eth_getLogs` call and at most 10 ranges per run; the first read looks back 5,000 blocks (TRON: one hour). The provider is the owner's choice before the Phase 1 deploy; it must support the `finalized` tag.
  - The reader fixtures are synthetic, shaped after the documented replies: the build environment could not reach TronGrid or any BSC endpoint (2026-10-08). Re-recording them from public transactions, and the owner's live check, confirm the exact shapes before the pilot.
  - From the PR 2 review:
    - A TXID that fails while the customer has opened another `pending` deposit cannot bounce back (one pending per customer, S03 rule SC4): the worker rejects it `not_received` instead (`decided_by = 'system'`), audited (`deposit.txid_bounced`, then `deposit.rejected` with actor `system`) and emailed (owner, 2026-10-08). It takes the customer's creation lock, as the API's creation does. Past `expires_at` the same applies, since expiring passes through `pending`.
    - The scanner never binds a transfer whose TXID is claimed on either network (an S02 manual deposit recorded during an outage, possibly under the wrong network): it stays unmatched, so it is neither credited twice nor allowed to block the scan.
    - BSC lists logs only up to `min(finalized, latest − 14)`, the last block with 15 confirmations; a listed transfer that still reads not final (a lagging node) stops the run without moving the cursor or alerting, and the next scan reads it again.
- Settled in PR 3 (store and admin screens):
  - The store's "إيداع" page reads the Sham Cash and the USDT options together; the method picker shows the three methods, an unavailable USDT network reads "غير متاح حاليًا" (`not_configured`, `disabled`) or "التحقق متأخر حاليًا" (`delayed`). The status badge of an open USDT deposit reads "بانتظار التحويل" (`pending`) or "قيد التحقق" (`submitted`, not in review).
  - The address QR is drawn in the browser as SVG (`qrcode.react`, already used by the panel for TOTP), so the CSP needs no change. The "live dot" is static: `brand/identity.md` §9 forbids blinking.
  - The TXID field checks the text with `normalizeTxid` before sending (no request for an obvious typo), and sends it as pasted.
  - The panel's reject dialog offers the reasons that fit the method: Sham Cash keeps the S03 list; USDT offers `not_received`, `wrong_network`, `transfer_other_customer` and `other`.
  - "تسجيل إيداع يدوي" on an unmatched transfer first asks for the customer (a candidate's, or a search by name, email or phone), then opens the S02 adjustment dialog prefilled with `manual_deposit`, the network, the TXID and the amount floored to whole cents. The admin writes the internal reason.
  - The USDT switches are disabled in the panel while their network has no address in the server environment (the API refuses it too).
