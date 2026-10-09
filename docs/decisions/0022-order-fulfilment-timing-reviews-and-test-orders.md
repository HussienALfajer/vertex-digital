# 0022 — Order fulfilment: timing, held orders, test orders and code reveal

Status: Accepted · Date: 2026-10-09 · Amends [0004](0004-orders-and-fulfilment-state-machine.md) (the hard limit, admin decisions, refunds after delivery, input rejections), [0005](0005-supplier-adapters-and-routing.md) (test customers' routes, the adapter outcome)

## Context
ADR 0004 says an unknown supplier outcome is polled and, past "the product's hard limit", held for a human, but it sets no timing and does not say what the human may do. The manual supplier's orders need a way to reach the owner and be delivered. Test customers hold test funds that would spend real supplier balance if their orders were routed like any other. Codes are revealed to the buyer "each reveal logged", without saying how. A supplier that refuses the player's account would be retried on every backup route for nothing. The owner settled these in the S08 interview (2026-10-09).

## Decision
- **Timing:** one policy for every automatic supplier, not per product: first poll 60 seconds after sending, then every minute until 10 minutes, then every 5 minutes; an attempt still open after **30 minutes** moves the order to `needs_review`, alerts the admin on Telegram and tells the customer it is delayed. Polling goes on every 30 minutes for 24 hours and a late result still applies. The values are an append-only policy editable in the panel with re-authentication.
- **Unknown outcomes are re-sent, not looked up:** a poll of an attempt whose send outcome was unknown repeats `placeOrder` with the same idempotency key, since the supplier may never have received it; adapters answer a repeated key with that order's outcome.
- **Held orders:** the admin may poll again, confirm delivered (with the units and, for codes, the codes), confirm failed (the next route or a refund follows), or refund without another route. Every decision needs re-authentication and a written reason and is audited.
- **Delivered is final:** a delivered order is never refunded through the order; a make-good is a wallet adjustment (S02).
- **Manual supplier:** a Telegram card (no field values, no codes) and one reminder after 15 minutes; delivery or failure only from the panel. Manual attempts have no hard limit.
- **Input rejected:** a definitive failure the supplier marks as a refused account (player not found, wrong zone) refunds the remaining units at once without trying other routes.
- **Test customers:** their orders use only the `fake` and `manual` suppliers, so test funds never spend real supplier balance. The launch checklist's live order per supplier is placed from a normal account with a real deposit.
- **Purchases:** no amount cap beyond the wallet balance and the product's maximum quantity; a rate limit of 10 orders per 10 minutes per customer.
- **Code reveal:** the buyer reveals each code with a tap, logged with time, IP and device, and sees when it was first revealed; no extra code by email. The admin reveals only with re-authentication and an audit entry.
- **Measured delivery time:** per product, payment to delivery over the last 50 delivered orders of real customers within 30 days, median and p90, shown from 5 orders.

## Consequences
- A customer's order either finishes on its own in seconds to minutes, or reaches the owner within 30 minutes with a clear set of actions; nothing is sent to a second supplier while the first may still deliver.
- The owner's refund after an unknown outcome can lose the cost of goods if the supplier delivers late; that case raises a conflict alert and is settled with the supplier (S13).
- Test accounts can be used on production without spending supplier balance, at the cost of not exercising the real adapters from them.
