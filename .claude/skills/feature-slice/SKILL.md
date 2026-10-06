---
name: feature-slice
description: Implement an approved feature spec end to end, layer by layer (contracts → db → api/worker → bridge → admin/store → E2E), with a check gate after each layer, the reviewer, and the owner's acceptance steps. The implement step of the feature cycle, between /spec and /ship.
argument-hint: <feature id or spec path, e.g. F03>
disable-model-invocation: true
effort: medium
---

Implement **$ARGUMENTS**. This skill orders the work and names the gates; the rules for each folder stay in its `CLAUDE.md` and in ADR 0011. The wiring checklist and the files to copy from are in [wiring.md](wiring.md): read it before the first layer.

## 0. Preconditions (stop and tell the owner if one fails)
- The spec (`docs/specs/<id>-*.md`) says `Status: Approved`, and its "Open questions" block nothing this work touches. Never answer an open question yourself.
- The branch is not `main`. Name it `feat/<id>-<slice>`, e.g. `feat/f03-ledger-api`.
- The working tree is clean, and `main` is pulled.

## 1. Plan (no code)
- Read only: the spec, the ADRs it lists, `wiring.md`, and the `CLAUDE.md` of each folder you will touch. Open reference files by range, when you write the layer that needs them.
- If `TASKS.md` already holds this feature, continue from its first open PR instead of planning again. Check that the earlier PRs are merged into `main`.
- Split the feature into PRs. Default: PR 1 is contracts, db, api and worker with their tests; PR 2 is admin and/or store and E2E. Use a single PR when the whole feature is small. A PR never leaves `main` broken or half-wired, and never ships a money path without its concurrency and idempotency tests.
- Write `TASKS.md` for this feature (replace the previous feature's file): a heading per PR, one item per layer below, the wiring items from `wiring.md` that apply, and "checks, reviewer, acceptance, /ship" at the end of each PR.
- Show the owner the PR split and the task list in a few lines, in Arabic, then **stop and wait for approval**.

## 2. Build, one layer at a time
Finish a layer, run its gate through the `checker` subagent, fix root causes, tick the item in `TASKS.md`, then start the next layer. Never start a layer while the previous gate fails.

| # | Layer | Build | Gate |
|---|---|---|---|
| 1 | contracts | Schemas and types, list query and page schemas, permissions, error codes, audit actions; pure rules (money math, transitions, pricing) with unit tests | `contracts` test, root `typecheck` |
| 2 | db | Run `/db-migration`: schema, generated migration, SQL review; shared write paths in `packages/db/src/ledger` or `orders` when the feature needs them, with concurrency tests | `db` test, migration drift |
| 3 | api | Module, controllers (customer and `/api/admin/`), service: ownership filters, audit and jobs in the change's transaction, idempotency, rate limits, archive instead of delete, coded errors; `test/<module>.test.ts` | `api` test file of the module, `test/architecture.test.ts`, `api` typecheck |
| 4 | worker | Jobs (`jobs/<area>/<name>.job.ts`): safe to run twice, retries with backoff, classified errors, supplier calls only through `packages/suppliers`; tests with the fake supplier and fixtures | `worker` test, `worker` typecheck |
| 5 | bridge | `pnpm build`, then the OpenAPI export and the admin client generation (commands in `AGENTS.md`) | `admin` typecheck |
| 6 | admin / store | Admin: `features/<module>/` queries, pages, forms, thin routes, navigation, i18n keys. Store: server components and cached reads with tags, client components only for interaction, i18n keys. Loading, empty and error states everywhere | `admin`/`store` typecheck, lint, test |
| 7 | e2e | The feature's flow spec with the fake supplier, RTL screenshots (store: phone width, dark and light; admin: light and dark) | `pnpm test:e2e`; open the new screenshots and look at them |

Layers a PR does not include are skipped. Helpers that ADR 0011 says arrive with their first use are written in the layer that first needs them, in the shared place ADR 0011 names.

## 3. Close each PR
1. Walk the wiring checklist in `wiring.md` against the diff (`git diff main...HEAD --stat`).
2. Full checks once, through `checker`: lint, typecheck, test, build; add E2E when a front end or `packages/ui` changed and migration drift when db changed. `/ship` reuses passes recorded on the same tree; any later fix invalidates the record.
3. Run the `reviewer` subagent with the spec path. Fix every blocking finding, then re-run the affected gates.
4. Owner acceptance, in Arabic:
   - PR with screens: turn the spec's "Acceptance" section into numbered browser steps (`pnpm dev`, which account to sign in as, what to click, what they should see), using the fake supplier and test deposits. Ask before `pnpm db:migrate` on the dev database.
   - PR without screens: summarize the endpoints and jobs and their rules; the owner may try them at `http://127.0.0.1:<api port>/api/docs`.
   Fix what the owner reports in the same session, then repeat steps 2–3 for what changed.
5. Tick the PR's items in `TASKS.md` and hand over to `/ship`. Do not commit, push or open the PR from this skill.

## Stop and ask when
- The spec is ambiguous in a way that changes the result, or the work needs an answer from `docs/open-questions.md`.
- The migration review in `/db-migration` finds a destructive or non-backward-compatible change.
- A command changes the owner's data (`pnpm db:migrate`), leaves the machine (`git push`, `ssh`), or would call a live supplier or blockchain service.
- The work would go beyond the spec. Record the idea as a follow-up instead.

## Keep this skill true
If a step here or in `wiring.md` was missing, wrong or out of date, fix the file in the same PR and say so in the report under "Found". After the first feature ships, fill the "Patterns to copy" table in `wiring.md` with its files.
