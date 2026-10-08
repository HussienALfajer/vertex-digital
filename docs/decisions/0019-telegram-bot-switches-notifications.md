# 0019 — Telegram admin bot, store switches and customer notifications

Status: Accepted · Date: 2026-10-08 · Amends [0002](0002-stack-per-app.md), [0006](0006-payments-and-deposits.md)

## Context
The S05 spec (F07, F26, F27) settled with the owner how the admin bot, the store switches and the customer notifications work (Q11 and the S05 interview). Several answers shape the system beyond one module:
- where Telegram updates are handled;
- what a Telegram account may do with money;
- what a stop actually stops;
- how both the API and the worker write customer notifications.

## Decision
- **One private chat.** The owner creates the bot with BotFather. Cards, alerts, reminders and the daily summary all go to the admin's private chat, linked from the panel with a single-use deep link after re-authentication. The separate alerts chat variable is removed.
- **Updates by webhook to the API.** Telegram posts updates to `POST /api/webhooks/telegram`, checked by the secret token header, Telegram's IP ranges in nginx, and the linked user and chat. The API runs bot actions through the same services as the panel (ADR 0006: one service path, the channel recorded) and never calls Telegram itself. The worker holds the bot token and sends every message from an outbox (`telegram_messages`). Long polling in the worker was rejected: the decision services live in the API, and duplicating them in the worker would break the one-path rule.
- **What Telegram may decide** (amends 0006):
  - Approve a Sham Cash deposit only when it has no flag and its credit is at most a panel setting: $100 by default, never above $100 (the panel's re-authentication threshold, S03 rule RV4), 0 turns it off. Approval asks for the transaction number and a confirmation, and assumes the declared amount and a matching reference. Anything else is a panel decision.
  - Reject any deposit in review with a listed reason and an internal note.
  - Never approve a USDT review.
  - Turn the emergency stop **on** (purchases, deposits or both). Turning it off, and every other switch, is panel-only with re-authentication.
- **Switches are a pause layer.** The store switches (registration, emergency stop for purchases and deposits, a pause per deposit method; per supplier from S07) are append-only change rows; the newest per switch is in force, read per request. The deposit settings keep saying what is configured; a method is offered when it is configured and not paused or stopped. Registration is a switch, closed by default, replacing the `REGISTRATION_OPEN` variable.
- **A stop blocks creation, never existing money.** A deposit stop refuses new deposits only; receipts, TXIDs, automatic USDT credits and reviews of existing deposits continue. A purchase stop refuses new purchases and holds automatic payment of waiting orders (S08); paid orders keep being fulfilled or refunded (ADR 0004). Creation and the switch change serialize on an advisory lock (shared and exclusive), so nothing is created after a stop commits.
- **One notification write path.** `notifyCustomer` in `packages/db` writes the in-site notification, queues the email unless the customer turned that event off, and signals the API with `pg_notify`, all in the caller's transaction. It is used by the API and the worker. The API streams notifications to the store over SSE from one `LISTEN` connection (amends 0002's realtime line to name the channel).

## Consequences
- A stolen Telegram account can approve at most unflagged Sham Cash deposits up to $100 each, with a transaction number it must invent, and can only stop the store, never reopen it. Every action is audited with the `telegram` channel and shows on the card and in the daily summary.
- The API gains a public webhook route on the store host. It is protected by the secret, the IP allowlist and the sender check.
- Local development needs no real bot: a `log` transport writes messages to files, and a CLI posts fake updates to the local webhook.
- Later specs add their notification events (orders, tickets) and alerts (suppliers) without new channels.
