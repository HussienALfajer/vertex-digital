---
name: audit-group
description: Run one group of the comprehensive audit (A01–A10 in docs/audits/README.md) end to end - map the group's screens, endpoints, jobs and tables, audit every dimension (spec, backend, database, worker, frontend, UI/UX, security and fraud, performance, tests, observability, live browser test), fix every finding with a regression test, then the reviewer, the PR with auto-merge and the production deploy. Use when the owner says to start or continue an audit group, e.g. "ابدأ المجموعة A02", "ابدأ المجموعة الثانية", "start audit group 3", or "/audit-group A04".
argument-hint: <group, e.g. A02; empty for the next one>
effort: high
---

Run audit group **$ARGUMENTS**. The plan, the groups' scope, the dimensions, the severity scale, the cycle and the report template are in [docs/audits/README.md](../../../docs/audits/README.md): read it first, whole. This skill only adds the order of work and the gates; when the two disagree, fix the README in the same PR.

## 0. Pick the group
- A group ID (`A02`), a number ("الثانية", "2") or a name picks that group. Nothing named: the first group in the README's status table that is not `deployed`.
- Check the groups before it: a group still `in progress` or `merged` (not deployed) is finished first; tell the owner in one line and do that instead, unless they say otherwise.
- `TASKS.md` holding this group means a previous session stopped mid-way: continue from its first open item, on its branch.

## 1. Preconditions (stop and tell the owner if one fails)
- `main` pulled, working tree clean, no open PR from an earlier group.
- Production runs `main` (`ssh vertex "cat /srv/digital.vertexmedia.pro/current/REVISION"`); if not, deploy first (`docs/deployment.md`).
- The session runs at effort `high` (the skill sets it) on Opus.

## 2. Map, then audit (no fixes yet)
- Branch `fix/audit-a<nn>-<slug>`; status `in progress` in the README; the report file from the README's template; `TASKS.md` with the cycle's phases.
- Map the scope from the code, not from the README's list alone: every route, dialog, endpoint (`apps/api/src/modules/<module>`), job (`apps/worker/src/jobs/<area>`), table (`packages/db/src/schema`), contract, email, push or Telegram message, and E2E spec the group touches. Use `Explore` subagents for the wide reads, in parallel, and keep only their conclusions.
- Read the group's specs and ADRs (only the sections the group touches), and the `CLAUDE.md` of each folder in scope.
- Audit every dimension of the README. Record each finding in the report as found, with `file:line` and level, before any fix. Check each "known lead" against the code and mark it confirmed or dropped.
- For the security and money dimensions, also read the API tests of the module (`apps/api/test/<module>.test.ts`) to see which abuse paths are already covered, and list the missing ones as findings.

## 3. Live browser test
- Follow "Live browser test" in the README. Ask the owner once before `pnpm db:reset-local --yes` in the session (it empties the dev database).
- Start the servers with `preview_start` (`.claude/launch.json`) or `pnpm dev`, never through Bash for long-running servers when the preview tools are there.
- Test every screen of the group, every state, phone and desktop, dark and light, keyboard; read the console and network for errors. New problems go into the report as findings.

## 4. Show the owner, then fix
- One message in Arabic: counts by level, the P0 and P1 list, and every item that needs a decision (business rule, scope, an unbuilt spec item). Then continue without waiting; only the decision items wait.
- Fix P0 → P1 → P2 → P3. Each fix: root cause, a regression test that fails without it, the finding's status and test in the report, `TASKS.md` ticked. Gate: `pnpm verify <the touched test files>` and `pnpm typecheck`. Schema changes go through `/db-migration`; supplier adapter changes through `/supplier-adapter`.
- A finding outside the group's scope that is not a defect of its own flow is recorded for its group (usually A10) in the README's "Known leads", not fixed here.

## 5. Re-test, close, deploy
1. Re-run the live test on the changed screens, with screenshots.
2. `pnpm verify` through the `checker` and the `reviewer` (with the group's specs) at the same time; edit nothing while they run. Fix everything they report, verify again.
3. Complete the report (summary, findings, decisions, deferred, evidence, checks); set the README status to `merged` with the PR link in the PR itself; update the audit line in `docs/ROADMAP.md`.
4. Finish the PR as "Finishing a task" in `AGENTS.md` says (secrets check, Conventional Commit naming the finding IDs, PR, `gh pr merge --auto --merge`). Turn on the PR's Auto-fix in the desktop app.
5. When the PR is merged and CI is green: deploy `main` (`docs/deployment.md`, detached with `systemd-run`), re-run `provision.sh` if `deploy/` changed, smoke-test the group's screens on production without real money, record the deploy in `docs/deployment.md` and the README status `deployed` (carried by the next group's branch, or a small docs PR when it is the last group).
6. Report in the `AGENTS.md` format, in Arabic. "Next step" names the next group and its first message: `ابدأ المجموعة A<nn+1>` (or `/audit-group A<nn+1>`), Opus, effort `high`, a new session.

## Stop and ask when
- A finding needs a business decision, a scope change, or an answer from `docs/open-questions.md`.
- A fix needs a destructive or non-backward-compatible migration, touches real money or a live supplier or chain, or would change production data beyond the deploy.
- A P0 is found in production data (not only in code): tell the owner at once, before fixing.
