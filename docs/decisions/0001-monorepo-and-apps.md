# 0001 — One repository, four apps, a modular backend

Status: Accepted · Date: 2026-10-06

## Context
Vertex Digital has two audiences with different needs: customers on slow mobile connections who arrive from search and social links, and staff who work all day in a dense panel. Money and fulfilment rules must be identical wherever they run. The system is built by one owner with AI coding agents (ADR 0010), so one place for all code, docs and rules matters more than independent deployability of every part.

## Decision
- One repository, `pnpm` workspaces + Turborepo, package scope `@vertex-digital/*`, folder `D:\vertex-digital`.
- Four apps:
  - `apps/store` — the customer site (Next.js), `digital.vertexmedia.pro`.
  - `apps/admin` — the staff panel (Vite SPA), `digital-admin.vertexmedia.pro`.
  - `apps/api` — the only HTTP API (NestJS), under `/api` on both hosts. The single place that reads and writes the database for requests.
  - `apps/worker` — background processing (NestJS standalone): fulfilment, supplier sync and polling, webhook processing, USDT verification, Telegram admin bot, email.
- Shared packages: `contracts` (Zod schemas, pure rules, permission map), `db` (Drizzle schema, migrations, and the shared write paths for the ledger and order transitions, ADR 0003, 0004), `ui` (design system), `suppliers` (supplier adapters, ADR 0005), plus `config` (shared TypeScript and Biome configuration).
- The API is a **modular monolith**: domain modules with explicit boundaries (ADR 0011). The worker has its own job modules and uses the same `db` write paths, never its own copy of a money rule.
- The store never touches the database: it reads and writes through the API.

## Consequences
- One PR can change a contract, the API, the worker and both front ends together; CI checks them together.
- Money and order invariants live in exactly one place (`packages/contracts` for pure rules, `packages/db` for the write paths both processes use).
- The store and admin can be deployed and cached independently by nginx while sharing one release.
