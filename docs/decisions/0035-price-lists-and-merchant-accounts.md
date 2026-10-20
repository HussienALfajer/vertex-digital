# 0035 — Price lists and merchant accounts

Status: Accepted · Date: 2026-10-20 · Amends [0020](0020-pricing-engine.md) (one price per product becomes one per list), [0021](0021-supplier-sync-price-review-and-health.md) (one review holds every list), [0023](0023-reservations-and-player-validation.md) (reservations paid on their own list), [0026](0026-customer-freeze-limits-archive-and-support-tickets.md) (a merchant limits tier), [0006](0006-payments-and-deposits.md) (merchant deposit limits)

## Context
Phase M (F28, F29) sells wholesale to shops beside retail. ADR 0020 gives each product one stored price from one rule chain; the store reads it from a public cache. Merchants, accounts the admin chooses and named groups of accounts must pay other prices, which must never undercut cost, never leak to other people, and never move faster than the review that protects retail against supplier errors. The owner settled the rules in the S20 interview (2026-10-20).

## Decision
- **Account type** (`customer`, `merchant`) decides what a person sees and the limits tier; the **effective price list** (assigned, else retail for a customer and wholesale for a merchant) decides what they pay. Merchant status only by the admin: approving an application or a direct grant; revocation returns the account to retail with its balance untouched.
- **Lists:** three seeded roots (retail, wholesale 5% with a $0.05 minimum, cost 1% with a $0.01 minimum) and up to 20 named custom lists, each with a fixed parent. A list holds margin rules (global, category, game, product) and fixed prices per product. Resolution is list-first: the nearest list in the chain that has an entry for the product supplies it (fixed price, then product, game, category, global rule).
- **Prices:** every list is stored as its own append-only price rows from the same basis route and repriced with retail on every cause. A fixed price that no longer covers cost plus its guarding rule's minimum margin falls back to the rule price with an alert. No list is ever priced above retail (capped, guarded by retail's minimum margin). One review per product, decided on retail, holds every list.
- **Purchases** charge the account's list row and record the list on the order; a list change cancels the account's open reservations, and a reservation is never paid on a list the account no longer has.
- **Privacy:** the public catalog and search carry retail only; private prices come from a customer route that is never cached; receipts and share links never show a non-retail price; customers see a price kind label ("سعر التاجر", "سعر خاص"), never a list's name or a cost.
- **Merchant tier:** $2,000 per deposit and $5,000 per 24 hours, 60 orders per 10 minutes, editable in the panel; S12 per-customer overrides still replace it.

## Consequences
- Each order's price is still explained by one cost, one rule or fixed price and one list, and is never below cost plus a minimum margin.
- Price rows grow with the number of lists (at most 23 per product per change); repricing locks stay the same.
- A supplier error held for review cannot be exploited by merchants faster than by retail customers.
- Merchant game pages render the cached page, then their private prices; non-retail search results carry no price.
