# TASKS — S05 Alerts and control

Spec: `docs/specs/S05-alerts-and-control.md` (F07, F26, F27; ADRs 0002, 0003, 0004, 0006, 0008, 0011, 0014, 0016, 0017, 0018, 0019). Four PRs (owner, 2026-10-08); each leaves `main` green, ships its own screens and runs in its own session.

Why four and not the spec's three: the spec's Telegram PR is too large for one reviewed session, so it splits into the bot foundation (link, commands, messages, alerts) and the deposit decisions with their jobs; the Telegram approval money path then ships alone with its concurrency tests. Until PR 3 ships, switch changes write no Telegram message (spec, implementation notes).

## PR 1 — F26 store switches, end to end · Opus 5.5 `high`
- [x] Contracts: `settings.ts` (`STORE_SWITCHES`, `STORE_SWITCH_DEFAULTS`, `storeStatusSchema` derivation, `adminSwitchesSchema`, `changeSwitchSchema`, `switchChangeSchema` and its page, method state of SW6); error `DEPOSITS_STOPPED` (store and admin catalogs); audit action `store_switch.changed`, entity `store_switch` with admin labels; options `state` on both deposit methods; unit tests (100%)
- [x] Db (`/db-migration`): `store_switch_changes` (enums `store_switch`, `switch_channel`; index; append-only trigger and grants, `APPEND_ONLY_TABLES`; `TABLE_OWNERS`; `created_at` stamped at insert); tests (the switches are read through `SettingsService`, the module that owns the table)
- [x] Api `settings` module: `GET /api/store/status` (public, `max-age=10`), `GET/POST /api/admin/switches` (re-authentication), `GET /api/admin/switches/history`; SW2 lock, no-op on same value, audit; `test/settings.test.ts` (every route, re-authentication, parallel changes serialized)
- [x] Api `deposits`: SW5 shared lock and switch read in Sham Cash and USDT creation, `DEPOSITS_STOPPED`; options `state` (SW6); existing deposits unaffected (SW4); race test (creation vs stop)
- [x] Api `auth`: registration reads the switch (SW8); `REGISTRATION_OPEN` removed from api env, `.env.example`, vitest config and tests (fixtures open the switch)
- [x] Bridge: build, OpenAPI export, admin client
- [x] Store: stop banner (SW9) on every page, deposit method states and the stopped wizard, `DEPOSITS_STOPPED` keeps the form; i18n
- [x] Admin: `/settings/switches` (toggles, confirm dialog, re-authentication, history with filter), navigation entry, global banner (SW10); i18n
- [x] E2E: store banner and disabled wizard (phone, dark and light); admin switches page, confirm dialog, banner (light and dark)
- [x] Wiring checklist, docs (`docs/architecture.md` `settings` module, `docs/deployment.md`, folder `CLAUDE.md`; no command changed; no nginx change: `/api/store/status` is a read under the general zone)
- [x] Checks (lint, typecheck, test, build, e2e, drift: all passed and recorded), reviewer (no blocking findings), owner acceptance (2026-10-08), PR with auto-merge

## PR 2 — F27 notifications, end to end · Opus 5.5 `high`
- [x] Contracts: `NOTIFICATION_EVENTS`, `NOTIFICATION_PARAMS`, `customerNotificationSchema`, `notificationPageSchema`, `notificationPreferencesSchema`, `NOTIFICATION_EMAIL_TEMPLATE`; audit `customer.notification_preference_changed`; unit tests
- [x] Db (`/db-migration`): `customer_notifications` (indexes, `read_at`-only column grant and trigger), `notification_preferences`; `notifyCustomer` in `packages/db/src/notifications` (row, preference-aware email, `pg_notify` on commit); tests (rollback leaves nothing)
- [x] NT2 call sites moved to `notifyCustomer`: S03 approval, rejection and receipt request, S04 credits and rejections (api and worker), S02 adjustments and reversals
- [x] Api: `GET /api/notifications`, `POST /api/notifications/read`, `GET /api/notifications/stream` (LISTEN fan-out, heartbeat, 3 streams, 30 per minute, session re-check, `resync`), preference routes; `no-store`; tests (other customer, stream routing, 4th stream, revoked session)
- [x] nginx: stream location (buffering off, long timeout)
- [x] Bridge
- [x] Store: header bell with live count (`EventSource`, `visibilitychange` refetch), `/notifications` (list, load more, mark read, empty, loading, error), `/account` email preferences, live refresh of `/wallet` and `/wallet/deposits/<id>` (NT7); i18n
- [x] E2E: bell with badge, `/notifications` list and empty, preferences (phone width, dark and light)
- [x] Wiring checklist, docs (`docs/architecture.md`, folder `CLAUDE.md`, `wiring.md` SSE pattern)
- [x] Reviewer: two blocking findings fixed (nginx duplicate `proxy_read_timeout`; the store stream reopens after a non-200 answer), plus the stream's early-close and `LISTEN` failure cleanup and the first-preference race (test)
- [x] Found by the full run: a new customer's wallet created by two writes at once could meet the `customer_id` unique index outside `ON CONFLICT (code)` and answer 500 (S02 `ensureAccount`); fixed with a test that reproduces it
- [x] Found by the full run: `deposits-usdt.test.ts` seeded 95 reference codes per run from about 15 symbols, and the kept test rows made collisions likely; it now draws free codes from the API's alphabet
- [ ] Checks (full run on the final tree), owner acceptance, PR with auto-merge

## PR 3 — F07 Telegram bot foundation and its admin page · Opus 5.5 `high`
- [ ] Contracts: `telegram.ts` (message kinds and params, link status and code schemas, `TELEGRAM_CALLBACKS` parsing within 64 bytes), error `TELEGRAM_NOT_CONFIGURED`, audit actions `telegram.*`, queue `telegram.send`; unit tests
- [ ] Db (`/db-migration`): `telegram_links`, `telegram_link_codes`, `telegram_messages`, `telegram_updates`, `telegram_prompts`, `telegram_bot_state`; indexes (one live link, one open prompt); tests
- [ ] Env: api `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`; worker `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_TRANSPORT`; `TELEGRAM_ALERTS_CHAT_ID` removed; `.env.example`
- [ ] Api `telegram` module: link status, link code, unlink, test message; `POST /api/webhooks/telegram` (constant-time secret, strict update schema, 64 KB, `update_id` dedupe, TG4 sender check, `/start <code>`, `/status`, `/stop` with confirm (on only), `/help`, prompts TG7); switch changes insert `switch_changed` (SW2, AL2); tests
- [ ] Worker: `telegram.send` (log transport to `.data/telegram/`, 429 `retry_after`, 403 no retry, skipped without a link, safe twice), `setWebhook` at start, `TelegramAlerts` to the linked chat (cached 60 s)
- [ ] CLI `telegram:fake-update`; commands table in `AGENTS.md`
- [ ] nginx: webhook location limited to Telegram ranges, 64 KB; `docs/deployment.md` (bot creation, webhook)
- [ ] Bridge
- [ ] Admin: `/settings/telegram` (not configured; not linked with deep link, QR, countdown and polling; linked with test and unlink), navigation; i18n
- [ ] E2E: `/settings/telegram` in its three states (light and dark)
- [ ] Wiring checklist, docs (`docs/architecture.md`, folder `CLAUDE.md`)
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge

## PR 4 — F07 deposit cards, decisions, reminder, summary · Opus 5.5 `high`
- [ ] Contracts: queues `telegram.deposit-card`, `telegram.review-reminder`, `telegram.daily-summary`; reminder due computation; settings `telegramApprovalMaxUsdUnits`; unit tests
- [ ] Db (`/db-migration`): `telegram_deposit_cards`; `deposit_settings.telegram_approval_max_usd_units` with its check; tests
- [ ] Api: deposits queue `telegram.deposit-card` on submission, review, decisions, expiry, cancellation, receipt request (TC1, TC6); approve from Telegram through the S03 service (TC4, channel `telegram`, `telegram:<promptId>`, re-checks); reject (TC5) for Sham Cash and USDT; deposit settings field; tests (Telegram confirm vs panel approval → one journal, audit, notification, email; same prompt twice → one credit; flagged, over limit, limit 0, changed submission, USDT refused)
- [ ] Worker: `telegram.deposit-card` (send, edit, new card per submission, JPEG receipt), `usdt_unmatched` from the scanner (TC7), `telegram.review-reminder` (RM1–RM4, cleanup of updates and prompts), `telegram.daily-summary` (AL3); tests with fixed instants
- [ ] Bridge
- [ ] Admin: `/settings/deposits` Telegram limit field; "من تيليجرام" on deposit decisions; i18n; E2E (light and dark)
- [ ] Wiring checklist, `wiring.md` patterns, docs (`docs/architecture.md`), `docs/ROADMAP.md` S05 done
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge
