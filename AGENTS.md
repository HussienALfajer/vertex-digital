# Vertex Digital

A game and app top-up store for Syria, with a customer site and an admin panel. Customers top up a USD wallet (Sham Cash, USDT), then buy game top-ups (PUBG UC, Free Fire diamonds, chat apps, gift cards) that are fulfilled automatically through supplier APIs. Arabic-first RTL.

V1 goal: the most professional, clear and trustworthy top-up store in the Syrian market: money is never lost or double-spent, most orders are delivered in seconds without staff, and the customer always sees what is happening.

This project is independent. Do not read or reuse other folders on this machine unless the owner explicitly asks. One standing exception (owner, 2026-10-06): `D:\vertex-hub` may be **read, never edited**, to copy and adapt its design system (`packages/ui`, `brand/`) and its proven setup files (scripts, configs, CI, deploy) during Phase 0 and when a later task names it. Copied code is adapted to this project's rules; nothing is imported across repositories.

## Source of truth

| File | Purpose |
|---|---|
| `docs/product/v1-scope.md` | What V1 includes and excludes. Anything not in it is out of scope: ask before adding. |
| `docs/decisions/` | Architecture and business decisions (ADRs). Follow them; propose a new ADR to change one. ADR 0011 is the code shape: layout, module anatomy, naming, errors, lists, tests. |
| `<app or package>/CLAUDE.md` | Local rules and the pattern to copy for `apps/{store,admin,api,worker}`, `packages/{config,contracts,db,ui,suppliers}` and `deploy`. Any agent reads it before editing in that folder (Claude Code loads it on its own). Each arrives with its folder in Phase 0. |
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

Run from the repository root (Node 24, pnpm via Corepack: `corepack enable`).

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Local databases: `.env` with random passwords, the owner and app roles (ADR 0014), dev and test databases with the `pgboss` schema (asks for the PostgreSQL superuser password) | `pnpm db:setup-local` |
| Dev: api, worker, store (http://127.0.0.1:3001) and admin (http://127.0.0.1:5173) in watch mode | `pnpm dev` |
| Typecheck · lint · lint fix | `pnpm typecheck` · `pnpm lint` · `pnpm lint:fix` |
| Unit + integration tests (need the test database URLs in `.env`) | `pnpm test` |
| E2E (Playwright: builds, then store and admin against a mocked API; first time: `pnpm --filter @vertex-digital/store exec playwright install chromium`) | `pnpm test:e2e` |
| Migration after a schema change · apply to the dev database (Drizzle migrations, then pg-boss, as the owner role) | `pnpm db:generate` · `pnpm db:migrate` |
| OpenAPI document and the admin client after an API change (after `pnpm build`; commit `apps/api/openapi.json` and `apps/admin/src/lib/api/schema.gen.ts`) | `pnpm --filter @vertex-digital/api openapi:export` · `pnpm --filter @vertex-digital/admin api:generate` |
| First owner of the panel (prints a generated password once) · reset a staff member's TOTP | `pnpm --filter @vertex-digital/api staff:create-owner --email <email> --name <name>` · `pnpm --filter @vertex-digital/api staff:reset-two-factor --email <email>` |
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
- One branch per change, named by its type (`feat/<feature>`, `fix/<topic>`, `refactor/<topic>`, `chore/<topic>`, `docs/<topic>`), merged to `main` through a PR after CI passes. Never commit to or push `main` directly.
- Never squash or rebase-merge: the owner's cleanup uses `git branch -d`, which refuses branches merged that way.

## Finishing a task: open the PR at once

When a task's work is done (a spec approved, a `/feature-slice` PR accepted, a supplier adapter reviewed, a fix, a docs change), finish it in the same turn, without waiting to be asked. There is no separate shipping command. Stop and report at the first step that fails.

1. **Branch:** not `main`; if on `main`, create the branch named by type. `TASKS.md` has no open items for this PR.
2. **Docs:** update `docs/ROADMAP.md` when a feature or roadmap item is done, and every doc the change made stale (`docs/architecture.md`, a folder `CLAUDE.md`, `docs/open-questions.md`, the commands table above).
3. **Secrets:** `git status` and `git diff --stat` show no `.env`, key, receipt image, customer data or real supplier response; fixtures are sanitized.
4. **Checks:** lint, typecheck, test and build, plus `e2e` when `apps/store`, `apps/admin` or `packages/ui` changed and `drift` when `packages/db` changed. Run `node scripts/check-record.mjs status <checks…>` first: documentation-only changes run no local checks (CI runs them all); otherwise run only the checks marked `needed`, through the `checker` subagent (a check marked `recorded` already passed on this exact tree). Everything must pass; fix root causes.
5. **Review:** for feature and supplier work, the `reviewer` subagent has run and its blocking findings are fixed.
6. **Commit:** stage the intended files only; Conventional Commit subject, a body with what and why, ending with the session's attribution line.
7. **Pull request:** `git push -u origin <branch>`, `gh pr create --base main` with `## Summary` (what and why, in bullets) and `## Test plan` (the checks as ticked boxes, each marked run now or reused from the record; for docs only, "documentation only, CI runs the checks"), ending with the session's attribution line; then immediately `gh pr merge <number> --auto --merge`.
8. **Report** in the format below, with the PR link under Changed and the cleanup line at the end of "Needs from you".

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

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
