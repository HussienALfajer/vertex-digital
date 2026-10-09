# 0023 — Reservations (`awaiting_balance`) and player validation

Status: Accepted · Date: 2026-10-09 · Amends [0004](0004-orders-and-fulfilment-state-machine.md) (the price of an `awaiting_balance` order when it is paid; its expiry and limits)

## Context
F13 lets a customer whose wallet is short save an order as `awaiting_balance` and have it paid after a deposit (A02), or expire (A15). ADR 0004 says such an order "keeps the price it was created with until it expires (default 24 h, set in the F13 spec)", but not what happens when the price falls, when several reservations compete for one deposit, or when the product is unavailable at that moment. F13 also checks the player ID with the supplier before paying, under a validation guard, without saying what a "not found" answer does. The owner settled these in the S09 interview (2026-10-09).

## Decision
- **Reservations:** at most 3 open per customer, each for **24 hours**. No money moves and no balance is held. They count toward the purchase rate limit, and the purchase stop refuses them.
- **Price at pay:** the **lower** of the saved price and the current price. When the saved price is charged, the margin guard is checked against the current rule; with no profitable route the reservation is cancelled (`price_rose`) and the customer told by email.
- **Paying (A02):** after every deposit credit (queued in the credit's transaction) and by a sweep every 5 minutes, oldest first. A reservation the balance cannot cover is skipped and the next one is tried. A reservation whose product is unavailable stays reserved until it expires.
- **Notifications:** a paid reservation in the notification center only; an expired or cancelled one in the center and by email.
- **Player validation:** for signed-in, verified customers, after typing stops or a field loses focus. Results are cached per game and account (valid 24 hours, not found 1 hour). Limits count only calls that reach a supplier: 10 an hour and 30 a day per customer, 30 an hour per IP. Each supplier has a daily quota, 1,000 by default and editable in the panel. A "not found" answer is a **warning, not a block**: the customer confirms the ID to buy. The same confirmation is required when validation is unavailable. The server requires that confirmation unless the cached result is valid.

## Consequences
- A customer never pays more than the price they saw, and the store never sells below its margin to honour a reservation.
- A deposit pays what it can at once rather than waiting behind a larger, older reservation.
- A supplier's false "not found" never stops a sale. A real wrong ID still costs nothing, since a supplier refusal refunds at once (ADR 0022).
- Validation results reveal player names only to verified customers within tight limits. Accounts someone checked in the last 24 hours can be looked up again without counting.
