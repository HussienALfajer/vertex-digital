# 0032 — Several routes per supplier, routes outside the price basis, and per-route timing

Status: Accepted · Date: 2026-10-18 · Amends [0005](0005-supplier-adapters-and-routing.md) (one route per supplier per product), [0020](0020-pricing-engine.md) (the price basis), [0021](0021-supplier-sync-price-review-and-health.md) (route changes and stock alerts), [0022](0022-order-fulfilment-timing-reviews-and-test-orders.md) (one timing policy for every route)

## Context
WDGZone sells the PUBG Mobile UC packs through two offers: Auto (seconds, unlimited stock) and Web Purchase (1–7% cheaper, about 1,000 per pack refreshed daily at 00:00 UTC, 5–30 minutes, failures refunded automatically). A product could hold only one route per supplier. Following the cheapest route's cost (ADR 0020) would drop the price every day while Web Purchase has stock and raise it when it runs out (ADR 0021 reprices route changes at once). One hard limit of 30 minutes for every attempt (ADR 0022) would hold Web Purchase orders that are still within WDG's stated time. The owner settled these in the S17 interview (2026-10-18).

## Decision
- A product may have several live routes of one supplier, one per offer; an offer still serves one product.
- Each route has a "counts for the price" flag (default on). The price basis is the first usable route among flagged routes. When none of them is usable but another route is, a product that has a price keeps it; one that never had a price follows the first usable route. A non-flagged route's cost changes never move the price nor open a review. Routing order is unchanged (lowest cost first), so a cheaper non-flagged route is used first and its saving is margin.
- Each route may set an expected delivery time, shown to the customer while an attempt on it is open, and its own hard limit (5–240 minutes) before the order is held; both are copied onto the attempt at creation. The poll schedule stays one policy.
- A first send refused as out of stock marks an offer with a finite reported stock out of stock until the next sync.
- Stock alerts count only flagged routes.
- Health stays per supplier.

## Consequences
- The store price stays stable while a cheaper, finite or slower route is used first; the saving is profit, not a lower price.
- A misconfigured flag could move prices: the panel pre-sets the flag off for an added route of a product that already has one, and every change is audited and repriced at once.
- Slow routes do not flood the owner with held orders, but a customer may wait up to the route's limit before the owner is told.
