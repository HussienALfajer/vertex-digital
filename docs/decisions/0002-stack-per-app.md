# 0002 — Stack per app

Status: Accepted · Date: 2026-10-06

## Context
The owner approved the stack. It reuses what works in the owner's other project (NestJS, Drizzle, React + Vite, Better Auth, pg-boss) and adds Next.js where search visibility and first-load speed on Syrian connections matter: the store.

## Decision

| Area | Choice |
|---|---|
| Language and runtime | TypeScript strict, ESM, Node 24 |
| Monorepo | pnpm (Corepack), Turborepo |
| Lint and format | Biome |
| Tests | Vitest (unit, API and worker integration against a real PostgreSQL test database), Playwright (E2E, RTL screenshots) |
| **apps/store** | Next.js 16, App Router, React Server Components, Cache Components (`use cache`, `cacheTag`) for catalog pages; i18n with an Arabic-only message catalog in V1; Motion for animation; PWA manifest and service worker (F24) |
| **apps/admin** | React 19 + Vite SPA, TanStack Router / Query / Table, React Hook Form + Zod, i18next; client generated from OpenAPI |
| **apps/api** | NestJS 12, native Standard Schema validation with Zod contracts, OpenAPI (`@nestjs/swagger`), Drizzle ORM, Better Auth (two instances, ADR 0007), pg-boss producer, SSE for live order status, pino logs |
| **apps/worker** | NestJS standalone context, pg-boss consumer and schedules; supplier adapters; on-chain verification clients; Telegram Bot API by long polling (no public webhook); Nodemailer over SMTP |
| Database | PostgreSQL 17, one database and role for the project |
| Jobs | pg-boss inside PostgreSQL: jobs are enqueued in the same transaction as the change that needs them |
| Realtime | Server-Sent Events from the API; the worker signals changes with `pg_notify`, the API holds one `LISTEN` connection and fans out to streams |
| Design system | `packages/ui`: shadcn/ui on Base UI, Tailwind CSS v4 tokens from `brand/identity.md`, RTL; components shared by store and admin |
| Errors and alerts | Sentry (free plan) in every app; a Telegram alert channel for errors and operational alerts, rate limited |
| Email | SMTP on a `vertexmedia.pro` mailbox (initially `info@vertexmedia.pro`), one outbox table sent by the worker |
| Bot protection | ALTCHA, self-hosted (ADR 0008) |

- The store's server components call the API over `127.0.0.1` with the customer's cookie forwarded; client components call `/api` on the same origin.
- Catalog pages are cached and tagged (`game:<id>`, `product:<id>`, `content`); the API asks the store to revalidate tags through an internal endpoint bound to `127.0.0.1` and protected by a shared secret, which nginx never exposes.
- Versions are pinned in the lockfile at scaffold time; peer-dependency compatibility is verified then.

## Consequences
- Two front-end frameworks: shared UI lives in `packages/ui` as client components that work in both; Next-specific code stays in `apps/store`.
- The store needs its own Node process in production (ADR 0009).
- No Redis: queues, rate-limit counters that must be shared, and notifications use PostgreSQL. A cache server is added only when a measured need appears.
