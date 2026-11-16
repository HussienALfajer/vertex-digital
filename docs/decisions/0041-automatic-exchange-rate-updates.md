# 0041 — Automatic exchange-rate updates

Status: Accepted · Date: 2026-11-16 · Amends [0017](0017-sham-cash-deposits-and-exchange-rate.md), [0019](0019-telegram-bot-switches-notifications.md)

## Context
ADR 0017 set one SYP-per-USD rate for display and deposits, typed by the admin. The Syrian parallel market moves daily, so the rate goes stale between edits. On 2026-11-16 the owner asked for the rate to update from external sources (S27). The owner also considered per-city rates and declined them: the store keeps one rate for every account and city. Automatic changes touch the conversion of every SYP deposit, so the guarantees of 0003 and 0017 must hold under them.

## Decision
- **Still one rate** for display and SYP deposits (0017), now set by the admin **or** by the automatic path below. Each `exchange_rates` row records its origin (`admin`, `auto`, `suggestion`); an automatic row has no admin.
- **Sources:** public Telegram channels read through their `t.me/s/` web preview and, once permitted, the "الليرة اليوم" site; configured in the panel. The figure used is the dollar's sell price. No WhatsApp, no user-account Telegram client, no bot in other people's groups.
- **Apply alone only when safe:** automatic updates on, at least two fresh sources agreeing within 1%, a move of at most 2%, and at most 2% from the rate of 24 hours ago. Every other move becomes a suggestion that proposes the highest figure.
- **Who approves a suggestion** (amends 0019): Telegram may approve a source-made suggestion of at most 5% from the rate at the moment of approval, and reject any; above 5% only the panel, with re-authentication and the typed confirmation of 0017. Telegram may turn automatic updates off, never on.
- **Silent sources never block:** the last rate stays, the owner is alerted after 6 hours, and the 48-hour banner of 0017 stays.

## Consequences
- Unchanged money guarantees: a deposit stores the rate row it used, the 15-minute lock and the fixed rate after the first valid submission apply as before, and conversion still floors to whole cents. No new journal or account, and no reader of the current rate changes.
- A hacked source alone cannot move the rate; two agreeing sources can move it at most 2% per 24 hours, each move audited and announced.
- The store depends on public pages that can change shape or vanish; parsers fail into alerts, never into wrong rates (a ±20% range check).
