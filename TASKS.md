# TASKS — Agent workflow and CI (branch `chore/agent-workflow-and-ci`)

From the owner's review of check times, CI failures, approval prompts and the instruction files (2026-10-28).

- [x] CI: Chromium without `--with-deps` (apt took up to 13 minutes); gates skipped, not failed, on a superseded run; remote-cache plumbing removed (owner decision)
- [x] Lint: `scripts/lint.mjs` for `pnpm lint`, `lint:fix` and `pnpm verify`, so a local `.git/info/exclude` no longer hides tracked folders from Biome
- [x] `scripts/wait-merge.sh`: wait for the merge, merge a green idle PR, update a branch behind `main`
- [x] Standing approvals (owner, 2026-10-28) in `AGENTS.md` and `CLAUDE.md`; "Finishing a task" ends with the merge and the deploy
- [x] Skills: feature-slice browser check by the agent (no owner acceptance), no asks for `db:migrate`, `db:reset-local`, `ssh`; audit-group stops the dev servers before verify and records the deploy without a PR of its own
- [x] Folder `CLAUDE.md` files slimmed to rules and patterns; `pnpm verify <file>` everywhere
- [x] The 26 consistency findings: deploy rule, effort source, ADR 0011 current state, reviewer ADRs, access-test wording, IDs, stale phase text, `.env` read denies, launch.json worker entry, `E2E_FULL` bypass, Turborepo block
- [x] Found by verify: `customers.test.ts` drew its sign-in IP from 62,500 addresses that earlier runs' rows eventually shared; now a unique documentation IPv6 address
- [x] Fresh-context consistency audit of every instruction file, and its findings: superseded-aware CI gates (a cancelled head run never passes), `wait-merge.sh` without `set -e` (retries, exit 5, status contexts), rules restored in the folder files, deploy records in a small docs PR, cloud and worker steps, `docs/deployment.md` deploy log, FazerCards 400 doc matched to the code
- [x] Found by verify: the worker's `deposits.test.ts` drew reference codes that earlier runs' deposits held; it now draws again on `deposits_reference_code_unique`, as the API does
- [x] `pnpm verify`, PR, merge
