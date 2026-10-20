# 0034 — FazerCards as second supplier, the store-wide player check, and routing ties

Status: Accepted · Date: 2026-10-19 · Amends [0005](0005-supplier-adapters-and-routing.md) (routing tie-break, a supplier only for checks), [0020](0020-pricing-engine.md) (a basis switch goes to review), [0023](0023-reservations-and-player-validation.md) (who checks a player), [0031](0031-drop-shop2topup.md) (WDGZone no longer the only automatic supplier)

## Context
WDGZone does not check player ids, so the store never shows whose account a top-up goes to. FazerCards checks them (name and region) and sells the same packs at the same costs as WDGZone (one upstream, read on 2026-10-19). ADR 0023 lets only a route's own supplier check a player, so a check supplier would have to fulfil the pack too. With two automatic suppliers, equal costs are common, and the router breaks ties alphabetically, which would send orders to FazerCards first. Q17 (a price-basis switch to another route skips review) only matters with a second automatic supplier. The owner settled these in the S19 interview (2026-10-19).

## Decision
- FazerCards (`fazercards`) is the second automatic supplier, integrated through the full V1-relevant API (S19). Its routes compete on cost like any route; its gift-card routes stay off until a clean live code per brand.
- A game may name a **check provider**: a supplier with the player-check capability, its check category, a field map and allowed regions. That provider checks every `direct` pack of the game, whatever supplier fulfils the order. Without one, ADR 0023's route-based choice applies.
- A region outside the game's allowed regions **blocks** the purchase; "not found" stays a warning the customer confirms (ADR 0023).
- Player-check calls do not count toward a supplier's routing health.
- Routing order within a tier and a cost: shorter measured delivery time (median over the last 7 days, at least 10 delivered attempts), then route priority, then the supplier precedence `wdgzone`, `fazercards`, `fake`, `manual`.
- A price-basis switch to another route that moves the price above the review threshold opens a review, as a same-route change does (Q17). It applies between automatic routes; a move to or from a manual route (a fallback and its end) reprices at once (owner, 2026-10-20).

## Consequences
- Customers see the account name and region before paying for every game FazerCards checks, even when WDGZone delivers.
- The FazerCards plan becomes a dependency of the check: when it lapses, checks fall back to manual confirmation and its routes pause; deliveries continue through WDGZone.
- A basis capture by a supplier whose cost drops sharply waits for the owner instead of moving the store price at once.
- With equal costs WDGZone stays first until FazerCards proves faster on real orders.
