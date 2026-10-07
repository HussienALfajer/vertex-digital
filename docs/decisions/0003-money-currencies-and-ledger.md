# 0003 — Money, currencies and the ledger

Status: Accepted · Date: 2026-10-06 · Amended by [0016](0016-single-admin-account.md) (one admin account, no staff or roles)

## Context
Customers pay in Syrian pounds (Sham Cash) or USDT and buy goods that suppliers price in USD, sometimes with sub-cent precision (e.g. $0.889 per pack). The Syrian pound moves; customers think in SYP but the business needs a stable base. A wallet that stores a balance and updates it in place cannot explain itself, and loses money silently under races.

## Decision

### Currencies and units
- **USD is the base currency.** The wallet, prices, costs and profit are in USD.
- USD amounts are **integers in micro-dollars** (1 USD = 1,000,000 units), so supplier costs keep their full precision. Customer-facing amounts (prices, wallet credits from deposits) are always whole cents (multiples of 10,000 units); contracts enforce it.
- **SYP** is the new Syrian pound, stored as integer units with 2 decimals. It is shown next to USD everywhere and accepted for deposits.
- **USDT** received on chain is recorded as the raw on-chain amount with its network (6 decimals on TRON, 18 on BNB Smart Chain) and credited 1 USDT = 1 USD in whole cents (ADR 0006).
- Columns: `<name>_units` (`bigint`) next to a currency code column, or a name that fixes the currency (`price_usd_units`). The scale comes from `CURRENCY_SCALE` in `packages/contracts`. No floating-point column or arithmetic anywhere; money math lives in one tested module in `packages/contracts`.

### Exchange rate
- An admin-set **USD→SYP rate** (SYP per 1 USD, exact `numeric`), with history. Every transaction that involves SYP stores the rate value and the rate record it used.
- SYP display prices are USD × rate, rounded **up** to a configured clean step. The step is in **new** Syrian pounds (two zeros removed from the old pound) and must stay small relative to the cheapest product: e.g. a step of 5 SYP when 1 USD is about 110–130 SYP. A step that would add more than a set share of the price (default 2%) to the cheapest active product is refused when saved. The step and the rate are owner/manager settings (F04); the current market rate and the step are confirmed with the owner in the F04 spec.
- A SYP deposit quote locks the rate for **15 minutes**. After that, a new quote at the current rate is needed (A12).
- Reports convert with stored rates, never today's rate.

### Ledger
- **Double-entry, append-only journal.** Each money event is one `journal` row with two or more `postings` that sum to zero per currency. Accounts: one wallet account per customer, plus system accounts (Sham Cash receipts, USDT receipts per network, supplier prepaid balance per supplier, sales revenue, cost of goods, refunds, adjustments).
- A customer's **balance is the sum of their wallet postings**. No balance column is ever updated in place. A cached balance may be added later only as a derived, rebuildable snapshot.
- Rows are never updated or deleted: the database role used by the apps has no `UPDATE`/`DELETE` on journal and posting tables, and a trigger refuses them. Mistakes are corrected by reversing journals that reference the original.
- Every journal carries an **idempotency key** (unique): the deposit id, the order id with its step, or the staff action id. Posting the same key twice is a no-op that returns the first result.
- Debits lock the customer's wallet account row (`SELECT … FOR UPDATE`), check the balance, and post in the same transaction. A wallet balance never goes negative.
- The posting function lives in `packages/db` and is the only way to write the ledger, used by both the API and the worker.

### Policy
- **No customer withdrawals in V1** (owner, 2026-10-06). Refunds go back to the wallet. An exceptional cash refund is done by the owner outside the system and recorded as an audited adjustment journal.
- Staff adjustments need owner or manager permission, a reason, re-authentication and an audit entry.

## Consequences
- Every balance can be explained line by line, and the nightly reconciliation (F20) can prove the books balance.
- Sub-cent supplier costs need no rounding until the customer sees a price.
- Slightly more complex writes; the shared posting function and its tests carry that complexity once.
