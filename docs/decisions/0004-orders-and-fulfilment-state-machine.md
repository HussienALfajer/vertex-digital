# 0004 — Orders and the fulfilment state machine

Status: Accepted · Date: 2026-10-06 · Amended by [0013](0013-refund-paid-order-without-route.md) (`paid → refunded`), [0016](0016-single-admin-account.md) (one admin account, no staff or roles)

## Context
An order spends the customer's money and asks a supplier for goods over the network. Networks time out, suppliers answer late through webhooks, and customers double-tap. The two failures that matter most are charging without delivering and delivering twice (paying two suppliers for one sale).

## Decision

### States
| State | Meaning | Next |
|---|---|---|
| `awaiting_balance` | Saved with its price; the wallet was too low; nothing debited | `paid` (after a deposit, A02) · `cancelled` (expiry or customer) |
| `paid` | Wallet debited; fulfilment job enqueued in the same transaction | `sent_to_supplier` |
| `sent_to_supplier` | An attempt is with a supplier | `delivered` · `failed` · `needs_review` |
| `failed` | Short-lived: the last attempt failed definitively for some or all remaining units; the router picks the next profitable route for those units or refunds them | `sent_to_supplier` (next route) · `refunded` · `partially_refunded` |
| `needs_review` | Outcome unknown or inconsistent; a human decides | `delivered` · `sent_to_supplier` · `refunded` · `partially_refunded` |
| `delivered` | Terminal: every unit delivered | — |
| `partially_refunded` | Terminal: some units delivered, the rest refunded to the wallet | — |
| `refunded` | Terminal: no unit delivered; the full amount returned to the wallet by a reversing journal | — |
| `cancelled` | Terminal: never paid | — |

- The allowed transitions are a table in `packages/contracts`; the transition write path in `packages/db` updates with `WHERE status = <from>` and writes the order event and audit entry in the same transaction. A transition that matches no row is a lost race and is not retried blindly.
- Every change appends an `order_events` row (state, actor: system, supplier or staff, details), which feeds the live timeline and the audit.

### Attempts
- Each try with a supplier is a `fulfilment_attempts` row with its own UUIDv7, sent as the supplier's idempotency key (`order_id` for SHOP2TOPUP, `X-Idempotency-Key` for WDGZone), the supplier's reference, the cost and the raw result.
- Supplier results are classified by the adapter (ADR 0005) as `delivered`, `pending`, `failed_definitive` or `unknown`.
- **An `unknown` outcome (timeout, 5xx after sending, unparseable answer) is never followed by a try with another supplier.** The worker polls the same supplier with the same key; if the outcome stays unknown past the product's hard limit, the order goes to `needs_review` (A14).
- Retrying with the same supplier and the same key is safe (idempotent); a new attempt with another supplier needs a definitive failure of the previous one.

### Quantity and partial delivery
- An order has a quantity (1 for most direct top-ups; more for code products or packs the supplier sells in units). Every attempt records how many units it asked for and how many were delivered.
- A supplier may deliver only some units (SHOP2TOPUP reports `partial`). Delivered units are final. The remaining units follow the normal rules: retried on the next profitable route after a definitive failure, or refunded.
- `delivered` means every unit was delivered. When some units are delivered and the rest are refunded, the order ends in **`partially_refunded`** (terminal), with a reversing journal for exactly the undelivered units at the unit price paid (idempotency key `order:<id>:refund:<attempt>`). The sum of refunds can never exceed what was paid; a database check and a test enforce it.

### Code products
- Codes (gift cards, vouchers, PINs) returned by a supplier are stored **encrypted at rest** (AES-256-GCM, key from the server environment, separate from the supplier keys secret), one row per unit, linked to the attempt.
- Only the buying customer can reveal a code, on the order page; each reveal is logged. Codes never appear in emails, push messages, Telegram, shareable receipts, logs, Sentry events or exports. Staff see codes masked and reveal one only with a dedicated permission, re-authentication and an audit entry.
- A code product is `delivered` only when every unit has a code stored.

### Money in the flow
- Pay: one transaction locks the wallet, checks the balance and the current price, posts the purchase journal, sets `paid` and enqueues the fulfilment job (pg-boss in the same transaction).
- Refund: a reversing journal for the undelivered units (the whole amount when nothing was delivered), in the same transaction as `refunded` or `partially_refunded`. Each refund is posted at most once (idempotency key `order:<id>:refund` for a full refund, `order:<id>:refund:<attempt>` for undelivered units).
- Cost of goods is posted when an attempt is delivered, from the supplier's prepaid account.
- Price changed between viewing and paying: the API refuses with `PRICE_CHANGED` and the new price; the customer confirms again.
- An `awaiting_balance` order keeps the price it was created with until it expires (default 24 h, set in the F13 spec); if the margin guard would be broken at pay time, it is cancelled instead of paid at a loss.

### Customer-side idempotency
- Purchase and deposit endpoints require an `Idempotency-Key` header (UUID generated by the client per attempt); the same key from the same customer returns the first result.

### Store switches
- The emergency stop and the per-method and per-supplier switches (F26) are read inside the pay and deposit transactions; a stopped store refuses new purchases and deposits with a coded error, while orders already paid continue through fulfilment or refund.

## Consequences
- Double delivery needs a supplier to break its own idempotency, which reconciliation (F20) would reveal.
- Some orders wait for a human in `needs_review`; that is the price of never paying twice. The live orders room (F17) makes them visible and fast to resolve.
