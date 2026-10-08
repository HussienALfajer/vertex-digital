# 0020 — Pricing engine: margin rules, price basis and the margin guard

Status: Accepted · Date: 2026-10-08 · Amends [0005](0005-supplier-adapters-and-routing.md) (the margin guard's boundary)

## Context
F10 prices every product from a supplier cost and a margin. The owner had to settle the default margin and price endings (Q7), where the official price for savings comes from (Q13), which route's cost a price follows when a product has several suppliers, and what customers see when a product cannot be sold. ADR 0005 wrote the guard as `cost < price − minimum margin`, which makes a price set exactly at the minimum margin unprofitable. The catalog and pricing spec (S06) comes before supplier mapping (S07), so the costs prices need do not exist yet when the rules are built.

## Decision
- **Rules:** a margin rule is a percent (basis points), a fixed amount and a minimum margin, in USD units. Rules exist globally and per category, game and product; the most specific live rule applies and replaces its parent entirely. The global rule always exists. Default (owner, 2026-10-08): 10%, $0 fixed, $0.10 minimum. Every rule's minimum margin is at least $0.01. Rule changes need re-authentication and are audited.
- **Price:** `price = ceilToWholeCents(max(cost + ⌈cost × percent⌉ + fixed, cost + minimum margin))`, integer math, rounding only upward; no price endings beyond whole cents (owner, 2026-10-08). SYP prices are derived from the current rate and step, never stored.
- **Price basis:** a product's price follows the cost of the cheapest healthy route in stock (degraded routes only when no healthy one exists). A more expensive backup route is used for an order only while it is still profitable for the price paid; otherwise the undelivered units are refunded (ADR 0004, 0013).
- **Margin guard:** a route is profitable for a price when `price − cost ≥ minimum margin` (a margin exactly at the minimum is profitable; this replaces the strict inequality in ADR 0005). Routing never uses an unprofitable route, and a product with no profitable route is paused automatically.
- **Official price:** entered by the admin per product, optional; savings are shown only when it is known and above the price, as a whole percent rounded down, from 1%.
- **Availability:** derived, never stored: hidden (archived), paused (by the admin), paused by the margin guard, out of stock (no healthy route with a known cost), or available. Unavailable products stay visible to customers, greyed out, with no price and no buy action.
- **Sequencing:** S06 builds the rules, the math, the guard predicate and a preview; S07 brings route costs, stores prices with their history, reprices on cost and rule changes, and runs the guard. Until a product is mapped, it is out of stock.

## Consequences
- A price can always be explained from one cost and one rule, and is never below cost plus the minimum margin.
- Following the cheapest route gives competitive prices; when the cheapest supplier fails and the backup costs more than the price allows, the customer is refunded instead of the store losing money.
- Prices move with supplier costs; S07's review queue (A06) holds large changes for the admin.
