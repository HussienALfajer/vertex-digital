# 0042 — Deposit limits, two fraud flags, the Telegram approval cap and the owner daily cap removed

Status: Accepted · Date: 2026-11-17 (owner decisions of 2026-11-16) · Amends [0006](0006-payments-and-deposits.md), [0017](0017-sham-cash-deposits-and-exchange-rate.md), [0018](0018-usdt-deposits.md), [0019](0019-telegram-bot-switches-notifications.md), [0030](0030-resend-refusals-admin-orders-and-supplier-catalog.md)

## Context
The launch limits were set low on purpose (0006, 0017, 0018): small per-deposit and 24-hour deposit limits, a new-account tier, the `new_account_large` and `velocity` flags, approval from Telegram only up to $100 (0019, equal to the panel's re-authentication threshold), and a $100 owner daily cap on owner-funded panel purchases (0030). On 2026-11-16 the owner removed them. Every deposit is still reviewed against the money received (the Sham Cash account or the chain) before it is credited.

## Decision
- **Deposit limits** (amends 0006, 0017, 0018): no per-deposit and no 24-hour limit for any account (new, established, merchant tier or customer override). A Sham Cash deposit needs one cent; USDT keeps its network minimum ($5). The only ceiling left is technical: `DEPOSIT_MAX_USD_UNITS`, the largest whole-cent amount whose USDT pay amount with its tail stays a safe integer; above it the deposit is refused with `DEPOSIT_LIMIT_EXCEEDED`, never a fault. One pending deposit per customer, three in review, the creation rate limits and ALTCHA stay.
- **Fraud flags** (amends 0006): `new_account_large` and `velocity` are no longer raised. Receipt reuse, receipt similarity, the shared phone, the reference check and the amount mismatch stay, and every flag still has to be acknowledged before approval.
- **Telegram approval** (amends 0019): any unflagged `submitted` Sham Cash deposit of an active customer can be approved from the linked admin chat, whatever its amount, with the same transaction-number prompt, confirmation, re-checks at confirmation (state, frozen, flags, the receipt) and audit entry. USDT approvals stay in the panel. The setting column stays unread.
- **Owner daily cap** (amends 0030): owner-funded panel purchases are not capped. The `owner_drawings:USD` lock and the day's total stay, and the total is shown in the panel, the Telegram notice of each purchase and the daily summary.
- The retired settings columns (deposit limits, flag thresholds, the Telegram cap, the owner cap, the customer and tier deposit limits) stay in the schema, unread and hidden, until a later two-step migration drops them.

## Consequences
- Threat model (replaces 0019's line on a stolen Telegram account and 0030's on a stolen session): whoever controls the admin's linked Telegram chat can credit an unflagged Sham Cash deposit of any amount without the panel's re-authentication, and a stolen admin session can spend owner funds without a daily ceiling. The defences left are the admin's custody of the Telegram account and the panel session (TOTP, idle timeout), the Telegram notice of every decision and panel purchase, the audit log, the daily summary and the nightly reconciliation.
- A new account can deposit a large amount on its first day; the review against the received money is the control.
- Panel copy, store copy and tests no longer state these limits; the specs carry the amendments (S03 SC3, FL3, FL4; S04 U5; S05 TC4; S12 LM2; S16 AP7; S20 MD1, MD4; S23 TS3).
