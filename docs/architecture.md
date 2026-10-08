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
| Worker | NestJS standalone, pg-boss consumer, Telegram Bot API (long polling), Nodemailer | 0002 |
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

Planned; each spec confirms its module's tables and exports. Built so far: `auth`, `admin`, `audit`, `notifications` (S01) and `health`.

| Module | Owns | Feature |
|---|---|---|
| `auth` | Customer Better Auth tables, `customer_rate_limits` (code and sign-up counters), account changes (Nest routes in front of Better Auth under `/api/auth`, so each change is audited in its transaction), `/api/account`, test customers | F01 |
| `admin` | The admin Better Auth tables (one account, ADR 0016), the CLI account functions, the password change, re-authentication and own sessions; Telegram link later | F02, F07 |
| `audit` | Reads `audit_entries` for the audit log; every module writes its entries with `recordAudit` from `packages/db/src/audit`, in its own transaction | F02 |
| `wallet` | Ledger accounts, journals, postings (through `packages/db/src/ledger`), `wallet_adjustments`, `payment_references` (each real payment's reference claimed once, through `claimPaymentReference`); balances with their SYP value and timelines (`/api/wallet`), the admin wallet screens, adjustments and reversals, the ledger summary | F03, F04 |
| `rates` | `exchange_rates` (append-only: the rate and display step, the newest row is in force); `/api/admin/rates` (history, change with re-authentication); `RatesService.current()` for other modules. Quote locks live on the deposit (S03) | F04 |
| `deposits` | `deposits`, `deposit_receipts`, `deposit_flags`, `deposit_settings` (append-only versions), `usdt_deposits`, `usdt_transfers` (append-only), `usdt_scan_cursors`: the Sham Cash wizard (options, quotes, receipts, cancel; `/api/deposits`), USDT deposits (options, creation with an exact amount whose tail is unique per network, the optional TXID; `/api/deposits/usdt`, `/api/deposits/:id/txid`), the review queue and decisions (`/api/admin/deposits`, with `approve-usdt` and `recheck`), the USDT transfers seen on chain (`/api/admin/usdt-transfers`), the settings and QR images (`/api/admin/deposit-settings`; USDT addresses come from the server environment only); Sham Cash credits post through `postDepositCredit`, USDT credits through `creditUsdtDeposit` (shared with the worker), both claiming the payment reference through `claimPaymentReference` in `packages/db/src/ledger`; balances come from `WalletService` | F05, F06 |
| `catalog` | Games, products (direct top-up or code), input field definitions, categories, ID guides, availability | F08 |
| `suppliers` | Supplier connections (encrypted keys), offers, product mappings, price snapshots, price change queue, health, webhook events | F09 |
| `pricing` | Margin rules, computed prices, margin guard | F10 |
| `orders` | Orders, order events, fulfilment attempts and delivered units (through `packages/db/src/orders`), encrypted product codes and their reveal log, carts, gifts, receipts | F11, F13, F16 |
| `players` | Saved player IDs, validation cache and quota counters | F13, F14 |
| `search` | Search index over catalog names and aliases | F15 |
| `customers` | Limits, freezes, admin notes (the admin view of customers) | F19 |
| `reconciliation` | Nightly runs and their findings | F20 |
| `content` | FAQ, policies, banners, announcements | F21 |
| `reports` | No business data; reports on read from module report services, Excel export | F22 |
| `support` | Tickets, messages, attachments | F23 |
| `notifications` | Email outbox, in-site customer notifications, web push subscriptions, notification preferences | F01, F24, F27 |
| `settings` | Store switches (registration, emergency stop, per-method and per-supplier switches) with history | F26 |
| `activity` | Anonymized live activity feed built from delivered orders | F25 |
| `files` | `stored_files` (append-only) and the files under `FILES_ROOT`: uploads decoded with a pixel limit, stripped of metadata and re-encoded (receipts WebP, QR images PNG), with SHA-256 and dHash; `FilesService` (`prepare` before a transaction, `record` inside it, `serve` with `X-Accel-Redirect` in production). No routes of its own | F05, F23 |
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
| Fulfilment | `orders.fulfil` (route and send), `orders.poll` (pending and unknown outcomes), `orders.stuck` (A14), `orders.awaiting-balance` (A02, A15) |
| Suppliers | `suppliers.webhook` (process stored events), `suppliers.sync-prices` (A06), `suppliers.balances` (A07), `suppliers.health` (A08) |
| Deposits | `deposits.expire` (S03 rule SC12: every 5 minutes, overdue `pending` deposits to `expired`), `deposits.usdt-verify` (S04 rules U9–U11: one deposit's TXID, `stately` per deposit) and `deposits.usdt-scan` (rule U12: a network's incoming transfers, `stately` per network), both arriving with S04 PR 2, `deposits.review-reminder` (A09) |
| Money | `reconciliation.nightly` (A11) |
| Messaging | `email.send` (one outbox row; files locally, SMTP in production), `email.purge-codes` (every 10 minutes), `push.send`, `telegram.*` (admin bot, alerts, daily summary) |
| System | `system.heartbeat` (every minute: `worker_heartbeats`, read by the deploy check) |

## Request flow

```
Customer browser ──HTTPS──> nginx (digital.vertexmedia.pro)
   ├── /_next/static, images  → served from disk, immutable cache
   ├── /api/admin/*           → 404 (any letter case)
   ├── /api/webhooks/*        → API (supplier HMAC, IP allowlist)
   ├── /api/*                 → API 127.0.0.1 (SSE without buffering)
   └── /*                     → store (Next.js) 127.0.0.1, proxy_cache for anonymous catalog pages
                                 └── server components → API over 127.0.0.1 (cookie forwarded)

Admin browser ──HTTPS──> nginx (digital-admin.vertexmedia.pro)
   ├── /api/admin/*           → API 127.0.0.1
   ├── /api/altcha/challenge  → API (the admin sign-in's proof of work after repeated failures)
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
