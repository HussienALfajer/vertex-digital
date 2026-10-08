# 0017 — Sham Cash deposits and the exchange rate in V1

Status: Accepted · Date: 2026-10-08 · Amends [0003](0003-money-currencies-and-ledger.md), [0006](0006-payments-and-deposits.md)

## Context
The S03 spec (F04, F05) settled the open questions on the exchange rate (Q6), the Sham Cash account (Q4), the deposit limits (Q5, Sham Cash part) and the review hours (Q9) with the owner. Some answers change rules that ADR 0003 and ADR 0006 left open or stated differently:
- whether the store holds SYP in the books;
- what happens when a receipt arrives after the rate lock;
- the deposit states;
- when an approval needs re-authentication.

## Decision
- **One rate** (SYP per 1 USD) for display and for SYP deposits, set by the admin. It has history, re-authentication, and a typed confirmation when it moves more than 5%. The display step is **5 SYP** by default, bounded to 1–50 SYP until products exist (S06 adds the 2% rule of ADR 0003). The panel warns when the rate is older than 48 hours; nothing is blocked.
- **Sham Cash in SYP and USD**: the customer chooses. USD is credited as received. SYP is converted at the deposit's rate and floored to whole cents. The QR images are uploaded by the admin from the Sham Cash app, one per currency. The account details are panel data, never repository content.
- **SYP is held in the books.** A SYP deposit posts four lines that balance per currency: `sham_cash_receipts:SYP` against a new `currency_exchange` account pair, and that pair's USD side against the customer wallet. The ledger then shows the pounds the store holds, for reconciliation, and its conversion position.
- **The 15-minute lock covers the receipt submission.** The first submission inside the lock fixes the deposit's rate for good. After the lock, the customer sees a new quote at the current rate and accepts it before submitting. The admin never chooses a rate from a receipt's timestamp.
- **Deposit states** (amends ADR 0006):
  - `pending` → `submitted` → `credited` | `rejected`, plus `pending` → `expired` (24 hours without a receipt) and `pending` → `cancelled` (by the customer);
  - `submitted` → `pending` **once per deposit**, when the admin asks for a clearer receipt.
- **Approval** needs re-authentication only above **$100** or when any fraud flag is present. Flags never block an approval; each must be acknowledged explicitly. A missing or different reference code is a flag. A reference belonging to another customer is always a rejection.
- **One claim per external payment reference** (Sham Cash transaction number, later a TXID) across deposits and manual-deposit adjustments, in a single `payment_references` table with a unique `(method, reference)`. Uniqueness across two tables cannot be enforced without races.
- **Limits at launch** (panel settings):
  - minimum $2;
  - new account (no credited deposit): $50 per deposit and $100 per rolling 24 hours;
  - established account: $300 and $1,000;
  - no fees.

  One deposit awaiting a receipt and at most three under review per customer. Review hours 10:00–22:00 `Asia/Damascus`, with a 15-minute target.

## Consequences
- The ledger can be reconciled against the real Sham Cash balances in both currencies (F20).
- Customers never get a rate they did not see, and the store never credits more than the pounds received are worth.
- One more account kind and four-posting journals; `postJournal` already balances per currency.
- S04 (USDT) reuses the deposit model, `payment_references` and the limit rules. It decides whether USDT shares the daily limit (Q5, USDT part).
