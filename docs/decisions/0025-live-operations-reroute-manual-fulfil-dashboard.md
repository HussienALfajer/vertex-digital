# 0025 — Live operations: reroute, manual fulfil with proof, dashboard figures

Status: Accepted · Date: 2026-10-10 · Amends [0004](0004-orders-and-fulfilment-state-machine.md) (admin-chosen attempts), [0022](0022-order-fulfilment-timing-reviews-and-test-orders.md) (held-order decisions, manual delivery)

## Context
ADR 0022 gave the admin four decisions on held orders: poll again, confirm delivered, confirm failed, refund. F17 also asks for rerouting to another supplier and manual fulfilment with delivery proof, and F18 asks for today's sales and profit without defining them. Manual delivery so far recorded the manual offer's cost and no evidence. The owner settled these in the S11 interview (2026-10-10).

## Decision
- **Reroute:** allowed for an order in `needs_review` or waiting on the manual supplier. The admin confirms the current attempt did not deliver (it closes `failed`) and picks a route that is usable, untried for the order, profitable against the order's minimum margin and funded; never an unprofitable route. A running automatic attempt before the hard limit cannot be rerouted.
- **Manual fulfil:** in the same two cases, the admin records a delivery made outside the system with a required screenshot (admin-only), an optional reference and the actual unit cost (zero allowed). A cost above the price needs an explicit confirmation and is flagged in the audit. The cost is posted to cost of goods against `supplier_prepaid:manual`. For manual attempts this replaces "confirm delivered" without proof.
- **Refund:** also allowed for an order waiting on the manual supplier, so a refund never sends the order to another route by accident.
- **Dashboard figures:** "today" is the `Asia/Damascus` day so far, compared with yesterday to the same hour. Sales are the delivered units' value of real customers' orders finished in the period; profit is sales minus those deliveries' cost of goods. Test customers are left out of money figures and included in what needs the admin's action. Reports by period stay with S13.
- **Live room alerts:** an open order turns "slow" after its product's measured p90 delivery time (at least 2 minutes, 10 minutes without data) and red in `needs_review`; an optional sound, off by default, plays when an order needs the admin.

## Consequences
- The owner can unblock any held or manual order from one screen without breaking "never pay two suppliers by accident": the risk exists only after the hard limit or for manual orders, behind a warning, and late results raise conflict alerts.
- Manual fulfilment can sell at a loss by the owner's explicit choice; reconciliation (S13) checks `supplier_prepaid:manual` against the owner's records.
- Profit on the dashboard follows deliveries, so it matches the daily summary but not the day's ledger movements; the ledger view belongs to S13 reports.
