# TASKS — Phase 0, Foundation

Phase 0 of `docs/ROADMAP.md`, split into four PRs. Each PR leaves `main` green and adds its CI job with its first real subject (no job, script or config before the code it checks). Each PR after the first runs in its own session; its items below are refined at its start.

## PR 1 — Monorepo scaffold (`chore/scaffold`) · Opus 5.5 `medium`
- [x] Root workspace: `package.json` (Corepack `packageManager`, Node 24 engine, scripts that work today), `pnpm-workspace.yaml` (release-age guard, build-script allowlist), `turbo.json`, `biome.json`, `.vscode/extensions.json`
- [x] `packages/config`: shared Biome config, `tsconfig/base.json` and `tsconfig/node.json`, a test of the strict settings, `CLAUDE.md`
- [x] CI (`.github/workflows/ci.yml`): install, `pnpm audit --prod`, lint, typecheck, test, build; gitleaks job; actions pinned to SHAs; `.github/dependabot.yml`
- [x] `pnpm db:setup-local` (`scripts/setup-local-db.mjs`): `.env` from `.env.example` with a random password, role, dev and test databases (idempotent)
- [x] Cloud sessions: `scripts/cloud-setup.sh` (Node 24, PostgreSQL 17 image), `scripts/cloud-session.sh` (SessionStart hook: PostgreSQL, install, databases) and the hook in `.claude/settings.json`
- [x] Docs: commands table in `AGENTS.md`, `README.md` getting started, `docs/workflow.md` (cloud environment setup), `docs/ROADMAP.md`
- [x] Checks (lint, typecheck, test, build), PR with auto-merge

## PR 2 — Money core: contracts and db (`feat/money-core`) · Opus 5.5 `xhigh`
- [ ] `packages/contracts`: `CURRENCY_SCALE`, money math (whole-cent rule, rounding up to a step, USD↔SYP with exact rates), error codes, order transition table (ADR 0004), 100% unit tests, `CLAUDE.md`
- [ ] `packages/db`: Drizzle client, env, UUIDv7 `id()`, `columns.ts` (timestamps, archivedAt, money columns), migrate CLI, `drizzle.config.ts`, `CLAUDE.md`
- [ ] Ledger schema (ADR 0003): accounts, journals (unique idempotency key), postings; first migration
- [ ] Custom migration: append-only trigger and grants (no `UPDATE`/`DELETE` for the app role) on journals and postings
- [ ] `src/ledger/` posting function: balanced per currency, idempotent by key, debit locks the wallet account and refuses a negative balance
- [ ] Tests: conventions test, trigger and grants, balance, idempotency, concurrency (parallel debits, same key twice)
- [ ] CI: PostgreSQL 17 service, migration drift job; cloud session migrates; `db:generate` and `db:migrate` scripts
- [ ] Checks (lint, typecheck, test, build, drift), reviewer, PR with auto-merge

## PR 3 — Backend skeletons: api, worker, suppliers, auth (`feat/backend-skeleton`) · Opus 5.5 `high`
- [ ] `packages/config/tsconfig/nest.json`; Biome overrides for Nest
- [ ] `apps/api`: NestJS 12, Standard Schema validation with Zod contracts, OpenAPI at `/api/docs`, pino, Sentry (off when `SENTRY_DSN` is empty), env validation, `/api/health`, error shape `{ statusCode, code, message }`, rate limits, ALTCHA verification, `CLAUDE.md`
- [ ] Auth (ADR 0007): customer Better Auth instance at `/api/auth`, staff instance at `/api/admin/auth` with TOTP enforced, their tables and migration, first-owner CLI (`apps/api/src/cli`), permission map skeleton in `packages/contracts`
- [ ] Access decorators `@Public()`, `@CustomerRoute()`, `@StaffRoute()` backed by the sessions; `test/architecture.test.ts`; tests for 401, 403, staff route without TOTP, customer session on a staff route
- [ ] `apps/worker`: NestJS standalone, pg-boss wiring, heartbeat job, Sentry, Telegram alert channel (rate limited, off without a token), `CLAUDE.md`
- [ ] `packages/suppliers`: `SupplierAdapter` interface (ADR 0005), HTTP and HMAC helpers (constant-time compare), the `fake` adapter with a local fake server, tests, `CLAUDE.md`
- [ ] CI: OpenAPI drift, the built API and worker start (health check, heartbeat scheduled); `pnpm dev`
- [ ] Checks, reviewer, PR with auto-merge

## PR 4 — Front ends and deployment (`feat/frontend-deploy`) · Opus 5.5 `medium`
- [ ] `packages/ui`: tokens from `brand/identity.md`, Vertex Hub components copied and adapted, fonts (Montserrat, Noto Kufi Arabic fallback, Madani when present), VERTEX DIGITAL wordmark draft in the Vertex Media style (Q16: agent draft, designer files later), `conventions.test.ts`, `tokens.test.ts`, `CLAUDE.md`
- [ ] `apps/store`: Next.js 16, Cache Components, Arabic RTL shell, dark default, i18n catalog, customer sign-in page, performance budget, Playwright smoke and screenshots (dark and light, phone width), `CLAUDE.md`
- [ ] `apps/admin`: Vite, TanStack Router and Query, RTL shell, theme switch, staff sign-in with TOTP, Playwright smoke and screenshots (light and dark), `CLAUDE.md`; `packages/config/tsconfig/react.json`
- [ ] CI: E2E job with the report and screenshots as artifacts, added to the required checks of `main` (owner approves); Chromium in the cloud scripts; `pnpm test:e2e`; `.claude/launch.json`
- [ ] `deploy/`: nginx for both hosts (TLS, limits, headers, Brotli, `/api/admin` split), fail2ban jails, PM2 ecosystem (store, api, worker), atomic releases with rollback, health checks, daily backups, provisioning script, `CLAUDE.md`; `docs/deployment.md`; Sentry account (Q15) noted. No server command without the owner's approval in that session
- [ ] Checks (with e2e), reviewer, owner acceptance in the browser, PR with auto-merge

## Branch protection (owner chose option A, 2026-10-06)
- [x] Required checks on `main` (owner approved): `Typecheck, lint, test, build` and `Secret scan` from GitHub Actions, branch up to date before merging; PR required, rules apply to admins, no force-push or deletion. Then auto-merge on PR 1
