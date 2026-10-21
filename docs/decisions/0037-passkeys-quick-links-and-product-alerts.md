# 0037 — Customer passkeys, direct buy links and product alerts

Status: Accepted · Date: 2026-10-21 · Amends [0007](0007-auth-customers-and-staff.md) (passkeys for customers, kept out of V1 until now), [0024](0024-cart-checkout-saved-ids-and-share-links.md) (saved IDs feed the home page's quick buy), [0026](0026-customer-freeze-limits-archive-and-support-tickets.md) (order tickets carry a problem)

## Context
Phase M's store growth features (F40–F42, S22) make retail buying quicker and order help clearer. The owner settled the rules in the S22 interview (2026-10-21). Four of them shape the system beyond one screen: a second way for customers to sign in, public links that resolve to packs and are counted, alerts that a worker sends on the customer's own price list, and tickets that name an order's problem.

## Decision
- **Passkeys are a customer sign-in method, guarded by the password.** Better Auth's passkey plugin runs on the customer auth instance only (relying party: the store's host; user verification required). Adding a passkey needs the account password and a 5-minute grant, sends a security email, and is capped at 10 per account. A password reset by email code deletes every passkey; a password or email change keeps them. A passkey session goes through the same hooks as a password session (archived accounts refused, sign-in log, new sign-in email). The admin keeps password and TOTP only (ADR 0016).
- **Direct buy links are permanent product codes.** Each product gets a 6-character code (`/q/<code>`) that never changes; the store resolves it on the server and redirects to the game page with the pack. Opens (one per address, code and hour) and paid orders (one per order, written in the purchase transaction) are kept 90 days in an append-only counting log, never tied to money.
- **Product alerts are one-shot and private.** An alert (available, or price below the price when it was set) is sent once, in the center and by push, by a 15-minute worker job, on the customer's effective price list; a list change rebases it silently. Alerts never carry another account's price and never send email.
- **Order problems name the ticket, not the outcome.** A ticket opened from an order's problem button carries the problem; offered problems depend on the order's state and kind and close 7 days after it finished. They never refund or redeliver by themselves.

## Consequences
- The customer auth tables gain the passkey table; password resets touch it in the same transaction.
- Every product has a stable public code; archived products keep theirs, and a link to a hidden game falls back to the home page.
- The worker gains one scheduled job; the notification center gains two push-only events.
- Support reporting can count problems by kind, which feeds the "fewer than 5% where-is-my-order tickets" metric.
