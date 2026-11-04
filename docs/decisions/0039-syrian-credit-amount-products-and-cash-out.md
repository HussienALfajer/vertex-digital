# 0039 — Syrian credit and bills through zddk stores, amount products, and cash products under controls

Status: Accepted · Date: 2026-11-04 · Amends [0003](0003-money-currencies-and-ledger.md) (cash products are a controlled way out of the wallet), [0005](0005-supplier-adapters-and-routing.md) (a third automatic supplier, polling only; supplier precedence), [0026](0026-customer-freeze-limits-archive-and-support-tickets.md) (section limits per customer and per recipient)

## Context
On 2026-10-29 Syrian mobile credit was "not planned". On 2026-11-04 the owner brought it back: jneedcontur, a store on the zddk platform, sells Syriatel and MTN credit, both operators' bills and Syriatel Cash through a reseller API, which neither WDGZone nor FazerCards has. Bills and cash take any amount, which the pack-and-quantity model (at most 50 units of one pack) cannot express. Credit is near-cash and resold; the cash products put wallet money on a mobile cash wallet, which is a withdrawal in effect, and ADR 0003 excluded withdrawals for fraud and money laundering. jneedcontur's webhook is unsigned, its error shape is undocumented and its order key is documented as UUIDv4. The owner settled the rules in the S25 interview (2026-11-04).

## Decision
- **Supplier:** `jneedcontur` is a third automatic supplier, served by a generic `zddk` adapter whose base URL is fixed in code per supplier code. It works by polling only (its webhook is never trusted), looks orders up by our own key, and sends a key of UUIDv4 layout derived deterministically from the attempt id. Its routes compete on cost and count for the price like any route, games included. Supplier precedence on ties: `wdgzone`, `fazercards`, `jneedcontur`, `fake`, `manual`.
- **Amount products:** a third product kind `amount` sells a free amount in fixed steps (100 SYP in V1): the quantity is the amount over the step, the price row is the price of one step, priced and guarded by the existing engine (whole cents, rounded up). Credit stays fixed packs, since the supplier sells fixed values only.
- **Section:** games carry a service class (`credit` or `cash`) with exactly one recipient field of a fixed operator type (`syriatel_number`, `mtn_number`). The section is priced in USD and shown SYP first. Credit sent to a wrong number is not refunded; the number is typed twice and confirmed before paying.
- **Limits:** a daily cap per customer on the section (retail $50, merchants $500), a daily order count per recipient number across all accounts (5, merchants 20) serialised by an advisory lock, and an alert when a number is topped up from a third account within 7 days. All values live in one audited policy row.
- **Cash products (amends ADR 0003):** sold only from balance credited at least 72 hours ago, never reserved, capped daily (retail $20, merchants $100), and held for the admin's approval above $10 (merchants $50); a rejected or expired hold is refunded in full.

## Consequences
- The section has one supplier: an outage of jneedcontur stops it until a second zddk store (TweetPin) is added through the same adapter.
- Until the supplier answers its open questions (Q31–Q42), every reply outside the documented success shape is an unknown outcome, so routes stay off until the answers and a live order.
- Cash orders above the threshold wait for the owner; the controls bound what a stolen or reversed deposit can take out to the daily cash cap.
- A new product kind touches the buy box, the cart, the sale mode and the price list, but not the ledger or the order state machine.
