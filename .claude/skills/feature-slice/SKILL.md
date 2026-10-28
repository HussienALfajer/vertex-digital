---
name: feature-slice
description: Implement an approved feature spec end to end, layer by layer (contracts → db → api/worker → bridge → admin/store → E2E), with a check gate after each layer, the reviewer and a browser check, then the PR, its merge and, when the task includes it, the deploy. The implement step of the feature cycle, after /spec.
argument-hint: <spec id or path, e.g. S23>
disable-model-invocation: true
---

Implement **$ARGUMENTS**. This skill orders the work and names the gates; the rules for each folder stay in its `CLAUDE.md` and in ADR 0011. The wiring checklist and the files to copy from are in [wiring.md](wiring.md): read it before the first layer.

## 0. Preconditions (stop and tell the owner if one fails)
- The spec (`docs/specs/<id>-*.md`) says `Status: Approved`, and its "Open questions" block nothing this work touches. Never answer an open question yourself.
- The branch is not `main`. Name it `feat/<id>-<slice>`, e.g. `feat/s22-quick-buy`.
- The working tree is clean, and `main` is pulled (pull it yourself).

## 1. Plan (no code)
- Read only: the spec, the ADRs it lists, `wiring.md`, and the `CLAUDE.md` of each folder you will touch. Open reference files by range, when you write the layer that needs them.
- If `TASKS.md` already holds this feature, continue from its first open PR instead of planning again. Check that the earlier PRs are merged into `main`. If that PR's branch exists on `origin` (a session stopped in the middle of it, Local or Cloud), switch to it, read its `TASKS.md` and its `Stopped at:` line, and continue there (`docs/workflow.md`, "Moving work between Local and Cloud").
- Split the feature into PRs. Default: PR 1 is contracts, db, api and worker with their tests; PR 2 is admin and/or store and E2E. Use a single PR when the whole feature is small. A PR never leaves `main` broken or half-wired, and never ships a money path without its concurrency and idempotency tests.
- Write `TASKS.md` for this feature (replace the previous task's file): a heading per PR, one item per layer below, the wiring items from `wiring.md` that apply, and "checks, reviewer, browser check, PR and merge" at the end of each PR.
- Show the owner the PR split and the task list in a few lines, in Arabic, then **stop and wait for approval of the split**. This is the skill's only planned stop.

## 2. Build, one layer at a time
Finish a layer, run its gate, fix root causes, tick the item in `TASKS.md`, then start the next layer. Never start a layer while the previous gate fails. A gate runs the layer's own tests with `pnpm verify <files>` (paths from the root) and typechecks with `pnpm typecheck` (Turborepo replays untouched packages); when one fails, fix it and rerun only the files its summary names. Never run a whole suite at a gate.

| # | Layer | Build | Gate |
|---|---|---|---|
| 1 | contracts | Schemas and types, list query and page schemas, error codes, audit actions; pure rules (money math, transitions, pricing) with unit tests | `pnpm verify` on the changed `packages/contracts/src/**/*.test.ts`, `pnpm typecheck` |
| 2 | db | Run `/db-migration`: schema, generated migration, SQL review; shared write paths in `packages/db/src/ledger` or `orders` when the feature needs them, with concurrency tests | `pnpm verify packages/db/src/conventions.test.ts` and the changed `packages/db/src/**/*.test.ts`, migration drift (`pnpm db:generate` writes nothing) |
| 3 | api | Module, controllers (customer and `/api/admin/`), service: ownership filters, audit and jobs in the change's transaction, idempotency, rate limits, archive instead of delete, coded errors; `test/<module>.test.ts` | `pnpm verify apps/api/test/<module>.test.ts apps/api/test/architecture.test.ts`, `api` typecheck |
| 4 | worker | Jobs (`jobs/<area>/<name>.job.ts`): safe to run twice, retries with backoff, classified errors, supplier calls only through `packages/suppliers`; tests with the fake supplier and fixtures | `pnpm verify` on the job's `apps/worker/test/<area>.test.ts`, `worker` typecheck |
| 5 | bridge | `pnpm build`, then the OpenAPI export and the admin client generation (commands in `AGENTS.md`) | `admin` typecheck |
| 6 | admin / store | Admin: `features/<module>/` queries, pages, forms, thin routes, navigation, i18n keys. Store: server components and cached reads with tags, client components only for interaction, i18n keys. Loading, empty and error states everywhere | `admin`/`store` typecheck, lint, `pnpm verify` on the changed `apps/{admin,store}/src/**/*.test.ts(x)` |
| 7 | e2e | The feature's flow spec with the fake supplier, RTL screenshots (store: phone width, dark and light; admin: light and dark) | `pnpm verify apps/<store or admin>/e2e/<flow>.spec.ts` (with `--grep "<test title>"` for the new tests of a large spec); open the new screenshots and look at them. The whole suite runs in CI. |

Layers a PR does not include are skipped. Helpers that ADR 0011 says arrive with their first use are written in the layer that first needs them, in the shared place ADR 0011 names.

## 3. Close each PR
1. Walk the wiring checklist in `wiring.md` against the diff (`git diff main...HEAD --stat`).
2. Browser check, by you (the owner no longer runs acceptance steps, 2026-10-28):
   - PR with screens: apply the migrations to the dev database (`pnpm db:migrate`), start the servers with `preview_start` (`api`, `store`, `admin` in `.claude/launch.json`; the worker, which listens on no port, with `pnpm --filter @vertex-digital/worker dev` in a background shell), and walk the spec's "Acceptance" section with the fake supplier and test deposits (commands in `AGENTS.md`): phone and desktop, dark and light, console and network free of errors, RTL screenshots of each new screen. Fix what fails, with a test where one can catch it.
   - PR without screens: the endpoints and jobs are exercised by their tests; check the new endpoints once at `http://127.0.0.1:3000/api/docs`.
3. Stop the servers (the worker too), then run `pnpm verify` once (lint, typecheck, test, build, the changed E2E specs, migration and OpenAPI drift), through the `checker` to keep its output out of the context, and the `reviewer` with the spec path at the same time. Edit nothing until both are done.
4. Fix every blocking finding and every failure of step 3 together, then run `pnpm verify` once more: Turborepo replays what the fixes did not touch.
5. Tick the PR's items in `TASKS.md`, then finish the PR in the same turn without asking: follow "Finishing a task" in `AGENTS.md` (docs and `docs/ROADMAP.md`, secrets check, checks, commit, push, `gh pr create`, `gh pr merge <number> --auto --merge`, Auto-fix, the wait for the merge, the deploy when the task includes one, the report with the cleanup line and the next session's first message).

## Stop and ask when
- The spec is ambiguous in a way that changes the result, or the work needs an answer from `docs/open-questions.md`.
- The migration review in `/db-migration` finds a destructive or non-backward-compatible change.
- A command would call a live supplier or blockchain service, or move real money. Migrating the dev database, server commands, pushing the branch, the PR, its merge and the deploy need no question ("Standing approvals" in `AGENTS.md`).
- The work would go beyond the spec. Record the idea as a follow-up instead.

## Keep this skill true
If a step here or in `wiring.md` was missing, wrong or out of date, fix the file in the same PR and say so in the report under "Found".
