# 0040 — Merchant shops, shop customer accounts and shop wallets

Status: Accepted · Date: 2026-11-10 · Amends [0003](0003-money-currencies-and-ledger.md), [0007](0007-auth-customers-and-staff.md), [0035](0035-price-lists-and-merchant-accounts.md), [0036](0036-merchant-tools-levels-and-order-verification.md)

## Context
The V1 scope declined "the merchant mini-store" and deferred ledger transfers between accounts (owner, 2026-10-20). On 2026-11-10 the owner asked for both, in a chosen model: an approved merchant gets a branded shop at `/s/<slug>` whose retail customers hold wallets funded by the merchant (S26). The model moves money between a merchant and other people's wallets, adds people who are customers of a merchant rather than of Vertex, and lets one email exist in several shops.

## Decision
- **Shops:** one per merchant, approved by the admin, with states `requested`, `active`, `suspended`, `closed`, `rejected`. A merchant revocation closes the shop and freezes the list it buys at (`price_list_id_at_close`) until its balances are settled.
- **Shop customers are a third identity realm**, beside customers and the admin (amends 0007). They live in their own tables (`shop_customers`, sessions, accounts, verifications), behind a third Better Auth instance whose routes sit under `/api/shops/<slug>/auth/`. An email is unique per shop, not system-wide. The instance's database adapter scopes every user and session lookup to the path's shop (a session carries its shop, keyed to its user's), and the unique index is `(shop_id, email)`; proven on Better Auth 1.7.7 in S26 PR 1. A session belongs to one shop and is signed out on any other shop's routes, on every Vertex customer route and on the admin host. If the installed Better Auth cannot scope users by shop, the fallback is one email, one shop account system-wide, decided with the owner.
- **Shop wallets (amends 0003):** new account kind `shop_customer_wallet` (USD, whole cents, never negative, named by `shop_customer_id`) and the system account `shop_margin_held:USD`. New journal kinds `shop_transfer` and `shop_margin`. The only money into a shop wallet is a merchant transfer, a refund, a compensation or an admin adjustment. The only money out is a purchase, a return the customer confirms, or the admin's settlement. Shop customers never deposit or withdraw.
- **Vertex sells to the merchant:** a shop order is the merchant's order at the merchant's list price (margin guard, fulfilment, cost of goods and tier counting unchanged), paid from the shop customer's wallet at the merchant's selling price. The difference is held in `shop_margin_held` and released to the merchant only for delivered units when the order finishes. Undelivered units refund the full selling price to the shop customer. A shop never sells a pack below the merchant's purchase price (amends 0035, 0036).
- **The merchant's exchange rate** is the shop's display and transfer rate only. It never touches a journal's amounts beyond the stored conversion of a SYP-entered transfer (rounded down to cents) and of a SYP selling price (rounded up to cents).
- **Limits** per shop, set by the admin: a shop customer's balance cap, the merchant's daily transfers to customers, and the number of customers.
- **Support** for shop customers goes to the merchant first, and to the admin on escalation.

## Consequences
- The ledger keeps one posting function and one balance rule; reconciliation adds two checks (the held margin equals the open shop orders' margins; shop wallets sum to their postings).
- Merchants become custodians of customer relationships but never of customer money: the balances are held in Vertex's ledger, so a merchant who disappears leaves customers able to spend their balance or be settled by the admin.
- A third auth realm adds attack surface; every shop route checks the session's shop, and the realm-separation tests grow by one realm.
- Laundering through transfers and returns is bounded by caps, the customer's own confirmation of returns, no deposits or withdrawals by shop customers, and a per-shop return-ratio alert.
