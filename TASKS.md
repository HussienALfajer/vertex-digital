# TASKS — S05 Alerts and control

Spec: `docs/specs/S05-alerts-and-control.md` (F07, F26, F27; ADRs 0002, 0003, 0004, 0006, 0008, 0011, 0014, 0016, 0017, 0018, 0019). Six PRs; each leaves `main` green and runs in its own session.

Why six and not the spec's three: the spec's PR 2 (notifications) and PR 3 (Telegram) are each too large for one reviewed session. Notifications split into the server side and the store screens; Telegram splits into the bot foundation, the deposit decisions and jobs, and the admin screens. Until PR 4 ships, switch changes write no Telegram message (spec, implementation notes); until PR 3 ships, notifications are recorded and emailed but not shown in the store.

## PR 1 — F26 store switches, end to end · Opus 5.5 `high`
- [ ] Contracts: `switches.ts` (`STORE_SWITCHES`, `STORE_SWITCH_DEFAULTS`, `storeStatusSchema` derivation, `adminSwitchesSchema`, `changeSwitchSchema`, `switchChangeSchema` and its page, method state of SW6); error `DEPOSITS_STOPPED` (store and admin catalogs); audit action `store_switch.changed`, entity `store_switch` with admin labels; options `state` on both deposit methods; unit tests (100%)
- [ ] Db (`/db-migration`): `store_switch_changes` (enums `store_switch`, `switch_channel`; index; append-only trigger and grants, `APPEND_ONLY_TABLES`; `TABLE_OWNERS`); a shared switch read helper; tests
- [ ] Api `settings` module: `GET /api/store/status` (public, `max-age=10`), `GET/POST /api/admin/switches` (re-authentication), `GET /api/admin/switches/history`; SW2 lock, no-op on same value, audit; `test/settings.test.ts` (every route, re-authentication, parallel changes serialized)
- [ ] Api `deposits`: SW5 shared lock and switch read in Sham Cash and USDT creation, `DEPOSITS_STOPPED`; options `state` (SW6); existing deposits unaffected (SW4); race test (creation vs stop)
- [ ] Api `auth`: registration reads the switch (SW8); `REGISTRATION_OPEN` removed from api env, `.env.example`, vitest config and tests (fixtures open the switch)
- [ ] Bridge: build, OpenAPI export, admin client
- [ ] Store: stop banner (SW9) on every page, deposit method states and the stopped wizard, `DEPOSITS_STOPPED` keeps the form; i18n
- [ ] Admin: `/settings/switches` (toggles, confirm dialog, re-authentication, history with filter), navigation entry, global banner (SW10); i18n
- [ ] E2E: store banner and disabled wizard (phone, dark and light); admin switches page, confirm dialog, banner (light and dark)
- [ ] Wiring checklist, docs (`docs/architecture.md` `settings` module, folder `CLAUDE.md`, `AGENTS.md` if a command changes)
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge

## PR 2 — F27 notifications, server side · Opus 5.5 `high`
- [ ] Contracts: `NOTIFICATION_EVENTS`, `NOTIFICATION_PARAMS`, `customerNotificationSchema`, `notificationPageSchema`, `notificationPreferencesSchema`, `NOTIFICATION_EMAIL_TEMPLATE`; audit `customer.notification_preference_changed`; unit tests
- [ ] Db (`/db-migration`): `customer_notifications` (indexes, `read_at`-only column grant and trigger), `notification_preferences`; `notifyCustomer` in `packages/db/src/notifications` (row, preference-aware email, `pg_notify` on commit); tests (rollback leaves nothing)
- [ ] NT2 call sites moved to `notifyCustomer`: S03 approval and rejection and receipt request, S04 credits and rejections (api and worker), S02 adjustments and reversals
- [ ] Api: `GET /api/notifications`, `POST /api/notifications/read`, `GET /api/notifications/stream` (LISTEN fan-out, heartbeat, 3 streams, 30 per minute, session re-check, `resync`), preference routes; `no-store`; tests (other customer, stream routing, 4th stream, revoked session)
- [ ] nginx: stream location (buffering off, long timeout)
- [ ] Bridge; docs (`docs/architecture.md`, folder `CLAUDE.md`)
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge

## PR 3 — F27 store screens · Opus 5.5 `medium`
- [ ] Store: header bell with live count (`EventSource`, `visibilitychange` refetch), `/notifications` (list, load more, mark read, empty, loading, error), `/account` email preferences, live refresh of `/wallet` and `/wallet/deposits/<id>` (NT7); i18n
- [ ] E2E: bell with badge, `/notifications` list and empty, preferences (phone width, dark and light)
- [ ] Wiring checklist, `wiring.md` patterns (SSE client)
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge

## PR 4 — F07 Telegram bot foundation · Opus 5.5 `high`
- [ ] Contracts: `telegram.ts` (message kinds and params, link status and code schemas, `TELEGRAM_CALLBACKS` parsing within 64 bytes), error `TELEGRAM_NOT_CONFIGURED`, audit actions `telegram.*`, queue `telegram.send`; unit tests
- [ ] Db (`/db-migration`): `telegram_links`, `telegram_link_codes`, `telegram_messages`, `telegram_updates`, `telegram_prompts`, `telegram_bot_state`; indexes (one live link, one open prompt); tests
- [ ] Env: api `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`; worker `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_TRANSPORT`; `TELEGRAM_ALERTS_CHAT_ID` removed; `.env.example`
- [ ] Api `telegram` module: link status, link code, unlink, test message; `POST /api/webhooks/telegram` (constant-time secret, strict update schema, 64 KB, `update_id` dedupe, TG4 sender check, `/start <code>`, `/status`, `/stop` with confirm (on only), `/help`, prompts TG7); switch changes insert `switch_changed` (SW2, AL2); tests
- [ ] Worker: `telegram.send` (log transport to `.data/telegram/`, 429 `retry_after`, 403 no retry, skipped without a link, safe twice), `setWebhook` at start, `TelegramAlerts` to the linked chat (cached 60 s)
- [ ] CLI `telegram:fake-update`; commands table in `AGENTS.md`
- [ ] nginx: webhook location limited to Telegram ranges, 64 KB; `docs/deployment.md` (bot creation, webhook)
- [ ] Bridge; docs (`docs/architecture.md`, folder `CLAUDE.md`)
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge

## PR 5 — F07 deposit cards, decisions, reminder, summary · Opus 5.5 `high`
- [ ] Contracts: queues `telegram.deposit-card`, `telegram.review-reminder`, `telegram.daily-summary`; reminder due computation; settings `telegramApprovalMaxUsdUnits`; unit tests
- [ ] Db (`/db-migration`): `telegram_deposit_cards`; `deposit_settings.telegram_approval_max_usd_units` with its check; tests
- [ ] Api: deposits queue `telegram.deposit-card` on submission, review, decisions, expiry, cancellation, receipt request (TC1, TC6); approve from Telegram through the S03 service (TC4, channel `telegram`, `telegram:<promptId>`, re-checks); reject (TC5) for Sham Cash and USDT; deposit settings field; tests (Telegram confirm vs panel approval → one journal, audit, notification, email; same prompt twice → one credit; flagged, over limit, limit 0, changed submission, USDT refused)
- [ ] Worker: `telegram.deposit-card` (send, edit, new card per submission, JPEG receipt), `usdt_unmatched` from the scanner (TC7), `telegram.review-reminder` (RM1–RM4, cleanup of updates and prompts), `telegram.daily-summary` (AL3); tests with fixed instants
- [ ] Docs (`docs/architecture.md`)
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge

## PR 6 — F07 admin screens · Opus 5.5 `medium`
- [ ] Admin: `/settings/telegram` (not configured, not linked with deep link, QR and countdown and polling, linked with test and unlink), navigation; `/settings/deposits` Telegram limit field; "من تيليجرام" on deposit decisions; i18n
- [ ] E2E: `/settings/telegram` in its three states, deposit settings (light and dark)
- [ ] Wiring checklist, `wiring.md` patterns, `docs/ROADMAP.md` S05 done
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge
