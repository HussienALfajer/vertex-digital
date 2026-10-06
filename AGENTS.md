# Vertex Digital

A game and app top-up store for Syria, with a customer site and an admin panel. Customers top up a USD wallet (Sham Cash, USDT), then buy game top-ups (PUBG UC, Free Fire diamonds, chat apps, gift cards) that are fulfilled automatically through supplier APIs. Arabic-first RTL.

V1 goal: the most professional, clear and trustworthy top-up store in the Syrian market: money is never lost or double-spent, most orders are delivered in seconds without staff, and the customer always sees what is happening.

This project is independent. Do not read or reuse other folders on this machine (including other `vertex-*` directories) unless the owner explicitly asks.

## Source of truth

| File | Purpose |
|---|---|
| `docs/product/v1-scope.md` | What V1 includes and excludes. Anything not in it is out of scope: ask before adding. |
| `docs/decisions/` | Architecture and business decisions (ADRs). Follow them; propose a new ADR to change one. ADR 0011 is the code shape: layout, module anatomy, naming, errors, lists, tests. |
| `<app or package>/CLAUDE.md` | Local rules and the pattern to copy for `apps/{store,admin,api,worker}`, `packages/{contracts,db,ui,suppliers}` and `deploy`. Any agent reads it before editing in that folder (Claude Code loads it on its own). Created with the Phase 0 scaffold. |
| `docs/architecture.md` | Stack, repo layout, module map, data conventions, deployment topology. |
| `docs/ROADMAP.md` | Phase and feature status. Update it when a feature ships. |
| `docs/specs/<feature>.md` | Detailed spec per feature, written before implementation. |
| `docs/open-questions.md` | Unresolved decisions. Never guess an answer to one: ask. |
| `docs/workflow.md` | How work is run with AI coding agents (feature cycle, effort, sessions). |
| `brand/identity.md` | Visual identity: colors, typography, motif, store-specific guidance, patterns to avoid. Read before any UI work. |

Read these on demand. For a feature, read its spec, the ADRs it touches, and its section of `v1-scope.md`.

## Stack

pnpm workspaces + Turborepo · TypeScript (strict) · Node 24 · PostgreSQL 17 (ADR 0001, 0002)

- `apps/store` — Next.js 16 (App Router, Cache Components): the customer site at `digital.vertexmedia.pro`
- `apps/admin` — React 19 + Vite SPA, TanStack Router / Query / Table: the staff panel at `digital-admin.vertexmedia.pro`
- `apps/api` — NestJS 12, Drizzle, Zod contracts (native Standard Schema), OpenAPI, Better Auth, pg-boss producer, SSE
- `apps/worker` — NestJS standalone: fulfilment, supplier sync and polling, webhook processing, USDT verification, Telegram admin bot, email
- `packages/contracts` (Zod schemas, money and state rules, permission map) · `packages/db` (Drizzle schema, migrations, ledger and order write paths) · `packages/ui` (design system) · `packages/suppliers` (one adapter per supplier behind one interface)
- Tests: Vitest, Playwright (E2E, RTL screenshots) · Lint/format: Biome · CI: GitHub Actions + gitleaks · Errors: Sentry + Telegram alerts

## Commands

Defined with the Phase 0 scaffold; run from the repository root (Node 24, pnpm via Corepack). Until then there is nothing to build.

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Dev (api, worker, store, admin) | `pnpm dev` |
| Typecheck · lint · lint fix | `pnpm typecheck` · `pnpm lint` · `pnpm lint:fix` |
| Unit + integration tests (need `TEST_DATABASE_URL`) | `pnpm test` |
| E2E (Playwright) | `pnpm test:e2e` |
| Migration after a schema change · apply to the dev database | `pnpm db:generate` · `pnpm db:migrate` |
| Build | `pnpm build` |
| One package only | `pnpm --filter @vertex-digital/<name> <script>` |

Keep this table true: the PR that adds or changes a command updates it.

## Non-negotiable conventions

- **Money (ADR 0003):** integer units, never floats. USD is the base currency, stored in micro-dollars; SYP amounts carry the exchange rate used. The wallet is an append-only double-entry ledger: a balance is a sum of entries, never a stored number updated in place. Corrections are new reversing entries.
- **Never lose or duplicate money or goods (ADR 0004, 0005):** every deposit, order and supplier call carries an idempotency key. The wallet debit and the fulfilment job are written in the same transaction. A supplier call with an unknown outcome is resolved (poll, then staff) before any retry elsewhere. Never sell below cost.
- **One validation source:** Zod schemas live in `packages/contracts` and are reused by api, worker, store and admin.
- **Authorization is server-side:** every API endpoint declares its access. Customers and staff are separate accounts; staff routes live under `/api/admin/` and require TOTP (ADR 0007). UI checks are cosmetic.
- **Audit:** every money action and every staff action writes an audit entry in the same transaction.
- **Archive, don't delete:** business records are archived; ledger rows and audit rows are never updated or deleted.
- **Arabic-first RTL UI.** Logical CSS only (`ms-*`, `ps-*`, `start-*`), all text through i18n, Latin digits. Design-system components and tokens only (`brand/identity.md`).
- **No secrets in the repo** (it is public). Git-ignored `.env` files, `.env.example` with fake values, supplier keys encrypted in the database. Never paste a key, token, customer receipt or personal data into code, tests, fixtures, logs or chat.
- **No Cloudflare** (blocked in Syria). Protection is nginx, ALTCHA, rate limits and fail2ban (ADR 0008).

## How to work

- Continue without asking when the next step needs no input from the owner. Put brief status notes in the same message as the next action.
- Stop and ask only when a decision belongs to the owner (scope, business rules, prices, anything in `open-questions.md`), when a spec is ambiguous in a way that changes the result, or before a destructive or outward-facing action (deleting data, dropping tables, force-push, touching the production server, calling a live supplier or blockchain API with real money, publishing).
- A task is done only when its checks pass: typecheck, lint, and the relevant tests; for UI changes, a Playwright screenshot in RTL. Show the evidence (commands run and their results) instead of asserting success.
- Fix root causes. Never silence a failing test, type error, or lint rule to make a check pass.
- For multi-step work keep a checklist in `TASKS.md`: mark items done and add work you discover.
- Mark anything you could not confirm and say where you looked.
- Match the surrounding code: copy the pattern named in the folder's `CLAUDE.md`. Write no speculative code: helpers, options and abstractions arrive with their first real use.

## Context economy

- Search before reading, then read only the relevant range. For `v1-scope.md`, read the feature's section, not the whole file.
- Never read generated or lock files: `pnpm-lock.yaml`, `packages/db/migrations/meta/`, `routeTree.gen.ts`, `.next/`, `dist/`, `.turbo/`. Open Playwright screenshots only to verify a UI change.
- Run the narrowest check first (one package, one test file), and the full set once before the PR. With Turborepo, add `--output-logs=errors-only`.
- In replies, point to `path:line` instead of pasting files or diffs.

## Git

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- One branch per change, named by its type (`feat/<feature>`, `fix/<topic>`, `refactor/<topic>`, `chore/<topic>`, `docs/<topic>`), merged to `main` through a PR after CI passes.
- Right after opening a PR, enable auto-merge with a merge commit: `gh pr merge <number> --auto --merge`. Never squash or rebase-merge: the owner's cleanup uses `git branch -d`, which refuses branches merged that way.

## Reporting

End every substantial task with these sections, in this order:

1. **Needs from you** — decisions or approvals blocking progress, or "nothing". Whenever the task opened or merged a PR, always end this section with the local cleanup line for that PR's branch, in a code block, to run after the merge: `cd D:\vertex-digital; git switch main; git pull --ff-only; git branch -d <branch>`
2. **Changed** — what was built or modified.
3. **Verified** — checks run and their results.
4. **Found** — issues, risks, or follow-ups noticed.
5. **Next step** — always last: the next task you recommend (from `docs/ROADMAP.md` or what this task uncovered), why it comes next, and what it needs from the owner before it can start. Then: whether it needs a new session (`/clear` locally, a new session in the cloud) and whether it can run in the cloud (`docs/workflow.md`), the model and effort to set before the first message, and the exact first message to send, in its own code block.

## Language

Talk to the owner in Arabic, including the report and its headings. Write everything stored in the repo in English: code, comments, docs, prompts for agents, commit messages, PR descriptions. UI text is Arabic, through i18n.

## Production server

Deploys go to the owner's existing Ubuntu VPS, shared with other sites: PM2 + nginx, one isolated system user per site, apps listen on `127.0.0.1` only, nginx is the only public gateway (ADR 0009). Never run commands on the server without explicit approval in the current conversation. Read `/root/SERVER.md` on the server before any server work.
