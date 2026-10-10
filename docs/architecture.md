# Architecture

Decisions behind this document are in `docs/decisions/`. Library versions are pinned in the lockfile once the workspace is scaffolded (Phase 0); verify peer-dependency compatibility at install time.

## Shape

One repository (pnpm workspaces + Turborepo) with four apps and shared packages. The API is a modular monolith; the worker runs background work with the same contracts and write paths (ADR 0001).

```
vertex-digital/
├── apps/
│   ├── store/        Next.js 16 customer site (digital.vertexmedia.pro)
│   ├── admin/        React 19 + Vite admin SPA (digital-admin.vertexmedia.pro)
│   ├── api/          NestJS HTTP API: src/core, src/modules (one per domain), src/cli
│   └── worker/       NestJS standalone: src/core, src/jobs, src/telegram
├── packages/
│   ├── contracts/    Zod schemas, money math, state tables, pricing rules, error codes
│   ├── db/           Drizzle schema, migrations, ledger posting and order transition write paths
│   ├── ui/           Vertex design system (shadcn/ui on Base UI, Tailwind v4 tokens, RTL)
│   ├── suppliers/    Supplier adapters behind one interface (shop2topup, wdgzone, manual, fake)
│   └── config/       Shared TypeScript and Biome configuration
├── deploy/           Everything installed on the server (ADR 0009)
├── brand/            Logo files and visual identity
├── docs/
├── AGENTS.md
└── CLAUDE.md
```

## Stack by layer

| Layer | Choice | ADR |
|---|---|---|
| Language / runtime | TypeScript strict, ESM, Node 24 | 0001, 0002 |
| Monorepo | pnpm workspaces, Turborepo | 0001 |
| Store | Next.js 16 App Router, Server Components, Cache Components, Motion, PWA | 0002 |
| Admin | React 19, Vite, TanStack Router / Query / Table, React Hook Form | 0002 |
| API | NestJS 12, native Standard Schema validation, OpenAPI | 0002 |
| Worker | NestJS standalone, pg-boss consumer, Telegram Bot API (sends only; updates reach the API's webhook, ADR 0019), Nodemailer | 0002, 0019 |
| Database | PostgreSQL 17, Drizzle ORM and drizzle-kit migrations | 0002, 0011 |
| Auth | Better Auth: customer instance (email OTP) and admin instance (one account, mandatory TOTP) | 0007, 0016 |
| Jobs | pg-boss, enqueued in the same transaction as the change | 0002, 0004 |
| Realtime | SSE from the API; worker → `pg_notify` → API `LISTEN` → streams | 0002 |
| Money | Integer units (USD micro-dollars, SYP 2 decimals), double-entry append-only ledger | 0003 |
| Suppliers | Adapters in `packages/suppliers`, encrypted keys, HMAC webhooks | 0005 |
| Payments | Sham Cash (reviewed receipts), USDT TRC20/BEP20 (on-chain verification) | 0006 |
| Bot protection | ALTCHA (self-hosted), nginx and API rate limits, fail2ban | 0008 |
| Images | sharp (receipts re-encoded; catalog images resized) | 0008 |
| Design system | shadcn/ui on Base UI, Tailwind CSS v4, RTL | 0012 |
| Errors | Sentry (free) + Telegram alerts | 0002 |
| Tests | Vitest, Playwright | 0011 |
| Lint / format | Biome | 0011 |
| CI | GitHub Actions: typecheck, lint, test, build, E2E, migration drift, OpenAPI drift, gitleaks | 0011 |

## API modules

Planned; each spec confirms its module's tables and exports. Built so far: `auth`, `admin`, `audit`, `notifications` (S01, S05), `wallet` (S02), `rates`, `files`, `deposits` (S03, S04), `settings`, `telegram` (S05), `catalog`, `pricing` (S06), `suppliers` (S07: the API and, in the worker, the sync, balances and health jobs) and `health`.

| Module | Owns | Feature |
|---|---|---|
| `auth` | Customer Better Auth tables, `customer_rate_limits` (code and sign-up counters), account changes (Nest routes in front of Better Auth under `/api/auth`, so each change is audited in its transaction), `/api/account`, test customers | F01 |
| `admin` | The admin Better Auth tables (one account, ADR 0016), the CLI account functions, the password change, re-authentication and own sessions | F02 |
| `audit` | Reads `audit_entries` for the audit log; every module writes its entries with `recordAudit` from `packages/db/src/audit`, in its own transaction | F02 |
| `wallet` | Ledger accounts, journals, postings (through `packages/db/src/ledger`), `wallet_adjustments`, `payment_references` (each real payment's reference claimed once, through `claimPaymentReference`); balances with their SYP value and timelines (`/api/wallet`), the admin wallet screens, adjustments and reversals, the ledger summary | F03, F04 |
| `rates` | `exchange_rates` (append-only: the rate and display step, the newest row is in force); `/api/admin/rates` (history, change with re-authentication); `RatesService.current()` for other modules. Quote locks live on the deposit (S03) | F04 |
| `deposits` | `deposits`, `deposit_receipts`, `deposit_flags`, `deposit_settings` (append-only versions), `usdt_deposits`, `usdt_transfers` (append-only), `usdt_scan_cursors`: the Sham Cash wizard (options, quotes, receipts, cancel; `/api/deposits`), USDT deposits (options, creation with an exact amount whose tail is unique per network, the optional TXID; `/api/deposits/usdt`, `/api/deposits/:id/txid`), the review queue and decisions (`/api/admin/deposits`, with `approve-usdt` and `recheck`), the USDT transfers seen on chain (`/api/admin/usdt-transfers`), the settings and QR images (`/api/admin/deposit-settings`; USDT addresses come from the server environment only); Sham Cash credits post through `postDepositCredit`, USDT credits through `creditUsdtDeposit` (shared with the worker), both claiming the payment reference through `claimPaymentReference` in `packages/db/src/ledger`; balances come from `WalletService` | F05, F06 |
| `catalog` | `catalog_categories` (seeded: games, apps, gift cards), `catalog_games` (games and apps: names, slug, cover and ID guide images, accent color, status), `catalog_input_fields` (key and type fixed at creation), `catalog_products` (`direct` or `code`, official price, maximum quantity); archived, never deleted. `/api/admin/catalog` (images, categories, games, fields, products: create, edit, reorder, archive and restore, every change audited; rules CT1–CT10 of S06), the public `/api/catalog/images/:id` (catalog images only, immutable; S09: `?w=160|320|640|1280`, WebP widths made once and kept beside the image). Availability is derived (`productAvailability` in the contracts, S07 rule P6), with each product's stored price, SYP price and basis supplier, from the routing state `packages/db` reads (`productRoutingStates`). `CatalogService` gives `pricing` product paths and targets, `CatalogItemsService` gives `pricing` and `suppliers` the product lock, a review's pause and an import's products; S09: `catalog_games.search_terms` (normalized, edited with the game) and the store's public reads in `catalog-store.service.ts`: `/api/catalog/storefront`, `/api/catalog/games/:slug`, `/api/catalog/search-index` (shown games only, prices and a service status per game, never a supplier, cost or health number; `public, max-age=30`, no cookie). Admin changes the store shows queue `store.revalidate` (`StoreRevalidateInterceptor`). Locks go category, then game, then product | F08 |
| `suppliers` | `suppliers` (four seeded rows, the low-balance threshold), `supplier_credentials` (AES-256-GCM, `SUPPLIER_KEYS_SECRET`, append-only, hints only in answers), `supplier_offers` (the mirror of each catalog; manual offers), `supplier_cost_changes`, `supplier_sync_runs` (one running per supplier), `supplier_calls`, `supplier_health_changes`, `supplier_balance_reads`, `supplier_policy` (append-only, seeded), `product_routes` (one live route per supplier per product, an offer serves one product), `supplier_webhook_events` (S08: one per supplier event id, the body encrypted with `ORDER_CODES_SECRET`; only the processing columns change, once). `/api/admin/suppliers` (list, detail, credentials and threshold with re-authentication, "sync now" one a minute, runs, offers, cost history, import of up to 100 offers into paused products, the policy) and the routes of a product (`/api/admin/catalog/products/:id/routes`, `/api/admin/routes/:id`). Every route change reprices its product in the same transaction. `POST /api/webhooks/suppliers/:code` (S08 rule F4: raw body up to 64 KB, verified by the supplier's adapter, stored once, `suppliers.webhook` queued; 401 for a bad signature or time). Above `catalog` | F09 |
| `pricing` | `margin_rules` (global, category, game, product; one live rule per target, the global rule never archived): `/api/admin/pricing/rules` (list, set and archive with re-authentication, audited before/after) and `/api/admin/pricing/preview`. The math is pure, in the contracts (`priceFromCost`, `isProfitable`, `resolveMarginRule`, `savings`, `needsReview`; ADR 0020, 0021); SYP from `RatesService.current()`. S07: `product_prices` (append-only, the newest per product is its price) and `price_reviews` (one open per product), written by the repricing path in `packages/db/src/pricing` (`repriceProducts`, shared with the worker); `/api/admin/pricing/reviews` (list, decide accept or pause, adjust the margin with re-authentication) and `/api/admin/catalog/products/:id/prices`; a rule change reprices the products it covers. Above `catalog` and `rates` | F10 |
| `orders` | S08: `orders` (never deleted or archived; a guard keeps terminal orders, the price and fields fixed and the transitions on ADR 0004's table), `order_events`, `order_codes` (AES-256-GCM with `ORDER_CODES_SECRET`, the row id as associated data) and `order_code_reveals` (append-only), `fulfilment_attempts` (the id is the supplier's idempotency key; a route tried once, one open attempt per order; closed ones never change), `order_policy` (append-only, seeded). Every change goes through `packages/db/src/orders` (`purchaseOrder`, `transitionOrder`, `applyOutcome`, `refundRemaining`), shared with the worker, which also holds the reads (the customer's and the admin's views, `revealCode`, delivery times). S09: reservations (`awaiting_balance`: at most 3 per customer under the wallet lock, 24 hours; `payWaitingOrders`, `cancelOwnReservation`, `expireReservations` in the write path), `player_checks` (a cache of supplier answers by an HMAC of the fields, `PLAYER_CHECK_SECRET`), the `orders_notify` trigger (`customer_orders`). `/api/orders` (buy with `Idempotency-Key` under the switches' shared lock, or reserve with `whenBalanceShort: reserve`, list, order, reveal a code, cancel a reservation), `/api/player-checks` (rules PV1–PV7: cache, per-customer and per-address limits, each supplier's daily quota), `/api/admin/orders` (list with tabs, counts, order, poll, resolve and refund with re-authentication, reveal, the policy), the `order:place` CLI. S10: `checkouts` (a cart paid by one purchase journal that its orders share; only `finished_at` changes, once), `saved_players` (the customer's own ids, deleted for real), `order_share_links` (gift and receipt tokens, revoked never deleted), the gift columns of `orders`; `checkoutOrders` and the checkout's summary (`orderFinished` in `transitionOrder`'s terminal path) in the write path; `/api/checkouts`, `/api/saved-players`, the receipt and gift link routes, the public `/api/shares/:token` page data and its PNG image (drawn by sharp with the fonts in `apps/api/assets/fonts`), the admin's link revocation, the `checkout:place` CLI. S11: `fulfilment_attempts.kind` (`routed`, or `admin_fulfil` for units the admin delivered from another source, without a route), `chosen_by_admin`, the delivery proof (`stored_files` kind `delivery_proof`, used once) and reference; `rerouteOrder`, `fulfilOrderManually`, `closeForAdminRefund`, the live board (`liveBoard`, `liveCounts`) and the dashboard's `orderFigures` in the write path; `/api/admin/orders/live`, `:id/routes`, `:id/reroute`, `:id/proof`, `:id/proofs/:fileId`, `:id/fulfil` (`order-actions.service.ts`), the refund extended to orders waiting on the manual supplier. Above `catalog`, `pricing`, `suppliers`, `wallet` and `settings` | F11, F13, F16 |
| `players` | Saved player IDs, validation cache and quota counters | F13, F14 |
| `search` | Search index over catalog names and aliases | F15 |
| `customers` | Limits, freezes, admin notes (the admin view of customers) | F19 |
| `reconciliation` | Nightly runs and their findings | F20 |
| `content` | FAQ, policies, banners, announcements | F21 |
| `reports` | No business data; reports on read from module report services, Excel export | F22 |
| `support` | Tickets, messages, attachments | F23 |
| `notifications` | `email_outbox` (S01), `customer_notifications` (only `read_at` changes, never deleted), `notification_preferences` (S05; web push subscriptions arrive with F24). Every customer event is written by `notifyCustomer` in `packages/db/src/notifications` in the transaction of the change (the row, the email unless the customer turned it off, `pg_notify` at commit), called through `NotificationsService.notifyCustomer` by `deposits` and `wallet` and directly by the worker. `/api/notifications` (list, `read`, and `stream`: SSE fanned out from one connection per API process listening on `customer_notifications` and (S09) `customer_orders` (the `order` event), 3 streams per customer, session re-checked through the access guard), `/api/account/notification-preferences`. S11: `/api/admin/stream` on the same connection: every order's `order` event (`{ orderId, status }`) and `resync` to the admin's streams (3 streams, 30 connects a minute, the admin session re-checked every 5 minutes; the route is `@NoActivity()`, so neither a connect nor a reconnect counts as activity); a 4th stream sends `replaced` to the oldest before closing it, and the panel then stays closed until that tab is looked at again | F01, F24, F27 |
| `settings` | `store_switch_changes` (append-only: a change is a row, the newest is the value): registration, the emergency stop (purchases, deposits), a pause per deposit method; the per-supplier switch arrives with S07. `/api/store/status` (public), `/api/admin/switches` (change with re-authentication, history); `SettingsService.values()` for other modules, `valuesForCreation(tx)` under the switches' shared lock for deposit creations and purchases (S05 rule SW5, S08 rule O2). Below the domain modules: it imports none | F26 |
| `telegram` | `telegram_links` (one live link; history kept), `telegram_link_codes` (single-use, SHA-256 only), `telegram_messages` (the bot's outbox, sent by the worker's `telegram.send`), `telegram_updates` (handled update ids), `telegram_prompts` (one open bot question; a deposit question names its deposit and submission), `telegram_deposit_cards` (one card per deposit submission, edited to the outcome), `telegram_bot_state` (one row: the last review reminder). `/api/admin/telegram` (status, link code and unlink with re-authentication, test message); `POST /api/webhooks/telegram` (secret header, Telegram's ranges in nginx, the linked user and chat): `/start <code>`, `/status`, `/stop` with a confirmation (stops on only, through `SettingsService.changeIn` with the channel `telegram`), `/help`; the card buttons "اعتماد" (unflagged Sham Cash deposits up to the Telegram limit: the transaction number, then a confirmation) and "رفض" (a reason button, then the internal note), through `DepositReviewService.approveFromTelegram` / `rejectFromTelegram`: the panel's approval and rejection with the prompt's id as the decision key and the channel `telegram`, re-checked at that moment. A domain module above `deposits` (`DepositReviewService.waitingCounts`, `telegramFacts`) and `settings`; other modules queue bot messages with `queueTelegramMessage` and card jobs with `queueDepositCard` from `packages/db/src/telegram` (the switch notices and every deposit change a card shows do), never through it. The API never calls Telegram (ADR 0019) | F07 |
| `activity` | Anonymized live activity feed built from delivered orders | F25 |
| `files` | `stored_files` (append-only) and the files under `FILES_ROOT`: uploads decoded with a pixel limit, stripped of metadata and re-encoded (receipts WebP, QR images PNG, catalog images WebP within 1600 px), with SHA-256 and dHash; `FilesService` (`prepare` before a transaction, `record` inside it, `serve` with `X-Accel-Redirect` in production, `dimensions`), `sendImage` and `uploadBody` for the modules' image routes. No routes of its own | F05, F23 |
| `dashboard` | S11 (F18): no tables. `GET /api/admin/dashboard`: today against yesterday at the same hour in Damascus (real customers' sales, profit, deliveries, refunds), the 7-day sales line, the live counts, deposits, suppliers, the rate and the attention list, read in parallel through `OrderActionsService`, `DepositReviewService`, `SuppliersService`, `PricingService`, `RatesService`, `SettingsService` and `TelegramService`; never cached. Above all of them | F18 |
| `health` | No tables; `GET /api/health` for nginx, PM2 and the deploy checks | Phase 0 |

Rules (anatomy and the tests that enforce them: ADR 0011):
- A module owns its tables. Other modules call its exported services; they never query its tables.
- `audit`, `files`, `notifications` and `settings` sit below the domain modules and never import them.
- The API core (`apps/api/src/core`) holds no business logic: config, database, access decorators and guard, errors, rate limits, ALTCHA, the origin check, the pg-boss producer (`core/jobs`: jobs sent in the caller's transaction), cursor lists.
- pg-boss runs as the app role; its tables are installed by the owner role with the migrations (ADR 0014).
- `packages/db/src/ledger` is the only way to write the ledger; `packages/db/src/orders` is the only way to change an order's state. Both are used by the API and the worker.
- Slow, scheduled or external work goes through pg-boss; the worker never serves HTTP.

## Worker jobs

| Area | Jobs |
|---|---|
| Fulfilment | `orders.fulfil` (route and send, `stately` per order), `orders.poll` (pending and unknown outcomes, `stately` per attempt), `orders.sweep` (every minute: lost sends, missed polls, the hard limit, manual reminders; A14), `orders.pay-waiting` (S09 rule RS4, A02: a customer's reservations paid, `stately` per customer; queued by the API and the worker with every deposit credit and each new reservation, worked through `payWaitingOrders`), `orders.waiting-sweep` (every 5 minutes: a paying run for each customer with an open reservation, at most 500) and, in `orders.sweep`, reservation expiry (A15, at most 100 a minute, `SKIP LOCKED`) and the deletion of player checks a day past their expiry. `store.revalidate` (S09 rule SF4, `singleton`, at most once per 10 seconds; a change inside a slot already used is debounced into the next one, so none waits for the 5-minute life) posts to the store's loopback `/_internal/revalidate` with `STORE_REVALIDATE_SECRET`; a failure is retried 3 times, then logged as a warning (the pages' 5-minute cache life is the fallback). The API queues it on admin changes; the worker on each successful sync, each health change, each balance crossing an offer's cost and each newly stale cost. The API queues `orders.fulfil` with each purchase and `orders.poll` with each pending or unknown result and each admin "poll again". `orders.fulfil` picks the first candidate of `orderCandidates`, writes the attempt and `sent_to_supplier`, commits, then calls the supplier with the attempt id as the key; a manual attempt waits for the admin with its `manual_order` card. `orders.poll` reads a pending attempt and sends a `sending` or `unknown` one again with its key. Results go through `applyOutcome`; refunds through `refundRemaining` (`apps/worker/src/jobs/orders/`) |
| Suppliers | `suppliers.webhook` (S08 rule F5: a stored event decrypted and parsed by the adapter, applied by `applyOutcome`; `same_result`, `unknown_key`, `malformed`, or a `conflict` noted on the order with an `order_conflict` alert); S07: `suppliers.sync` (one `listOffers` call, then in one transaction the offers mirrored, cost changes appended, the products on changed offers repriced through `repriceProducts`; an empty list or half the mapped offers vanishing fails the run; one running run per supplier; a summary message when reviews opened, the guard paused products or mapped offers went missing; an alert at the third failure in a row), `suppliers.sync-schedule` (every 15 minutes), `suppliers.balances` (every 5 minutes: a balance read per supplier, repricing when it crosses a mapped cost, the low-balance message, its 6-hour repeat and its recovery), `suppliers.health` (every minute: the state from the recorded calls, the probe of a `down` supplier, repricing on a change, products on stale costs repriced, a failing sync's stale costs reported once). Adapters come from `SupplierRegistry` (`apps/worker/src/suppliers/`), credentials decrypted per call; every call is recorded in `supplier_calls` |
| Deposits | `deposits.expire` (S03 rule SC12: every 5 minutes, overdue `pending` deposits to `expired`), `deposits.usdt-verify` (S04 rules U9–U11: one deposit's TXID, `stately` per deposit, re-sent by itself with `startAfter`: 15 s, then 60 s after 5 minutes of search, 10 s while confirming; credits an exact final match, sends a mismatch to review, bounces a failed TXID) and `deposits.usdt-scan` (rule U12: a network's final incoming transfers since its cursor, `stately` per network, every 20 s while a USDT deposit is open and every 5 minutes otherwise; credits the one exact pending deposit, alerts when stale, restarts a lost verification), both reading through the chain readers in `apps/worker/src/jobs/deposits/chain/` (`ChainReader`: TronGrid, BSC JSON-RPC, and the `fake` chain file for development), `deposits.review-reminder` (A09) |
| Money | `reconciliation.nightly` (A11) |
| Messaging | `email.send` (one outbox row; files locally, SMTP in production), `email.purge-codes` (every 10 minutes), `push.send`, `telegram.send` (S05: one `telegram_messages` row to its chat or the live link; files under `TELEGRAM_LOG_DIR` locally, the Bot API in production; a `429` waits its `retry_after`, a `403` fails at once); `telegram.deposit-card` (S05: one deposit's card, `stately` per deposit: the receipt re-encoded to JPEG with the caption and buttons while it waits, then edited to the outcome), `telegram.review-reminder` (every 5 minutes within the review hours: overdue reviews at the target, then every 30 minutes; prunes update ids after 7 days and closes expired prompts), `telegram.daily-summary` (22:30 `Asia/Damascus`, once a day by its dedupe key); the USDT scanner queues a `usdt_unmatched` message per unmatched transfer. At start the worker registers the webhook (`setWebhook`). Alerts (`TelegramAlerts`) go straight to the linked chat, read through `LinkedChat` (cached 60 s) |
| System | `system.heartbeat` (every minute: `worker_heartbeats`, read by the deploy check) |

## Request flow

```
Customer browser ──HTTPS──> nginx (digital.vertexmedia.pro)
   ├── /_next/static, images  → served from disk, immutable cache
   ├── /api/admin/*           → 404 (any letter case)
   ├── /api/webhooks/telegram → API from Telegram's ranges only, 64 KB (secret header, linked chat)
   ├── /api/webhooks/*        → API (supplier HMAC, IP allowlist)
   ├── /api/*                 → API 127.0.0.1 (SSE without buffering)
   ├── /_internal/*           → 404 (the store's cache refresh is for the worker on 127.0.0.1)
   └── /*                     → store (Next.js) 127.0.0.1
                                 └── server components → the API's public catalog routes over
                                     API_INTERNAL_URL (no cookie), cached under the `catalog` tag
                                     for at most 5 minutes; customer parts load in the browser

worker ── store.revalidate ──> store 127.0.0.1 POST /_internal/revalidate (bearer secret) → tag expired

Admin browser ──HTTPS──> nginx (digital-admin.vertexmedia.pro)
   ├── /api/admin/*           → API 127.0.0.1
   ├── /api/altcha/challenge  → API (the admin sign-in's proof of work after repeated failures)
   ├── /api/catalog/images/*  → API (catalog image previews: the panel's CSP allows its own host only)
   ├── /api/*                 → 404 (customer routes are not served on the admin host)
   └── /*                     → admin SPA build (static)

API ── pg-boss jobs ──> worker ── supplier APIs, TronGrid / BSC RPC, SMTP, Telegram, web push
worker ── pg_notify ──> API ── SSE ──> live order timeline, live orders room
```

## Authentication and authorization

- Customers: Better Auth at `/api/auth` for sign-in, sign-out and sessions; sign-up, email codes, recovery and account changes are the `auth` module's Nest routes on the same paths (ALTCHA, limits counted in PostgreSQL); phone required in E.164 (ADR 0007, S01).
- Admin: second Better Auth instance at `/api/admin/auth` with one account and full access (ADR 0016): created and recovered by CLI, forced change of a CLI-issued password, mandatory TOTP, 30-minute idle timeout and 12-hour sessions, re-authentication for routes marked `@Sensitive()`; no roles or permission map.
- The store and the API share one origin; the admin SPA and its `/api/admin` share another. No CORS is enabled.

## Data conventions

- Primary keys: UUIDv7 generated in the application.
- Timestamps: `timestamptz` in UTC; displayed in `Asia/Damascus`.
- Money: integer units with a currency; USD in micro-dollars, SYP with 2 decimals; rates as exact decimals stored on each transaction (ADR 0003).
- Ledger, order events, supplier events and audit entries are append-only. Business records are archived, never hard-deleted.
- External references and idempotency keys have unique indexes.

## Runtime topology (production)

```
nginx (TLS, rate limits, Brotli, proxy_cache, the only public listener)
PM2 (system user of the site)
  ├── store   Next.js     127.0.0.1:<port>
  ├── api     NestJS      127.0.0.1:<port>
  └── worker  NestJS      no port
PostgreSQL 17 — database vertex_digital; owner role vertex_digital_owner (migrations), app role vertex_digital (ADR 0014)
```

Ports are chosen at provisioning from the server's map (`/root/SERVER.md`) and recorded in `docs/deployment.md` (ADR 0009).

## Environments

- **Local (Windows):** PostgreSQL 17 installed natively; dev and test databases; the fake supplier and a local chain-reader stub; email written to files instead of sent.
- **CI:** GitHub Actions with a PostgreSQL service container; no secrets needed.
- **Production:** the owner's VPS, atomic releases with automatic rollback. No staging in V1.
