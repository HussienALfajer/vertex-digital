---
name: ship
description: Finish a change — full checks, docs, commit, push, pull request with auto-merge, and the final report.
argument-hint: [short summary of the change]
disable-model-invocation: true
---

Ship the current branch. Stop and report at the first step that fails.

1. **Branch:** never ship from `main`. If on `main`, create a branch named by type (`feat/`, `fix/`, `refactor/`, `chore/`, `docs/`). `TASKS.md` has no open items for this change.
2. **Docs:** update `docs/ROADMAP.md` when a feature or roadmap item is done, and any doc the change made stale (`docs/architecture.md`, a folder `CLAUDE.md`, `docs/open-questions.md`, the commands table in `AGENTS.md`).
3. **Secrets:** `git status` and `git diff --stat` show no `.env`, key, receipt image, customer data or real supplier response; fixtures are sanitized.
4. **Checks:** the required set is lint, typecheck, test and build, plus `e2e` when `apps/store`, `apps/admin` or `packages/ui` changed and `drift` when `packages/db` changed (against `main`). Run `node scripts/check-record.mjs status <required…>` first:
   - `docs-only: yes` (every change is a Markdown file outside `brand/`): run no checks; CI still runs all of them before the merge.
   - Otherwise run only the checks marked `needed`, through the `checker` subagent, which records what passes. A check marked `recorded` already passed on this exact tree; don't repeat it.
   - Before the scaffold exists (no `package.json`), there are no checks to run; say so.
   Everything must pass. Fix root causes, then run the failing check again. Report which checks ran and which were reused from the record.
5. **Review:** for a feature, the `reviewer` subagent has run and its blocking findings are fixed.
6. **Commit:** stage the intended files only. Conventional Commit subject; body says what and why. End the message with the session's attribution line.
7. **Pull request:** `git push -u origin <branch>`, then `gh pr create --base main` with a body of `## Summary` (what and why, in bullets) and `## Test plan` (the checks, as ticked boxes, each marked as run now or reused from the record on the same tree; for docs only, "documentation only, CI runs the checks"), ending with the session's attribution line. Then `gh pr merge <number> --auto --merge`, never squash or rebase.
8. **Report** in the format from `AGENTS.md`, in Arabic. Put the PR link under Changed, and end "Needs from you" with the cleanup line:
   `cd D:\vertex-digital; git switch main; git pull --ff-only; git branch -d <branch>`
   End with "Next step" as `AGENTS.md` requires: whether the next session needs `/clear`, its model and effort (`docs/workflow.md`), and its exact first message in a code block.

$ARGUMENTS
