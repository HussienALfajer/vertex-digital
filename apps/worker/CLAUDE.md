# apps/worker

NestJS standalone context for background work (ADR 0001, 0002): pg-boss queues and schedules; later fulfilment, supplier sync and polling, webhook processing, USDT verification, the Telegram admin bot and email. It never serves HTTP.

## Layout
- `src/main.ts` (imports `instrument.ts` first: Sentry), `src/worker.module.ts`.
- `src/core/`: `config` (Zod env), `database` (`DATABASE` token, app role), `jobs/pg-boss.service.ts`, `alerts/telegram-alerts.ts`, `alerts/scrub-breadcrumb.ts` (keeps the bot token out of Sentry).
- `src/jobs/<area>/<name>.job.ts`: one queue per file. Pattern to copy: `src/jobs/system/heartbeat.job.ts`. The Telegram bot (F07) goes under `src/telegram/`.

## Rules
- Queue names are `<area>.<action>` (`system.heartbeat`), exported as constants next to the job; names shared with the API go in `packages/contracts`.
- Register a job in `onApplicationBootstrap` with `PgBossService.work(queue, handler)`, which creates the queue and reports a failure to the logs, Sentry and the alert channel before pg-boss retries it. Schedules: `boss.schedule(queue, cron)` after `work`.
- Every job is idempotent: pg-boss retries, so running it twice leaves the same result (upsert, check-then-act inside a transaction, idempotency keys on supplier calls).
- Payloads carry ids, not records: load fresh data inside the job.
- pg-boss runs as the app role (ADR 0014): `createPgBoss` from `@vertex-digital/db` never creates or migrates tables and never rebuilds indexes. Queues are unpartitioned (rows only). pg-boss's tables are installed by the owner with the migrations.
- Money moves only through `postJournal`, order states only through the order write path in `packages/db` (ADR 0003, 0004). Supplier calls go through `packages/suppliers`; a call with an unknown outcome is resolved by polling, then staff, before any other route (ADR 0005).
- Alerts: `TelegramAlerts.send(text)` (rate limited, repeats suppressed for ten minutes, off without `TELEGRAM_BOT_TOKEN`). Never put tokens, keys, receipts or personal data in an alert; ids and error messages only.
- Logs through the Nest logger, never `console.log`.

## Tests
`test/` against the test database with a unique `WORKER_NAME` per run; the Telegram channel against a local fake Bot API. Nothing calls Telegram, a supplier or a chain in tests. Vitest emits decorator metadata through oxc (`vitest.config.ts`).

Run: `pnpm --filter @vertex-digital/worker test` · `pnpm --filter @vertex-digital/worker typecheck`.
