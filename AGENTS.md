# Vertex Digital

A game and app top-up store for Syria, with a customer site and an admin panel. Customers top up a USD wallet (Sham Cash, USDT), then buy game top-ups (PUBG UC, Free Fire diamonds, chat apps, gift cards) that are fulfilled automatically through supplier APIs. Arabic-first RTL.

V1 goal: the most professional, clear and trustworthy top-up store in the Syrian market: money is never lost or double-spent, most orders are delivered in seconds without admin action, and the customer always sees what is happening.

This project is independent. Do not read or reuse other folders on this machine unless the owner explicitly asks. One standing exception (owner, 2026-10-06): `D:\vertex-hub` may be **read, never edited**, to copy and adapt its design system (`packages/ui`, `brand/`) and its proven setup files (scripts, configs, CI, deploy) when a task names it. Copied code is adapted to this project's rules; nothing is imported across repositories.

## Source of truth

| File | Purpose |
|---|---|
| `docs/product/v1-scope.md` | What V1 includes and excludes. Anything not in it is out of scope: ask before adding. |
| `docs/decisions/` | Architecture and business decisions (ADRs). Follow them; propose a new ADR to change one. ADR 0011 is the code shape: layout, module anatomy, naming, errors, lists, tests. |
| `<app or package>/CLAUDE.md` | Local rules and the pattern to copy for `apps/{store,admin,api,worker}`, `packages/{config,contracts,db,ui,suppliers}` and `deploy`. Any agent reads it before editing in that folder (Claude Code loads it on its own). Kept short: layout, rules, patterns; history lives in git and the specs. |
| `docs/architecture.md` | Stack, repo layout, module map, data conventions, deployment topology. |
| `docs/ROADMAP.md` | Phase and feature status. Update it when a feature ships. |
| `docs/specs/<feature>.md` | Detailed spec per feature, written before implementation. |
| `docs/audits/README.md` | The comprehensive audit: groups A01–A10 with their scope and status, the audit dimensions, severity, the cycle of a group; one report per group (`docs/audits/A<nn>-*.md`). |
| `docs/open-questions.md` | Unresolved decisions. Never guess an answer to one: ask. |
| `docs/workflow.md` | How work is run with AI coding agents (feature cycle, effort, sessions). |
| `docs/deployment.md` | How production is deployed, checked, rolled back and recorded. Read it with `/root/SERVER.md` on the server before any deploy. |
| `docs/testing.md` | How checks run: `pnpm verify`, what runs locally and what in CI, the test databases, the Vitest and E2E rules, the CI jobs, the local machine. |
| `brand/identity.md` | Visual identity: colors, typography, motif, store-specific guidance, patterns to avoid. Read before any UI work. |

Read these on demand. For a feature, read its spec, the ADRs it touches, and its section of `v1-scope.md`.

## Stack

pnpm workspaces + Turborepo · TypeScript (strict) · Node 24 · PostgreSQL 17 (ADR 0001, 0002)

- `apps/store` — Next.js 16 (App Router, Cache Components): the customer site at `digital.vertexmedia.pro`
- `apps/admin` — React 19 + Vite SPA, TanStack Router / Query / Table: the admin panel at `digital-admin.vertexmedia.pro`
- `apps/api` — NestJS 12, Drizzle, Zod contracts (native Standard Schema), OpenAPI, Better Auth, pg-boss producer, SSE
- `apps/worker` — NestJS standalone: fulfilment, supplier sync and polling, webhook processing, USDT verification, Telegram admin bot, email
- `packages/contracts` (Zod schemas, money and state rules, error codes) · `packages/db` (Drizzle schema, migrations, ledger and order write paths) · `packages/ui` (design system) · `packages/suppliers` (one adapter per supplier behind one interface)
- Tests: Vitest, Playwright (E2E, RTL screenshots) · Lint/format: Biome · CI: GitHub Actions + gitleaks · Errors: Sentry + Telegram alerts
- Turborepo's configuration and CLI change between versions: before changing `turbo.json` or a turbo command, read the installed package's docs (`node -p "require.resolve('turbo/package.json')"`, then its `docs/`).

## Commands

Run from the repository root (Node 24, pnpm via Corepack: `corepack enable`).

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Local databases: `.env` with random passwords and a local VAPID key pair for web push (S15), the owner and app roles (ADR 0014), dev and test databases with the `pgboss` schema, and one test database per Vitest worker of the api and worker suites (`TEST_WORKERS`, sized to the machine; the suites' global setups create the ones a larger number needs, as the owner role) (asks for the PostgreSQL superuser password) | `pnpm db:setup-local` |
| Dev: api, worker, store (http://127.0.0.1:3001) and admin (http://127.0.0.1:5173) in watch mode | `pnpm dev` |
| Check a change, each check once: lint; typecheck, test and build (Turborepo replays unchanged packages); the changed E2E specs of the store and the admin panel; migration and OpenAPI drift when their sources changed. The whole-branch run refuses while `pnpm dev` is up (`--allow-dev` overrides); summary on the console, logs in `.verify/` (`docs/testing.md`) · only some test files (paths from the root; `--grep <title>` for part of a spec) | `pnpm verify` · `pnpm verify <file>...` |
| Typecheck · lint · lint fix | `pnpm typecheck` · `pnpm lint` · `pnpm lint:fix` |
| Unit + integration tests (need the test database URLs in `.env`; the db, api and worker suites run at the same time on databases of their own, `TEST_WORKERS` Vitest workers each for the api and the worker; a second run of a suite waits for the first); Turbo replays packages whose inputs did not change | `pnpm test` |
| E2E (Playwright: store and admin against a mocked API; first time: `pnpm --filter @vertex-digital/store exec playwright install chromium`): the changed specs run in `pnpm verify`; the whole suite runs in CI over four shards (here only on purpose: `pnpm verify --e2e-all`) | `pnpm verify apps/<store or admin>/e2e/<file>.spec.ts [--grep <title>]` |
| A full local store to test by hand: copy the production catalog read-only into the git-ignored `storage/catalog-snapshot` (SSH alias `vertex`; catalog tables and the games' images only, no customer, order, ledger or key) · empty and migrate the dev database again (stop `pnpm dev` first) · fill it with `pnpm dev` running (the catalog with every WDGZone pack mirrored on the fake supplier and WDGZone paused, customers, wallets, deposits, orders in every state, decisions, tickets, content, treasury, reconciliation; about 8 minutes; prints the customers' password, and the admin's when it creates the admin) | `bash scripts/pull-catalog-snapshot.sh` · `pnpm db:reset-local --yes` · `pnpm db:seed-local [--admin-email <email>] [--admin-name <name>] [--catalog <dir>]` |
| Migration after a schema change · apply to the dev database (Drizzle migrations, then pg-boss, as the owner role) | `pnpm db:generate` · `pnpm db:migrate` |
| OpenAPI document and the admin client after an API change (after `pnpm build`; commit `apps/api/openapi.json` and `apps/admin/src/lib/api/schema.gen.ts`) | `pnpm --filter @vertex-digital/api openapi:export` · `pnpm --filter @vertex-digital/admin api:generate` |
| The admin account (prints a generated password once; there is only one, ADR 0016) · reset its password (printed once) · reset its TOTP | `pnpm --filter @vertex-digital/api admin:create --email <email> --name <name>` · `pnpm --filter @vertex-digital/api admin:reset-password --email <email>` · `pnpm --filter @vertex-digital/api admin:reset-two-factor --email <email>` |
| A fake USDT transfer for local testing (S04; `CHAIN_READER=fake`, after `pnpm build`; default: official USDT to the `.env` address, final at once) | `pnpm --filter @vertex-digital/worker usdt:fake-transfer --method usdt_trc20 --amount 25.0037 [--txid <hex>] [--to <address>] [--contract <address>] [--failed]` |
| Script the fake chain's USDT balance of the store's address for local testing (S13; `CHAIN_READER=fake`, after `pnpm build`): the balance the reconciliation reads is the fake transfers plus this offset; `--adjust` adds to it (negative takes from it), `--reset` sets it back to 0 | `pnpm --filter @vertex-digital/worker usdt:fake-balance --method <usdt_trc20\|usdt_bep20> --adjust <±usd> \| --reset` |
| Script the fake supplier's catalog and account for local testing (`SUPPLIER_FAKE_ENABLED=true`, after `pnpm build`; one change per call, read by the worker at its next call or sync) | `pnpm --filter @vertex-digital/worker supplier:fake --cost <offer> <usd> \| --stock <offer> on\|off \| --remove <offer> \| --fail-sync on\|off \| --errors on\|off \| --balance <usd> \| --reset \| --stock-count <offer> <n>\|unlimited \| --category-missing <category> on\|off \| --add-offer <category> <name> <usd>` |
| Script the fake supplier's orders: an offer's next orders (`resend-refused`: the first send answers unknown, its re-send is refused), or settle an order's open fake attempt for the next poll or through its signed webhook to the local API | `pnpm --filter @vertex-digital/worker supplier:fake --order <offer> delivered\|pending\|failed\|invalid\|unknown\|resend-refused\|partial:<n>\|slow:<seconds> \| --resolve <order number> delivered\|failed --via poll\|webhook` |
| Buy a product for a customer at its current price (S08; development only, after `pnpm build`), or reserve it when the balance is short (`--reserve`, S09) and confirm an unchecked player id (`--confirm-player`); save the player id (`--save`) or make it a gift (`--gift-sender`, `--gift-message`, S10): prints the order number | `pnpm --filter @vertex-digital/api order:place --email <customer> --product <id> [--quantity <n>] [--field <key>=<value>]… [--reserve] [--confirm-player] [--save <label>] [--gift-sender <name>] [--gift-message <text>]` |
| Pay a cart for a customer at the current prices (S10; development only, after `pnpm build`): each `--line` is a product and an optional quantity, followed by its own `--field` options; prints the checkout id and its order numbers | `pnpm --filter @vertex-digital/api checkout:place --email <customer> --line <product>[:<quantity>] [--field <key>=<value>]… [--line …]…` |
| A fake Telegram update to the local webhook (S05; `TELEGRAM_TRANSPORT=log`, after `pnpm build`): link with the panel's code or link, send a command, press a button of the newest message file | `pnpm --filter @vertex-digital/api telegram:fake-update --start <code or link> \| --text <text> \| --tap <button text>` |
| Add the wholesale and cost rules and price every routed product on every price list (S20 RP4; once the S20 deploy is healthy, and whenever a list's rows must be caught up; idempotent: only missing or changed rows, after `pnpm build`; from its first run, never roll back past S20) | `pnpm --filter @vertex-digital/api pricing:reprice-lists` |
| Set up the merchant tiers (S23 PX1; once in production after the S23 deploy, and run by `pnpm db:seed-local`; after `pnpm build`; idempotent: renames the wholesale list for Bronze, creates the chained Silver, Gold and Diamond lists with their rules and the three levels, leaves what exists by name or tier and reports it, prices the lists and queues every merchant's recomputation) | `pnpm --filter @vertex-digital/api merchants:setup-tiers` |
| Wait for a PR opened with auto-merge to land (in the background; exit codes in the script and in "Finishing a task") | `bash scripts/wait-merge.sh <pr number> [minutes]` |
| Build | `pnpm build` |
| One package only | `pnpm --filter @vertex-digital/<name> <script>` |

Keep this table true: the PR that adds or changes a command updates it.

## Non-negotiable conventions

- **Money (ADR 0003):** integer units, never floats. USD is the base currency, stored in micro-dollars; SYP amounts carry the exchange rate used. The wallet is an append-only double-entry ledger: a balance is a sum of entries, never a stored number updated in place. Corrections are new reversing entries.
- **Never lose or duplicate money or goods (ADR 0004, 0005):** every deposit, order and supplier call carries an idempotency key. The wallet debit and the fulfilment job are written in the same transaction. A supplier call with an unknown outcome is resolved (poll, then the admin) before any retry elsewhere. Never sell below cost.
- **One validation source:** Zod schemas live in `packages/contracts` and are reused by api, worker, store and admin.
- **Authorization is server-side:** every API endpoint declares its access. Customers and the single admin account are separate (ADR 0007, 0016); admin routes live under `/api/admin/` and require TOTP. UI checks are cosmetic.
- **Audit:** every money action and every admin action writes an audit entry in the same transaction.
- **Archive, don't delete:** business records are archived; ledger rows and audit rows are never updated or deleted.
- **Arabic-first RTL UI.** Logical CSS only (`ms-*`, `ps-*`, `start-*`), all text through i18n, Latin digits. Design-system components and tokens only (`brand/identity.md`).
- **No secrets in the repo** (it is public). Git-ignored `.env` files, `.env.example` with fake values, supplier keys encrypted in the database. Never paste a key, token, customer receipt or personal data into code, tests, fixtures, logs or chat.
- **No Cloudflare** (blocked in Syria). Protection is nginx, ALTCHA, rate limits and fail2ban (ADR 0008).

## How to work

- Continue without asking when the next step needs no input from the owner. Put brief status notes in the same message as the next action.
- Stop and ask only when a decision belongs to the owner (scope, business rules, prices, anything in `open-questions.md`), when a spec is ambiguous in a way that changes the result, or before a destructive or outward-facing action (deleting data, dropping tables, restoring a database snapshot, force-push, calling a live supplier or blockchain API with real money, moving real customer money, publishing anything outside this repository). Deploying `main` to production and changing production through the server or the admin panel (catalog, settings, test fixtures) need no approval (owner, 2026-10-18): do them when the task calls for them and report what changed.
- **Standing approvals (owner, 2026-10-28): never ask about these, in a message, a question card or a closing box.** Committing; pushing a branch; opening its PR with auto-merge; turning on Auto-fix; waiting for the merge and merging a green PR whose auto-merge stayed idle; deploying when the task includes a deploy; server commands other than those in the stop list above (a restore, deleting production data, real money); migrating, resetting and seeding the local dev database (`pnpm db:migrate`, `pnpm db:reset-local --yes`, `pnpm db:seed-local`) and resetting the local admin's password or TOTP for a test. Do them and report them.
- A task is done when `pnpm verify` passes on its final state, its PR has merged with CI green ("Finishing a task"), and, when the task includes one, the deploy is done; for UI changes, a Playwright screenshot in RTL. Show the evidence (the verify summary) instead of asserting success.
- Fix root causes. Never silence a failing test, type error, or lint rule to make a check pass.
- For multi-step work keep a checklist in `TASKS.md`, replacing the previous task's list (git keeps the old ones): mark items done and add work you discover. When a PR opens, its own items are done. `TASKS.md` is tracked so the next session can run Local or Cloud: a session that stops in the middle of a PR commits and pushes its branch with a `Stopped at:` line (`docs/workflow.md`, "Moving work between Local and Cloud").
- Mark anything you could not confirm and say where you looked.
- Match the surrounding code: copy the pattern named in the folder's `CLAUDE.md`. Write no speculative code: helpers, options and abstractions arrive with their first real use.

## Context economy

- Search before reading, then read only the relevant range. For `v1-scope.md`, read the feature's section, not the whole file.
- Never read generated or lock files: `pnpm-lock.yaml`, `packages/db/migrations/meta/`, `routeTree.gen.ts`, `.next/`, `dist/`, `.turbo/`. Open Playwright screenshots only to verify a UI change.
- Checks (`docs/testing.md`): while building, run only the tests you work on (`pnpm verify <file>`); before the PR, `pnpm verify` once, and again only after a change. Each check runs once: read its failures in the summary and in `.verify/`, never run a suite again to see its output, and rerun only the files that failed. One test run at a time, and no edits while it runs: the `test-guard` hook refuses a second run, the whole E2E suite and `timeout` around tests. CI runs everything.
- In replies, point to `path:line` instead of pasting files or diffs.

## Git

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- One branch per change, named by its type (`feat/<feature>`, `fix/<topic>`, `refactor/<topic>`, `chore/<topic>`, `docs/<topic>`), merged to `main` through a PR after CI passes. Never commit to or push `main` directly.
- Never squash or rebase-merge: the owner's cleanup uses `git branch -d`, which refuses branches merged that way.

## Finishing a task: PR, merge, deploy

When a task's work is done (a spec approved, a `/feature-slice` PR reviewed, a supplier adapter reviewed, an audit group fixed, a fix, a docs change), finish it in the same turn, without waiting to be asked and without asking ("Standing approvals" above). There is no separate shipping command. Stop and report at the first step that fails.

1. **Branch:** not `main`; if on `main`, create the branch named by type. `TASKS.md` has no open items for this PR.
2. **Docs:** update `docs/ROADMAP.md` when a feature or roadmap item is done, and every doc the change made stale (`docs/architecture.md`, a folder `CLAUDE.md`, `docs/open-questions.md`, the commands table above).
3. **Secrets:** `git status` and `git diff --stat` show no `.env`, key, receipt image, customer data or real supplier response; fixtures are sanitized.
4. **Checks:** `pnpm verify` passes on the final tree (lint, typecheck, test, build, the changed E2E specs, and migration and OpenAPI drift when their sources changed). A green run on the same tree counts; after a fix run it again, and Turborepo replays what the fix did not touch. A change to Markdown outside `brand/` only runs no local checks (CI skips it as well). CI runs everything, the whole E2E suite over four shards. Everything must pass; fix root causes.
5. **Review:** for feature and supplier work, the `reviewer` subagent has run and its blocking findings are fixed.
6. **Commit:** stage the intended files only; Conventional Commit subject, a body with what and why, ending with the session's attribution line.
7. **Pull request:** `git push -u origin <branch>`, `gh pr create --base main` with `## Summary` (what and why, in bullets) and `## Test plan` (the checks as ticked boxes, each marked run now or reused from the record; for docs only, "documentation only, CI runs the checks"), ending with the session's attribution line; then immediately `gh pr merge <number> --auto --merge`. In a cloud session `gh pr create` is refused: push the branch, ask the owner to press **Create PR** in the session, then turn on auto-merge; deploys (`ssh`) and browser checks against the local stack stay local, so report them as steps for a local session. In the Claude desktop app, also turn on the PR's Auto-fix. Put everything the PR needs in it before opening it: a second push right after it restarts CI.
8. **Merge:** run `bash scripts/wait-merge.sh <number>` in the background and act on its exit: 0 merged; 1 closed (report it); 2 not merged within the hour or 5 GitHub unreachable (read `gh pr checks <number>`, then wait again); 3 a check failed (read `gh run view <run-id> --log-failed`, fix the cause on the branch, push, wait again); 4 a conflict (merge `main` into the branch, push, wait again). It merges a green PR whose auto-merge stayed idle and brings a branch behind `main` up to date on GitHub (`git pull --no-rebase` before the next push). This wait is the owner's standing instruction and replaces the desktop app's default of leaving CI to Auto-fix alone. A review comment that asks for no change (a bot's summary) needs no commit.
9. **Deploy** when the task includes one (the owner asked for it, an audit group, a fix of a production bug, a phase deploy): `docs/deployment.md` (its health checks), then open the changed screens on production without real money, and add the deploy's line to its deploy log in a small docs PR, merged the same way.
10. **Report** in the format below, with the PR link under Changed and the cleanup line at the end of "Needs from you".

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

Deploys go to the owner's existing Ubuntu VPS, shared with other sites: PM2 + nginx, one isolated system user per site, apps listen on `127.0.0.1` only, nginx is the only public gateway (ADR 0009). Server commands, deploys and rollbacks need no approval in the conversation (owner, 2026-10-18); the destructive and real-money actions listed under "How to work" still do. Read `/root/SERVER.md` on the server before any server work.
