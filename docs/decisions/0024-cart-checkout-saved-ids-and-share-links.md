# 0024 — Cart checkout in one journal, saved player IDs, and public share links

Status: Proposed · Date: 2026-10-09 · Amends [0003](0003-money-currencies-and-ledger.md) (one purchase journal may pay several orders), [0004](0004-orders-and-fulfilment-state-machine.md) (an order's purchase journal may be its checkout's)

## Context
F16 asks for a cart "paid in one wallet debit; each line is its own order", a gift top-up with a shareable card, and a shareable receipt. F14 asks for saved player IDs and one-tap recharge. ADR 0004 gives each order its own purchase journal and refund, and codes must never reach a public page. The owner settled the open choices in the S10 interview (2026-10-09).

## Decision
- **Checkout:** a cart of at most 10 lines, kept in the browser, is paid all or nothing in one transaction. A `checkouts` row holds the customer's idempotency key and **one** `purchase` journal (key `checkout:<id>:purchase`) for the sum. The wallet shows one entry. Each line is a normal paid order that points to that journal, so `orders.purchase_journal_id` is unique only outside a checkout. Refunds and cost of goods stay per order (ADR 0004), so a checkout's refunds never exceed what it paid. A cart cannot be reserved: when the balance is short, the customer deposits first.
- **Checkout notifications:** each order notifies in the center. One summary email is sent when the checkout's last order finishes, decided under a lock on the `checkouts` row.
- **Saved player IDs:** saved from the buy box with a label, at most 10 per game and 50 per account, with the name of a `valid` check. A saved ID, or the ID of a delivered order, counts as confirmed by the customer for one-tap buying. A supplier refusal of that account marks the saved ID and turns off its one-tap. The rows are customer preferences, which the customer deletes for real.
- **Share links:** gift and receipt pages are public at a 128-bit random token, revocable by the customer or the admin, and never expire on their own. They show only what the customer chose (a receipt's price and the player ID, masked by default) and never a code, an email, a phone or a name. Gifts are for direct top-ups only, with a sender name and a message that cannot hold links, handles or phone numbers.

## Consequences
- A cart is one money event for the customer and the ledger, while fulfilment, refunds and the order write path stay unchanged per order. Reconciliation checks that each checkout's journal equals the sum of its orders.
- A refused cart line refuses the whole cart. A customer never ends up with half a cart paid by surprise.
- Public pages become a new surface on the store's domain. Masking by default, the text rules, rate limits and revocation keep it from leaking data or carrying scams.
