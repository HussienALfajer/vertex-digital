# Vertex Digital

A game and app top-up store for Syria. Customers fund a USD wallet with Sham Cash or USDT and buy game top-ups (PUBG Mobile UC, Free Fire diamonds), chat-app credits and gift cards, delivered automatically through supplier APIs. Staff run the store from a separate admin panel.

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
```

`db:setup-local` creates a git-ignored `.env` from `.env.example` with a random database password, then the role and the dev and test databases (it asks for the PostgreSQL superuser password). All commands are listed in [AGENTS.md](AGENTS.md#commands).

## Security

No secrets are stored in this repository. Report a vulnerability privately to the owner rather than in a public issue.
