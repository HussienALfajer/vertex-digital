# 0031 — Drop SHOP2TOPUP: WDGZone is the only automatic supplier

Status: Accepted · Date: 2026-10-14 · Supersedes the SHOP2TOPUP parts of [0004](0004-orders-and-fulfilment-state-machine.md), [0005](0005-supplier-adapters-and-routing.md) and [0021](0021-supplier-sync-price-review-and-health.md)

## Context
ADR 0005 named SHOP2TOPUP the primary supplier and WDGZone the backup. Its adapter was never built (Q12): S07 seeded its supplier row, its pause switch and its supplier treasury place, and waited for the account. WDGZone's adapter shipped, passed a live order on 2026-10-14 and serves the store. On 2026-10-14 the owner decided not to use SHOP2TOPUP.

## Decision
- The suppliers are `wdgzone` (automatic), `manual` (the admin fulfils by hand) and `fake` (development, tests, E2E). SHOP2TOPUP is removed from the code, the panel, the documentation and the database.
- Removal follows expand, then contract:
  1. The code and the documentation drop it; a migration refuses to run while anything references its supplier row (any table with a foreign key to `suppliers`, its pause switch's changes, its ledger account, an audit entry), then deletes the row. Audit and ledger rows are never deleted, so a reference stops the deploy for the owner to decide.
  2. Once that release is deployed, a second migration drops the `supplier_code` value `shop2topup` and the `store_switch` value `shop2topup_paused`. The released code still sends the switch name to PostgreSQL, so the values cannot go in the same release.
- Applied migrations (0026, 0027) and git history keep the name: migrations are never edited once applied, and history is never rewritten.
- Player validation (ADR 0005, S09) stays in the code with no live supplier behind it: WDGZone does not check player ids, so the store asks the customer to confirm the id. A future supplier that validates plugs in through its adapter's capability.

## Consequences
- Routing, the margin guard, price review and health work unchanged with one automatic supplier and the manual one as last resort (ADR 0021).
- Q12 is closed; Q17 waits for a second automatic supplier.
- Adding a supplier later is still an adapter, fixtures, a doc and a mapping (`/supplier-adapter`), plus its enum value and seed row.
