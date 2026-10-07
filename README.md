# Vertex Digital

A game and app top-up store for Syria. Customers fund a USD wallet with Sham Cash or USDT and buy game top-ups (PUBG Mobile UC, Free Fire diamonds), chat-app credits and gift cards, delivered automatically through supplier APIs. The owner runs the store from a separate admin panel with one admin account.

Arabic-first (RTL) web application: store at `digital.vertexmedia.pro`, admin at `digital-admin.vertexmedia.pro`.

## Status

Phase 0 (foundation): product scope, decisions and working method are documented, and the monorepo scaffold with CI is in place; the packages and apps follow. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Documentation

- [V1 scope](docs/product/v1-scope.md)
- [Architecture](docs/architecture.md)
- [Decision records](docs/decisions/README.md)
- [Working method](docs/workflow.md)
- [Open questions](docs/open-questions.md)
- [Visual identity](brand/identity.md)
- Agent instructions: [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md)

## Stack

TypeScript monorepo (pnpm, Turborepo): Next.js store, React + Vite admin panel, NestJS API and worker, PostgreSQL 17 with Drizzle, pg-boss jobs, Better Auth, and a design system built on shadcn/ui and Base UI.

## Getting started

Requirements: Node 24, pnpm (via Corepack), PostgreSQL 17.

```bash
corepack enable
pnpm install
pnpm db:setup-local
pnpm db:migrate
```

`db:setup-local` creates a git-ignored `.env` from `.env.example` with random database passwords (or adds the keys an existing one lacks), then the owner and app roles (ADR 0014) and the dev and test databases (it asks for the PostgreSQL superuser password), with the `pgboss` schema for the job queue; `db:migrate` brings the dev database up to date and installs the job queue tables. After pulling a change to `.env.example` or the database setup, run `db:setup-local` again: it is idempotent. `pnpm dev` then runs the API (http://127.0.0.1:3000/api/docs), the worker, the store (http://127.0.0.1:3001) and the admin panel (http://127.0.0.1:5173, open it at that address: the API accepts admin requests from it only); `admin:create` creates the admin account (there is only one), which changes its printed password and enrols TOTP at its first sign-in. `pnpm test:e2e` needs Chromium once: `pnpm --filter @vertex-digital/store exec playwright install chromium`. The tests migrate the test database themselves. All commands are listed in [AGENTS.md](AGENTS.md#commands).

## Security

No secrets are stored in this repository. Report a vulnerability privately to the owner rather than in a public issue.
