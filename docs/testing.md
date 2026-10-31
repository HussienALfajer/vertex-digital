# Testing

How the checks run, locally and in CI, and why. `AGENTS.md` holds the rules in short; this file explains them. Measurements from 2026-10-26 are at the end.

## Where each check runs

Each check runs once, in the place where it is cheapest. The session checks what it changed; CI checks everything before a merge.

| When | What runs | Command | Time |
|---|---|---|---|
| While writing | Biome on each edited file (hook), the test file you are working on | `pnpm verify <file>` | seconds to a minute |
| A layer's gate | That layer's test files, `pnpm typecheck` | `pnpm verify <files>` | a few minutes at most |
| Before the PR, once | Lint; typecheck, test and build of every package (Turborepo replays the unchanged ones); the changed E2E specs of the store and the admin panel; migration and OpenAPI drift | `pnpm verify` | minutes when packages changed, under a minute when nothing did |
| CI, before the merge | Everything, the whole E2E suite included, split over parallel jobs | — | see "CI" |

The whole E2E suite (about 750 tests over both front ends) never runs in a session unless asked for (`pnpm verify --e2e-all`): CI runs it on four shards.

## `pnpm verify`

`scripts/verify.mjs`, from the repository root:

- `pnpm verify`: Biome over the repository through `scripts/lint.mjs`, as `pnpm lint` and CI run it (it also lints the tracked files a local `.git/info/exclude` hides from Biome, such as the `reports/` folders); `turbo run typecheck test build` (with `--continue`, so one failure does not hide the others); for each front end, the E2E specs the branch changed and the specs that import a helper it changed in `e2e/` (a mock, `test.ts`), against its production build (the store starts its own Next.js servers); `drizzle-kit generate` when `packages/db/src`, the migrations or `packages/contracts/src` changed (the schema takes its enums from the contracts); `openapi:export` and `api:generate` when `apps/api/src` or `packages/contracts/src` changed. A migration that `drizzle-kit generate` writes, or an `apps/api/openapi.json` or `apps/admin/src/lib/api/schema.gen.ts` it regenerates, fails the run as it fails CI: commit the new files with the change.
- `pnpm verify <file>...`: only those test files, paths from the repository root. Vitest files run in their package after `turbo run build --filter=<package>^...` (a stale dependency `dist` gives failures that are not in the code); E2E specs run after their front end's build. `--grep "<title>"` picks tests of a spec.
- Changed files are those that differ from the merge base with `origin/main` (committed, uncommitted or new); `--base <ref>` compares with another ref.
- Output: the whole output of each step in `.verify/<step>.log` (git-ignored); the console and `.verify/summary.md` get only the summary: each step's result and time, the tasks Turborepo ran rather than replayed, each failure with its file and line, and the command that reruns only the failed files.
- Exit code 0 when everything passed, 1 when a check failed, 3 when it refused to start: another `pnpm verify` is running on the machine (lock file `vertex-digital-verify.lock` in the temp folder; a lock left by a killed run expires after 45 minutes), `pnpm dev` is up during a whole-branch run (ports 3000, 3001 or 5173: the builds replace the `dist` folders its watchers run from; `--allow-dev` overrides; a run of named files does not check), or a file does not exist.

## Rules, and what enforces them

| Rule | Why | Enforced by |
|---|---|---|
| One test run at a time on the machine | Two runs share the test databases and the CPU, and fail each other's tests | The `test-guard` hook refuses a second run; the advisory lock makes a second run of a suite wait; the verify lock |
| Run once, read the log | Rerunning a suite to read its output again cost hours | `pnpm verify` keeps every log and prints the failures |
| Rerun only what failed | A full rerun after a one-file fix repeats minutes of passing tests | The summary prints the rerun command; Turborepo replays untouched packages |
| No edits while a check runs | The result no longer describes the code | Instructions (`CLAUDE.md`) |
| No whole E2E suite in a session | Minutes locally and timeouts under load; CI runs it on four shards | The `test-guard` hook (`pnpm verify --e2e-all` to run it on purpose) |
| No `timeout` around a test run | A killed run proves nothing and gets run again | The `test-guard` hook |
| No whole-branch check while `pnpm dev` runs | Its watchers load the machine, and the builds break the dev apps | The whole-branch `pnpm verify` refuses |

The hook is `.claude/hooks/test-guard.mjs` (PreToolUse on Bash and PowerShell). Commands that run no tests pass straight through, and the text of a heredoc counts as data; for a test command it reads the verify lock and the running Node processes of this repository and its checkouts.

## Test databases

- `packages/db` runs on the test database (`TEST_DATABASE_URL`); the api and worker suites run one Vitest worker per database `<test database>_<suite>_<n>`, so turbo runs the three suites at the same time. Files in one worker run one after another on its database, since some rows are global (rates, settings, the fake supplier's rows).
- The number of workers per suite is `TEST_WORKERS`, or half the logical CPUs from 4 to 12 (`packages/db/src/test-workers.ts`): 4 on CI runners, 12 on a 32-thread machine.
- `pnpm db:setup-local` creates the roles, the dev and test databases and as many worker databases as this machine uses, and lets the owner role create databases (locally and in CI only; production's roles cannot). The suites' global setups create the worker databases that are missing as the owner role (a larger `TEST_WORKERS`), with the app role's access (`packages/db/src/database-access.ts`), migrate them and remove what an interrupted run left behind.
- Each suite holds a session advisory lock on the test database for the length of its run (`holdTestDatabases`): a second run of the same suite prints that it waits, and starts when the first ends. PostgreSQL drops the lock if a run dies.
- In tests the api's and the worker's pools, and their pg-boss pools (`createPgBoss`, 2026-10-31: pg-boss's default of 10 per boot exhausted the server now and then), open at most 4 connections each (`DATABASE_POOL_MAX`). Pools open connections on demand: with the db, api and worker suites running together at 12 workers each, the server's busiest moment held 41 of PostgreSQL's default 100 connections (measured below), though the caps of every pool (pg-boss's and the test files' own too) add up to more. "Too many clients" errors mean fewer workers (`TEST_WORKERS`) or a higher limit.

## Vitest

- The api and worker suites run with `isolate: false`: a worker keeps its modules from one file to the next instead of loading the whole application again for every file. Files still start their own app and seed their own rows with unique values, so a test must leave nothing in module state; `test/worker-env.ts` (the last setup file, so its `afterAll` runs first) puts `process.env` back and restores every `vi.spyOn` after each file. No `vi.mock`: a mocked module would reach the files after it in the worker, or miss the copy an earlier file loaded; spy on a method instead (`test/architecture.test.ts` refuses it). Runs with shuffled files (`--sequence.shuffle.files`) passed whole.
- The query guards (`test/no-concurrent-queries.ts`, `test/no-pool-reads-in-transactions.ts`; the rules are in `packages/db/CLAUDE.md`) patch pg and drizzle once per process and give each test file a fresh list, so every file that triggers them fails, however many files ran before it in the same worker. The concurrent-query guard checks the client on every query, under the condition on which pg warns, since Node prints that warning only once per process.
- The smaller packages keep isolation.

## E2E

- Every test mocks the API in the browser; the store's server components read a local catalog server (`apps/store/e2e/catalog-server.mjs`). The admin runs against its production build served by `vite preview`, the store against its Next.js production build on three ports.
- Traces are recorded on the first retry only (`trace: 'on-first-retry'`): CI retries a failed test once and keeps its trace. Recording one for every test (`retain-on-failure`) slowed the suite and made tests time out under load. Debug locally with `--trace on`.
- A test that tours many screens sets `test.setTimeout(90_000)`; a race gets a proper wait, never a larger global timeout.
- CI fails a test that only passes on its retry (`failOnFlakyTests`).

## CI

`.github/workflows/ci.yml`. A pull request that changes only Markdown outside `brand/` skips the checks; the gate jobs still report.

| Job | Runs |
|---|---|
| Lint, typecheck, build | Audit, Biome, typecheck, build, migration drift, OpenAPI drift, the built API and worker start, `nginx -t` on `deploy/nginx` in nginx 1.24 (`deploy/test/nginx-check.sh`, audit A10-2) |
| Tests | Every package's tests (db, api and worker on 4 Vitest workers each, the runner's size) |
| E2E shard 1–4 | The whole E2E suite of both front ends, split by file (`--shard`). Only the Chromium browser is installed: the runner image already has its system libraries, and `--with-deps` once spent up to 13 minutes in apt |
| Typecheck, lint, test, build · E2E | Gate jobs: the checks the `main` branch protection requires, with Secret scan. A run superseded by a newer push is cancelled whole and its gates are skipped, so they never report a failure for it |
| Secret scan | gitleaks |

Turborepo's cache is kept between runs with `actions/cache`, per job. A pull request reads its own runs' cache and `main`'s; `main` cannot read a pull request's (GitHub keeps caches per branch), so after a merge `main` runs what the pull request changed once more.

### No remote cache (owner decision, 2026-10-28)

Turborepo's remote cache would let `main` replay what its pull request ran, but that repeat blocks nobody (the deploy follows the pull request's checks) and costs nothing on a public repository. Vercel's cache is not an option from Syria, and a self-hosted one would be another service on the shared server. Each job keeps its own cache (`actions/cache`).

## The local machine (Windows)

- **Antivirus.** Microsoft Defender scans every file the tests read and write. A [Dev Drive](https://learn.microsoft.com/windows/dev-drive/) (ReFS, with Defender's performance mode, which scans after the file operation instead of during it) for the repository and the pnpm store removes most of that; excluding the folders is the weaker alternative. Both are the owner's choice, set by hand.
- **PostgreSQL.** `max_connections = 100` bounds the number of workers.
- **`pnpm dev`.** Stop it (and the preview servers) before a whole-branch `pnpm verify`.
- **Old sessions.** Each Claude Code session starts its own connector processes; close the ones no longer used.

## Measurements (2026-10-26)

Local: Intel i9-14900HX (24 cores, 32 threads), 32 GB, NVMe, Windows 11, PostgreSQL 17 with `max_connections = 100`. Each line is one run with `pnpm dev` stopped and nothing else running; Vitest's own Duration in brackets.

| | Before | After |
|---|---|---|
| api suite (44 files, 683 tests) | 446 s [440 s] (isolation on, 4 workers) | 80 s [75 s] (isolation off, 12 workers, pool of 4); 62 s shuffled |
| api suite, 4 workers | 446 s | 100 s [98 s] (isolation off) |
| worker suite (18 files, 281 tests) | 38 s [34 s] (isolation on, 4 workers) | 26 s [25 s] (12 workers); 19 s shuffled |
| db, api and worker suites together (`turbo run test`) | — | 113 s; connections peaked at 41 of 100 |
| Whole admin E2E suite (243 tests, 16 workers) | 234 s, 26 failed (241 s, 8 failed, in a run beside a build) | 84 s and 83 s, none failed |
| Whole store E2E suite (502 tests, 16 workers) | 471 s, 23 failed | 129 s and 106 s, none failed |
| `pnpm verify` on this branch (25 tasks, 9 ran: db, api and worker) | — | 2 min 20 s |
| `pnpm verify` with nothing changed since the last run | — | 15 s (every task replayed) |

Every E2E failure before was a time limit (navigations, screens not shown within 5 seconds, screen tours past 30 seconds); recording traces only on retry removed all of them, so no spec needed a longer limit. The slowest test left is the store's carousel timing (24 s of its own 40 s limit), which waits on the 3-second rotation by design.

Before the change, sessions of this repository spent 22.8 hours in checks in three weeks; 182 runs of a whole suite repeated one with no change in between, and 22 collided with another session on the shared `_api_1..4` databases.
