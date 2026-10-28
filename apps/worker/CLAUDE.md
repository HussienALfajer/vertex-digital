# apps/worker

NestJS standalone application context (ADR 0001, 0002): a pg-boss consumer for fulfilment, supplier sync, polling and webhooks, USDT verification, reconciliation, the Telegram admin bot, email and web push. It serves no HTTP (`src/main.ts`: `createApplicationContext`).

## Layout
- `src/main.ts` imports `instrument.ts` (Sentry) first; `src/worker.module.ts` wires everything.
- `src/core/`: `config` (Zod env, `log-redact.ts`), `database` (`DATABASE` token, app role), `jobs/pg-boss.service.ts`, `alerts/` (`telegram-alerts.ts`, `scrub-breadcrumb.ts` keeps URL paths, queries and user info out of Sentry), `email/mailer.ts`.
- `src/jobs/<area>/<name>.job.ts`: one queue per file; helpers of an area sit beside its jobs (`usdt-settle.ts`, `order-calls.ts`, `reconciliation-runner.ts`, `push-texts.ts`). List the folder for the inventory.
- `src/suppliers/` (registry, `recordedCall`, fake supplier state), `src/telegram/` (Bot API client, Arabic message renderers, linked chat, webhook setup), `src/push/push-sender.ts`, `src/cli/` (development CLIs for the fake supplier and fake chain).
- Chain readers: `src/jobs/deposits/chain/` (`ChainReader`, `TronReader`, `BscReader`, `FakeReader`, `CHAIN_READERS`), with synthetic fixtures.

## Patterns to copy
- Scheduled job: `src/jobs/system/heartbeat.job.ts`.
- Outbox row locked, settled once, failures recorded and retried: `src/jobs/email/send-email.job.ts`.
- Job that reads an outside service, settles under a row lock and schedules its own next run: `src/jobs/deposits/usdt-verify.job.ts`, `usdt-scan.job.ts` (pure decision in `usdt-assess.ts`, writes in `usdt-settle.ts`).
- Job that calls a supplier and reprices: `src/jobs/suppliers/health.job.ts`.
- Batch over due rows: `src/jobs/deposits/expire.job.ts` (`FOR UPDATE SKIP LOCKED`, an audit entry per row).

## Jobs and queues
- Every queue, its schedule and its sender: the "Worker jobs" table in `docs/architecture.md`.
- Queue names are `<area>.<action>`, exported as constants next to the job; names shared with the API live in `packages/contracts` (`QUEUES`, `QUEUE_POLICIES`).
- Register in `onApplicationBootstrap` with `PgBossService.work(queue, handler)`: it creates the queue with its contracts policy and reports a failure to logs, Sentry and the alert channel before pg-boss retries. The handler gets `retryCount`. Schedule with `boss.schedule(queue, cron)` after `work`; a wall-clock cron passes `tz` (`Asia/Damascus`, as `daily-summary.job.ts`).
- `{ alert: false }` only for a job whose failure a fallback covers (`store.revalidate`): a log warning, no alert.
- Retries are set by the sender (`retryLimit`, `retryDelay`, `retryBackoff: true`); `suppliers.sync` is sent with `retryLimit: 0` (one running run per supplier).
- Every job is idempotent: running it twice leaves the same result (upsert, check-then-act inside a transaction, idempotency keys on supplier calls).
- Payloads carry ids, not records: load fresh data inside the job.
- A job whose steps are independent runs each step on its own and then fails naming the failed ones (`orders.sweep`, `SweepStepsFailed`).
- pg-boss runs as the app role (ADR 0014): `createPgBoss` from `@vertex-digital/db` never creates, migrates or reindexes; queues are unpartitioned. The owner installs pg-boss's tables with the migrations.

## Money, orders, suppliers
- Money moves only through `postJournal`, order states only through the order write path in `packages/db` (ADR 0003, 0004). The wallet debit and its job are written in one transaction.
- Suppliers are called only through `SupplierRegistry` and `recordedCall` (`src/suppliers/`, ADR 0005): every call recorded in `supplier_calls`, credentials decrypted per call with `SUPPLIER_KEYS_SECRET` and never logged, stored, put in a job payload or alert; error text through `sanitizedMessage`.
- A supplier's failure is recorded (a failed run, a call), never thrown to pg-boss; only a fault of ours fails the job.
- An unknown outcome is resolved by polling, then the admin, before any other route. The poll re-sends `sending`/`unknown` attempts with the same key; a re-send's refusal becomes `unknown` (`resend_refused`), never a failure.
- `orders.fulfil` commits the attempt (with `send_started_at`) before calling. The poll re-sends an unmarked `sending` attempt only when `chosen_by_admin`, claimed with `WHERE status = 'sending' AND send_started_at IS NULL` and committed before the call.
- Before the first send of an attempt, `quoteBeforeSend` / `applyQuotedCost` (`order-calls.ts`) quote the cost and refuse a sale below it; a re-send never quotes again (S22 PQ1–PQ3). The poll sends nothing for an attempt that closed after it was read.
- Supplier calls happen outside any transaction; the answer goes through `applyOutcome`, then `checkCharge`. Outcome transactions of fulfil and poll run through `retryOnDeadlock`; an answer that finds its attempt closed goes to `reportLateResult` (rule F5).
- Fields sent to a supplier come from the attempt's own `field_map` and `option_map`, never the current route.
- `admin_fulfil` attempts have no route and are never sent to a supplier; a manual attempt waits with its `manual_order` card.
- `suppliers.webhook`: find the attempt by key, else by `(supplier, supplier_order_id)`; two matches are `unknown_key`; no match is retried for a few minutes, since the webhook can beat the stored order id.
- A sync keeps the stored category tree on a failed or empty category read (`categories_skipped`); a windowed supplier (`offerWindow`) marks offers missing only in the categories it read (`OfferScope`).
- The fake supplier keeps its orders in its state file (`keepFakeOrder`, one change at a time) so polls and `--resolve` find them.

## Chains (USDT)
- A transfer belongs to the deposit whose exact amount it matches (rule U12): the scanner, and the verifier for a TXID pasted from another deposit's transfer, credit that owner through `exactMatchDeposit` / `creditExactMatch`, never the deposit the TXID was pasted on.
- A USDT deposit past its expiry waits, at most `USDT_EXPIRY_HOLD_MINUTES`, while its network's scanner has not read past it (`expireDueDeposits` in `packages/db`).
- Read only through `CHAIN_READERS` (ADR 0006). A `ChainReaderError` concludes nothing (rule U6): catch it, schedule the next read, alert; never throw it to pg-boss.
- Readers are pure HTTP clients: no database, no Nest, no `process.env`; every reply parsed with Zod, 10 s timeouts, no internal retry. An error never quotes a URL (keys may be in it). An official USDT `Transfer` log missing a part is a `bad_response`.

## Telegram, email, push, alerts
- The deposit card refuses Telegram approval for a frozen customer.
- Alerts: `TelegramAlerts.send(text)` (rate limited, repeats suppressed ten minutes, dropped with no linked chat or token). Ids and error messages only: never tokens, keys, receipts or personal data.
- Other bot messages go through the outbox (`queueTelegramMessage` from `@vertex-digital/db`), never straight to Telegram. `TelegramBot` (`src/telegram/bot-api.ts`) is the only holder of the token; `TELEGRAM_TRANSPORT=log` writes JSON files to `TELEGRAM_LOG_DIR`.
- Customer events: `notifyCustomer(tx, bossJobSender(boss), …)` from `@vertex-digital/db` (notification, email, live event at commit).
- Email: `core/email/mailer.ts`, SMTP or `.eml` files under `EMAIL_LOG_DIR` with `EMAIL_TRANSPORT=log` (the default outside production). Templates in `jobs/email/email-templates.ts`.
- Push: `PushSender` is the only holder of the VAPID private key (10 s, no redirects); `PUSH_TRANSPORT=log` writes JSON Lines to `PUSH_LOG_DIR`. Merchant emails and pushes carry no admin text and never name a price list; product alert pushes carry no price.
- Files: the API's stored files are read-only (`FILES_ROOT`; a relative path resolves from `apps/api`). The worker never writes there.
- Logs through the Nest logger, never `console.log`; logs redact `codes`; never log a query's parameters.

## Tests
- `test/` runs on `TEST_WORKERS` Vitest workers, each on its own test database (`test/global-setup.ts`) with its own fake supplier state, `TELEGRAM_LOG_DIR`, `EMAIL_LOG_DIR` and `FILES_ROOT` (`test/worker-env.ts`).
- `isolate: false`: modules persist across files in a worker. `test/worker-env.ts` restores `process.env` and every `vi.spyOn` after each file. No `vi.mock` (refused by `apps/api/test/architecture.test.ts`): spy on a method.
- Nothing calls Telegram, a supplier, a chain or the store: a local fake Bot API, the in-process fake supplier or scripted adapters, chain readers with a scripted `fetch` and the fixtures, the memory fake chain with pg-boss stubbed, a local server for the store's revalidate route.
- Tests run inside rolled-back transactions; rows shared by a worker database (the live Telegram link, bot state, settings, the `fake` supplier's offers and routes) are moved aside inside the test's transaction. Use fixed 2030 instants where time-windowed rows could collide.
- `test/worker.test.ts` boots the module with jobs that call suppliers, chains or the store, or move orders and deposits, replaced by idle values: add a new such job to `IDLE_JOBS`.
- Setup guards fail a file that sends a query on a busy pg client (`test/no-concurrent-queries.ts`: reads in a transaction go through `readAll`, `packages/db/CLAUDE.md`) or reads through the pool inside a transaction of the same flow (`test/no-pool-reads-in-transactions.ts`).
- Vitest emits decorator metadata through oxc (`vitest.config.ts`); each app's pool opens at most 4 connections (`DATABASE_POOL_MAX`).

## Checks
`pnpm verify apps/worker/test/<area>.test.ts` (paths from the repo root, e.g. `pnpm verify apps/worker/test/orders.test.ts`; `--grep <title>` for part of a file). Before the PR, `pnpm verify` once (`docs/testing.md`).
