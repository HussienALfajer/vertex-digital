# 0033 — Supplier health hysteresis, pre-purchase quotes and charge checks

Status: Accepted · Date: 2026-10-19 · Amends [0021](0021-supplier-sync-price-review-and-health.md) (health thresholds and alerts), [0005](0005-supplier-adapters-and-routing.md) (a cost read before a purchase) · Spec: `docs/specs/S18-wdg-hardening.md`

## Context
In production WDGZone's health changed between `healthy` and `degraded` every few minutes (2026-10-14, 15, 19). With no orders, a 30-minute window holds about 10 calls (a balance read every 5 minutes, two syncs of two calls each), so one error moves the success rate between 90% (9 of 10: healthy) and 88% (8 of 9: degraded) as calls enter and leave the window. One threshold decided both directions; every change repriced the supplier's products, refreshed the store and sent a Telegram message. The single error each time was a whole catalog read failed by one slow page. Separately, the cost a sale is priced on can be up to 15 minutes old while WDG reprices hourly, and what WDG actually charged was never compared with what we expected.

## Decision
- **Hysteresis:** `degraded` below 90% success (unchanged); back to `healthy` only at **95% or more held for 5 consecutive minutes**. The minimum sample is **10 calls**. Both values are in the supplier policy, editable in the panel (owner, 2026-10-19).
- **What counts as an error:** a reply the supplier gave and the adapter read is never an error, even when the order is not finished yet; consecutive errors make a supplier `down` only when they span at least two operations; a catalog page that answers on retry is no error.
- **Alerts:** a health change is applied at once, but told on Telegram only after it holds for 5 minutes (`down` at once), naming the last state the admin was told.
- **Every errored call keeps its failure kind** (timeout, DNS, connection, TLS, rate limit, 5xx, …) so an outage at the supplier is told from a network problem.
- **Quote before buying:** the first send of an attempt reads the offer's current cost; a cost above the order's unit price is not bought (next route) and the offer is repriced; a failed read buys as before (owner, 2026-10-19).
- **Charge check:** what the supplier says it charged is kept on the attempt; more than 2% off the expected cost is noted and alerted; a charge above the order's unit price becomes the offer's cost, so the margin guard pauses the product until reviewed (owner, 2026-10-19). The nightly reconciliation compares the supplier's orders of the day with our attempts.

## Consequences
- One stray error no longer moves the state or sends a message; a real outage still reaches `down` within minutes through the balance read, the sync and orders.
- A supplier recovers more slowly (at least 5 minutes after the errors leave the window), which keeps degraded routes in the second tier a little longer.
- Each order costs one extra supplier call (about 80 ms) and can no longer be bought below the supplier's current cost.
