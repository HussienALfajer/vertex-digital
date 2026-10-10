# 0026 — Customers: freeze, per-customer limits, archive; support tickets

Status: Accepted · Date: 2026-10-10 · Amends [0006](0006-payments-and-deposits.md) (per-customer deposit limits), [0019](0019-telegram-bot-switches-notifications.md) (no Telegram approval for frozen customers), [0023](0023-reservations-and-player-validation.md) (reservations under a purchase cap)

## Context
F19 asks for freezing, per-customer limits and customer administration; F23 for support tickets; Q14 for the support channels besides tickets. S08 chose no purchase amount cap, S03 and S04 set deposit limits per tier only, and S01 left archiving to F19. The owner settled these in the S12 interview (2026-10-10).

## Decision
- **Freeze:** blocks new deposits, orders, checkouts, reservations and player checks; the balance is kept and everything else works (sign-in, reads, delivered codes, receipts for deposits created before the freeze, tickets). Reservations are cancelled at the freeze. Money already moving continues (ADR 0004); a frozen customer's Sham Cash deposit is approved in the panel only. The customer sees a generic banner, never the reason, and gets no notification of the freeze.
- **Limits:** per customer, optional overrides of the per-deposit and daily deposit limits (replacing the tier's values; the minimum stays) and an optional daily purchase cap over 24 rolling hours. There is no store-wide purchase cap.
- **Archive:** only with a zero balance and no open orders or deposits; signs the customer out, closes open tickets, keeps the email reserved; reversible.
- **Admin data edits:** none; the customer edits their own profile. The admin can sign a customer out everywhere.
- **Signals:** shared phone and shared sign-in IP (30 days), shown on the profile and the deposit page, never acted on automatically. A sign-in log is kept 90 days.
- **Notes:** an append-only list per customer, archivable, one pinned note shown wherever the admin meets the customer.
- **Tickets:** a required type (order, deposit, account, other) with a link to the customer's own order or deposit for the first two; `open` → `answered` → `closed`, auto-closed 7 days after the admin's last reply, reopened by the customer within 7 days of closing; images only (3 per message, 5 MB, re-encoded); 3 open tickets, 5 a day, 20 messages an hour, one open ticket per order or deposit. The admin can open a ticket to a customer and replies in the panel only; Telegram tells the admin of new tickets and replies without their content. The customer gets a notification and an email per reply (grouped per 10 minutes).
- **Support channels (Q14):** tickets plus one Telegram link set in the panel, hidden when empty.

## Consequences
- Every purchase and deposit creation path reads the customer row in its transaction, so a freeze and a purchase are serialized; the purchase cap is checked in the same place.
- The admin can contain fraud without touching money, and archive only accounts that owe and are owed nothing.
- Ticket conversations are records: messages are never edited or deleted.
- Shared-IP signals are noisy on Syrian networks; they inform, they do not decide.
