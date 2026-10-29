# 0038 — Merchant tiers: chained tier lists, effective tier and per-tier privileges

Status: Accepted · Date: 2026-10-30 · Amends [0035](0035-price-lists-and-merchant-accounts.md) (the parent cap on tier lists, the price kind and visible tier prices), [0036](0036-merchant-tools-levels-and-order-verification.md) (levels become three fixed tiers, the effective level includes the admin's grant)

## Context
S21's volume levels pick a price list and nothing else, and none exist in production. The owner wants four named tiers (Bronze, Silver, Gold, Diamond) that differ in look and in what a merchant may do, not only in price (S23 interview, 2026-10-29). Margins are thin (60 UC costs about $0.887 and sells for about $0.97), so tier steps are cents, and a tier must never cost more than the tier below or sell below cost.

## Decision
- **Four fixed tiers on top of S21 levels.** Bronze is a merchant without a level, priced by the seeded wholesale root. Silver, Gold and Diamond are at most one live level each, with thresholds rising by tier. Names and order are fixed; thresholds, lists and privileges are the admin's.
- **Tier lists form one chain with a parent cap.** Silver's list inherits from wholesale, Gold's from Silver's, Diamond's from Gold's, each holding only its own rules. On a list named by a live level, a price above the parent list's price takes the parent's (source `parent_cap`); lists are repriced parents first. Every row stays guarded by its minimum margin, so no tier sells below cost and no tier is dearer than the one below.
- **The effective tier is the higher of earned and granted.** The admin may grant a higher tier for at most 90 days; `merchant_profiles.level_id` holds the effective level, so prices, privileges and the badge follow one column and S21's list resolution is unchanged. The grant carries no visible mark for the merchant.
- **Privileges live in per-tier settings,** append-only versions like the merchant settings: deposit limits, player-check quota, bulk lines and code quantities (ceiling 100), queue priority, a reply promise, a direct contact, early access, faster alerts and receipt options. Bronze's row replaces the merchant-wide deposit and check values.
- **Tiers are shown, lists are not.** A tier-list account has price kind `wholesale` with the tier's name beside it; the tier table shows three packs' prices on every tier; rules, costs and list names stay private. The badge reaches the merchant's customers (receipts, verification, price list, certificate, sticker) from Silver up.
- **Early access hides, never discounts.** A game or product the admin marks is visible and buyable only to tiers with early access for 24 hours, then to everyone.

## Consequences
- What a merchant pays is still one list and one price row (ADR 0035); a tier only chooses the list, and the cap only lowers a price to another guarded price.
- Rules on wholesale that are more specific than a tier's rules are overridden by the nearer tier list (S20 LS4); the cap keeps the tier at or below them, and the admin repeats a specific rule on a tier list to go lower.
- Deposit limits and quantities can change with a tier mid-flow; they apply when a deposit or order is created, and a list checked under a higher tier is refused after a fall.
- No reward, cashback, credit or referral exists: the only money effect of a tier is its price (owner, 2026-10-29).
