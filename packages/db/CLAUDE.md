# packages/db

Drizzle schema, migrations, the database client and the shared write paths for money, orders and other cross-module records (ADR 0002, 0003, 0004, 0011, 0014). Schema changes follow the `db-migration` skill. Conventions already in AGENTS.md and ADR 0011 are not repeated here.

## Layout and patterns to copy
- `src/schema/<module>.ts`: one file per owning API module, re-exported from `src/schema/index.ts`. A table referencing two modules' tables gets its own file (`quick-links.ts`, `price-lists.ts`). Better Auth tables (`auth.ts`, `admin.ts`) keep the property names Better Auth expects; `admin.ts` holds at most one admin row.
- `src/schema/columns.ts`: `id()`, `timestamps()` (`updated_at` set from the database's `now()` on update), `archivedAt()`, `amountUnits()`, `currencyEnum`, `bytea` (SHA-256 digests). Enums reuse the `as const` lists of `@vertex-digital/contracts`.
- `src/<area>/` (`ledger`, `orders`, `pricing`, `suppliers`, `customers`, `merchants`, `merchant-tools`, `treasury`, `reconciliation`, `reports`, `content`, `support`, `notifications`, `telegram`, `store`, `product-alerts`, `quick-links`, `audit`): write paths and reads shared by the API and the worker. Each has an `index.ts`; list the folder for its files.
- Errors carrying a contract code sit beside their write path: `LedgerError`, `OrderError` (`orders/errors.ts`), `CustomerError`, `TreasuryError`, `ProductAlertError`.
- Patterns: money write path `src/ledger/post-journal.ts`; order write path `src/orders/transition.ts` and `src/orders/purchase.ts`; outbox writer `src/telegram/queue-telegram-message.ts`; guard migrations `migrations/0031_s08_orders_guards.sql` (append-only trigger, row guard, grants) and `migrations/0001_ledger_guards.sql` (revokes).
- `src/client.ts`: `createDatabase`, the `Executor` type, `readAll`, `APP_POOL_LIMITS`. `src/jobs.ts`: `PG_BOSS_SCHEMA`, `createPgBoss` (app role: no schema changes, no index rebuilds), `transactionExecutor(tx)`.
- `src/errors.ts`: `withoutQueryParameters(error)`: log and report a failed query by its cause, never with the parameters Drizzle puts in its message.
- `src/migrate.ts` (`runMigrations`) and `src/cli/migrate.ts`: Drizzle migrations, then pg-boss's tables, as the owner role under an advisory lock; used by `pnpm db:migrate`, deploys (`node packages/db/dist/cli/migrate.js`) and the tests' global setup. The `pgboss` schema is created by `scripts/setup-local-db.mjs` and the production provisioning.
- `src/testing.ts` (`@vertex-digital/db/testing`): test database URLs, per-worker databases (`TEST_WORKERS` from `src/test-workers.ts`, `workerDatabases`, `createMissingDatabases`, `prepareTestDatabase`), `holdTestDatabases`, the Vitest global setup, the query-guard recorders.
- `src/database-access.ts`: the app role's access to a database, shared with `scripts/setup-local-db.mjs`.
- `migrations/`: generated `<nnnn>_<name>.sql` and hand-written `<nnnn>_<spec>_<topic>.sql` (usually `_guards` or `_seeds`; older files vary). `migrations/meta/` is drizzle-kit state: never read or edit it.

## Roles (ADR 0014)
- Owner role (`DATABASE_OWNER_URL`): owns every table, runs migrations. No app process uses it.
- App role (`DATABASE_URL`): the API, worker and tests. Owns nothing; default privileges give `SELECT, INSERT, UPDATE, DELETE` on new tables, and guard migrations take back what a table must not allow.
- A migration never names the app role: revoke from `PUBLIC` and every non-owner grantee, as `0001_ledger_guards.sql` does.
- The app role cannot create temporary tables, disable triggers or grant itself privileges. Neither role may be a superuser.

## The ledger (ADR 0003)
- Write money only with `postJournal(tx, { idempotencyKey, kind, postings })`, the only writer of journals and postings, inside the transaction that also writes the business change, its audit entry and its job. It runs in a savepoint: a refusal leaves the caller's transaction usable.
- Transactions stay READ COMMITTED: `postJournal` refuses to debit a wallet under another isolation level.
- A journal declares `posting_count`; the commit check refuses any other number, so nothing is added later. Journals balance per currency at commit. The database stamps `created_at`.
- A balance is `accountBalance`, the sum of postings. `position` (identity) is the write order, assigned after `postJournal` locks every wallet the journal touches (credits too).
- Timelines, running balances and statement months follow `position`, never `created_at` (that is the transaction's start).
- Customer wallets: USD, whole cents, never below zero, never above `Number.MAX_SAFE_INTEGER` units. System accounts may go negative and keep sub-cent precision.
- A posting's currency is its account's; an account's id, code, kind, currency and customer never change; a customer is named on, and only on, a customer wallet.
- Accounts are created on first posting inside its transaction (`ensureCustomerWallet`, `ensureSystemAccount`). Lock the wallet with `lockCustomerWallet` before claiming a payment reference.
- `LedgerError` carries a contract code (`INSUFFICIENT_BALANCE`, `IDEMPOTENCY_KEY_REUSED`) for the API; any other `Error` is a bug.
- Corrections are new reversing journals. Never update or delete a ledger row or grant the app role privileges on it.
- A customer with a wallet can never be deleted (archive it). The admin is referenced without a foreign key (`audit_entries.actor_id`, `wallet_adjustments.admin_id`) so the single admin row stays replaceable.
- Journal keys: `deposit:<id>`, `checkout:<id>:purchase`, `treasury:<id>`; one refund journal per order.
- A USDT credit gives the wallet whole cents and `deposit_rounding:USD` the rest of the exact amount received. Cost of goods posts `cost_of_goods` −cost and `supplier_prepaid` +cost, none at zero cost (ADR 0027).

## Single writers (the only way to write these)
- Audit entries: `recordAudit(tx, entry)`, in the transaction of the change; details are checked against the action's contract shape.
- `payment_references`: `claimPaymentReference`. One claim per method and normalized reference (trimmed, upper-cased, printable ASCII); a second claim is refused with `EXTERNAL_REFERENCE_TAKEN` naming the holder.
- A USDT TXID is one claim across both networks and is looked up with and without `0X`. A claim and an `unclaimed_receipt` treasury movement take the same `lockPaymentReference` lock, and neither takes a reference the other holds.
- USDT deposit credit: `creditUsdtDeposit` (deposit lock, wallet lock, TXID claim, journal, updates, audit), shared by the worker and the admin; the caller queues the email.
- Deposit expiry: `expireDueDeposits` (`SKIP LOCKED`). The job's path holds a USDT deposit past expiry while its network's scanner has not read past it, at most `USDT_EXPIRY_HOLD_MINUTES`; the customer's path expires by the clock.
- Orders change only through `src/orders/`. `transitionOrder` updates `WHERE status = <from>` and returns null on a lost race; on a terminal status it calls `orderFinished` (a checkout order's terminal transition needs the job sender).
- `applyOutcome` locks the order then the attempt `FOR UPDATE` and keeps a reported charge once.
- `refundRemaining` writes one refund journal per order; an owner-funded order's refund returns to `owner_drawings` and its customer is told without an amount. Walk-in orders (no customer) send no notification.
- Line checks: `prepareLine`, shared by `purchaseOrder`, the checkout and admin on-behalf orders.
- Order codes are encrypted with `ORDER_CODES_SECRET` (AES-256-GCM, the row id as associated data, `orders/secrets.ts`); reveals and releases write one reveal row per code.
- `customer_notifications`: `notifyCustomer(tx, jobs, { customerId, event, params })`: the row, the email unless turned off, `pg_notify` at commit, and a `push.send` job when the event has an email, the call is not center-only (`{ email: false }`) and the customer has a push device.
- Email outbox: `queueEmail(tx, jobs, email)` (`JobSender` is the API's `JobsService` or `bossJobSender(boss)`).
- `telegram_messages`: `queueTelegramMessage` (a used dedupe key writes nothing). Deposit cards: `queueDepositCard`, queued by every deposit change a card shows.
- `treasury_movements`: `recordMovement` and `reverseMovement` (key advisory lock and replay, the two places' advisory locks in id order, the opening rule T6 and the reference rule T8 of S13, one reversal).
- Merchant application status: `moveApplication` on the contracts' `applicationTransition`. Grant and revoke: `grantMerchant` / `revokeMerchant` on a customer the caller locked `FOR NO KEY UPDATE`.
- Every merchant purchase, checkout, reservation and customer-paid admin order writes its sale row with `recordMerchantSale` in its transaction, and every merchant wallet debit calls `afterMerchantPurchase`.
- Store cache: `queueStoreRevalidate(tag)`, one job per 10-second slot per tag (`catalog`, `content`). Rate limits: `withinLimits` / `countHit` on `customer_rate_limits` (ADR 0008).
- Jobs in a transaction: `boss.send(queue, data, { db: transactionExecutor(tx) })`.

## Locks and concurrency
- Copy the lock order of the write path you extend: the customer comes first, and an order comes before its attempt.
- `lockActiveCustomer` takes the customer `FOR SHARE` (refuses `ACCOUNT_FROZEN`, returns the effective price list and `merchantTermsRequired`); `requireMerchantTerms` then refuses purchases, checkouts and on-behalf orders of a merchant without accepted terms. `customers/state.ts` takes it `FOR UPDATE` first. Price-list and merchant changes take it `FOR NO KEY UPDATE` (`setCustomerPriceList` then takes the list `FOR SHARE`).
- Caps and limits are read under the wallet lock: purchase and reservation caps, the 3-reservation limit, saved players. Admin purchases lock the wallet or `owner_drawings:USD` `FOR UPDATE` while the day's owner total is summed against the cap.
- `purchaseOrder` runs under the caller's store-switches lock and takes products `FOR SHARE`; the checkout takes its key's advisory lock and products `FOR SHARE` in id order.
- `payWaitingOrders` pays each reservation in its own transaction and cancels one whose price list is no longer the customer's.
- Batch jobs settle each row in its own transaction with `FOR UPDATE SKIP LOCKED` (product alerts) or one merchant per transaction under an advisory lock (watch alerts). Once-per-period sends take an advisory lock named for the period (`statement:<customer>:<month>`).
- Multi-statement reads that must agree (reconciliation's internal checks, merchant statements) run in one `REPEATABLE READ` read-only transaction. Writes stay READ COMMITTED.
- Independent reads use `readAll(db, [() => read, …])`, never `Promise.all`, whenever `db` may be a transaction: in parallel through the pool, one after another in a transaction (a client runs one query at a time; pg 9 refuses concurrent queries on one client). Parallel work only through the pool.
- Inside a transaction every read goes through it, never through the pool (`this.db`, or a service method reading `this.db`): the pool read waits for a second connection while the transaction holds locks, and a few such requests exhaust the pool.
- Helpers a transaction calls take `db: Executor = this.db`; a decision that may run inside a caller's transaction opens its own with `db.transaction` (a savepoint there).
- The API's and worker's pools take `APP_POOL_LIMITS` (10 s connection wait, 15 s `lock_timeout`), so such a slip fails fast; CLIs and migrations keep no limit.
- Query guards fail any test file that breaks the two rules above: `src/no-concurrent-queries.setup.ts` and `src/no-pool-reads-in-transactions.setup.ts` here, `test/no-concurrent-queries.ts` and `test/no-pool-reads-in-transactions.ts` in the api and worker.
- The guards patch pg and drizzle once per process and record per test file (`concurrentQueries`, `poolReadsInTransactions` in `src/testing.ts`); the concurrent check runs on the client under the condition pg warns on.

## Pricing
- `repriceProducts` decides retail first (review rule, fixed prices via the contracts' `resolveListEntry` / `listPrice`), then `repriceListsAfterRetail` prices every other unarchived list from the same basis, capped at the retail row, appending only changed rows.
- `listPricingFacts` / `listIsPriced` / `listTarget` (`pricing/reprice.ts`) are the one computation of a list row; `priceMatrix` reuses them.
- A product under review keeps every list's price; a decided review reprices with its cause. A basis switch that moves the price beyond the threshold opens a review unless the new basis is `manual`.
- A list whose root has no live global rule is not priced. Prices are whole cents above cost; never sell below cost.
- The wholesale and cost global rules come from `seedRootListRules` (fixed ids, idempotent), run by `pricing:reprice-lists`, `db:seed-local` and `prepareTestDatabase`; no migration seeds them.
- Every insert into `margin_rules`, `product_prices` and `orders` names its `price_list_id` (no default). Orders charge and store the customer's effective list. `publicShare` never shows a non-retail order's price.
- `productRoutingStates` reads supplier delivery medians at most once a minute per process (`forgetDeliveryMeasure` drops the cache). `markOfferOutOfStock` and `recordObservedCost` reprice in the caller's transaction.

## Guarded tables
- Row guards are triggers in hand-written migrations (`<table>_guard`); before writing to a table, grep `migrations/` for its guard and grants.
- A trigger function that reads a table names it `public.<table>` and sets `search_path = public, pg_temp`, so no temporary table can stand in for it.
- Never deleted, archive instead: `orders`, `fulfilment_attempts`, `deposits`, `usdt_deposits`, `checkouts`, `order_share_links`, `price_lists`, `price_list_fixed_prices`, `supplier_categories`, `game_player_checks`, merchant levels and sales.
- The app role has no `DELETE`/`TRUNCATE` on the catalog tables, `product_routes` and `margin_rules`: code and tests archive their rows.
- `orders_guard`: a terminal order never changes; identity, customer, price, list, fields, checkout, gift, admin, region and verification code are fixed; transitions follow ADR 0004's table; units never go back; price columns change only on `awaiting_balance → paid`.
- `orders_checkout_guard`: a checkout order carries its checkout's journal and customer; a single order never takes a checkout's journal.
- `usdt_deposits_guard`: no delete; the deposit's method and amount, what was shown and the bound transfer are fixed; `deposit_open` mirrors the deposit (kept by `deposits_sync_usdt_open`).
- `fulfilment_attempts_guard`: a delivered or failed attempt never changes; one open attempt per order; a route once per order; send mark, charge and quoted cost set once; an open manual attempt takes its cost, proof and reference once.
- `deposits_guard`: no change out of a final state or off the transition table; declared fields fixed; a USDT deposit is credited only bound to the transfer of its TXID.
- Narrow updates: `customer_notifications` (only `read_at`, once), `supplier_webhook_events` (processing columns, once), `checkouts` (`finished_at`, once), sync runs (only while running), an ended reconciliation run (only its alert time), a decided `price_reviews` row (never).
- `player_checks` is a cache the app role never updates. Slugs, `catalog_products.quick_code` and a margin rule's list, scope and target never change.
- Partial unique indexes carry the "one live/open" rules (one open review per product, one open attempt per order, one live share link per kind, one enabled announcement, one running sync per supplier); keep them when changing those tables.

## Append-only tables
- A new append-only table gets, in its custom migration, the `append_only_guard` trigger and the revokes of `0001_ledger_guards.sql`; it joins `APPEND_ONLY_TABLES` in `src/conventions.test.ts` (the current list of append-only tables) and the trigger list in `src/ledger/guards.test.ts`. The trigger refuses the owner role too.
- `product_prices` and the append-only supplier tables are stamped with `clock_timestamp()` (the row's real time, not the transaction's start).
- Two retention exceptions, each through a `SECURITY DEFINER` function the app role may run and a guard that refuses everything else (migration 0103): `purge_supplier_logs` deletes `supplier_calls` and `supplier_balance_reads` past 180 days; `stored_files_mark_unreferenced` / `stored_files_sweep` set only `stored_files.unreferenced_since` and `swept_at` on catalog images, QR images and logos.

## Columns and migrations
- Money: `amountUnits('<name>_units')` next to `currencyEnum('currency')`, or a currency-fixed name (`price_usd_units`); `*_units` is `bigint`. Exchange rates: `numeric`. Amounts are JS numbers checked as safe integers; math on them lives in `@vertex-digital/contracts`.
- Idempotency keys and external references (supplier attempt ids, Sham Cash transaction numbers, `(network, txid)`) get unique constraints.
- Daily counts and reports cut days in Damascus time (`damascusDate`); reports count real customers only.
- Migrations stay backward compatible (expand, then contract): a new column on a populated table gets a default or is nullable until a later release; removing an enum value takes two releases (stop using it, then recreate the enum).
- Never edit a generated migration; hand-written SQL goes in `drizzle-kit generate --custom`; never `drizzle-kit push`. CI fails if `pnpm db:generate` produces a diff: commit the schema and its migration together.
- Drizzle applies all pending migrations in one transaction, and a value added with `ALTER TYPE ... ADD VALUE` cannot be used before commit. To use a new enum value in the same run, recreate the type on the same values (as `0069_s19_fazercards_supplier.sql` does).
- A check or unique index added to a table with rows stops the migration while an existing row violates it: backfill or clean the rows first.
- Seeded rows (suppliers, root price lists, settings, content drafts) use fixed ids so every database holds the same row; seed before columns that reference them.

## Tests
- Global setup migrates the test database as the owner (`TEST_DATABASE_OWNER_URL`); tests run as the app role (`TEST_DATABASE_URL`) and as the owner only to prove a guard refuses it.
- The api and worker suites use `TEST_WORKERS` databases each (`<test database>_<suite>_<n>`); `holdTestDatabases` makes a second run of a suite wait for the first.
- Ledger rows written by tests stay (append-only): every test uses new accounts and keys. Treasury places are shared accounts: roll back, or reverse what you commit. The global setup creates the treasury accounts first so parallel tests never race to create one.
- Plant faults (reconciliation checks) as the owner inside a rolled-back transaction.
- Guard tests prove the app role and, where it applies, the owner are refused; concurrency tests run the race in parallel (one key posted once, no overdraw, no deadlock).
- `src/conventions.test.ts` enforces ADR 0011's table shape (UUIDv7 ids, indexed foreign keys, `timestamptz`, no floats, `bigint` units, unique idempotency keys). An exception goes in `NOT_BUSINESS_RECORDS` or `NATURAL_KEYS` with a reason.
- Tests sit next to the code as `*.test.ts`; extend the file of the area you change (`src/ledger/*.test.ts`, `src/orders/orders.test.ts`, `src/pricing/*.test.ts`, …).
- Run one file with `pnpm verify packages/db/src/<path>.test.ts` (e.g. `pnpm verify packages/db/src/conventions.test.ts`), paths from the repo root; the whole branch runs once in `pnpm verify` before the PR (AGENTS.md).
