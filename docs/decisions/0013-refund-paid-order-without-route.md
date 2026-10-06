# 0013 — A paid order with no profitable route is refunded

Status: Accepted · Date: 2026-10-06 · Amends 0004

## Context
In ADR 0004 a `paid` order can only move to `sent_to_supplier`. The pay transaction checks the price and the margin guard, but the worker routes the order a moment later (A03), and in between a supplier can be switched off (F26), become unhealthy, or raise its cost above the price. With no allowed exit the order would stay `paid`: the customer's money held, nothing delivered, and no state that says why.

## Decision
- Add the transition **`paid → refunded`**: when the worker routes a paid order and no healthy profitable route is left, it refunds the full amount to the wallet, as A04 does after a failed attempt. Nothing was sent to a supplier, so no unit can be delivered later.
- The refund is the same as any full refund (ADR 0004): one reversing journal with the idempotency key `order:<id>:refund`, in the same transaction as the state change, its order event and its audit entry.
- Everything else in ADR 0004 is unchanged. In particular, an attempt with an `unknown` outcome never leads to this transition: the order is already `sent_to_supplier` and goes to `needs_review`.

## Consequences
- Every paid order ends in a terminal state without staff action, unless its outcome is unknown.
- The transition table in `packages/contracts` (`src/orders.ts`) is ADR 0004's table plus this transition.
