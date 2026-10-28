@AGENTS.md

# Claude Code specifics

## Model and effort

- Default: Opus 5.5 at `medium` (`.claude/settings.json`). The effort for each kind of work is the table in `docs/workflow.md` ("Effort and model by task"): `high` for specs, money, orders, fulfilment, suppliers, new core tables, security and audits; `low` for mechanical edits.
- Set the model and effort at session start. Don't switch models mid-session: it drops the prompt cache. A skill may set the effort of its own work in its frontmatter.
- If the same problem fails twice at `xhigh`, say so and suggest Fable 5.1 for that problem only.

## Standing approvals in the desktop app

`AGENTS.md` ("How to work", "Finishing a task") lists what needs no approval (owner, 2026-10-28). They override the app's defaults of asking before a commit or push, offering Auto-fix instead of turning it on, and not watching CI:

- After opening the PR with auto-merge, turn on its Auto-fix at once (`mcp__ccd_pr__get_status`, `mcp__ccd_pr__bind_pr` when it is not bound, then `mcp__ccd_pr__set_monitor`), then wait for the merge with `bash scripts/wait-merge.sh <number>` in the background and carry on from its notification (the deploy, the report).
- Never put a standing approval in a closing box's question or a question card: a closing box asks only for a decision that belongs to the owner (scope, business rules, prices, `docs/open-questions.md`), or carries the recap alone.
- An Auto-fix event about a review comment that asks for no change (a bot's summary) needs no commit.

## Delegation

- `checker` subagent (Haiku): runs `pnpm verify` (the branch, or the test files you name) and returns its summary. `pnpm verify` already prints only a summary, so run it yourself when you wait for the result anyway; use the checker to keep a long run out of the main context, for example while the `reviewer` reads the branch. Stop the dev servers first (`preview_stop`, the background worker, or `pnpm dev`): a whole-branch run refuses while the API, store or panel listens. Edit nothing while a check runs, and start no second one (the `test-guard` hook refuses it). Give a foreground run a Bash timeout of 600000 ms, or run it in the background and wait for its notification.
- `reviewer` subagent (Opus, fresh context): reviews the branch against its spec and the conventions, with extra focus on money, security and fraud; blocking issues only. Use it at the review step of every feature, adapter and audit group.
- Built-in `Explore` subagent: broad searches across many files, when only the conclusion is needed.

## Skills

- `/spec <id>`: interview the owner, then write `docs/specs/<id>-<name>.md`.
- `/feature-slice <id>`: implement an approved spec layer by layer (contracts → db → api/worker → bridge → admin/store → E2E) with a check gate per layer, the reviewer and its own browser check, then the PR, the merge and, when asked, the deploy ("Finishing a task" in `AGENTS.md`).
- `/db-migration`: change the schema, generate and review the migration, test it.
- `/supplier-adapter <supplier>`: add or change a supplier adapter in `packages/suppliers` with recorded fixtures, error mapping and webhook verification.
- `/audit-group <A01…A10>`: re-audit one group of the comprehensive audit (`docs/audits/README.md`; all ten groups were deployed by 2026-10-28): map, audit every dimension, live browser test, fix every finding with a regression test, reviewer, PR, merge, production deploy.
- Every skill ends with "Finishing a task" in `AGENTS.md`; there is no separate shipping skill.

## Context hygiene

- One feature or task per session. Suggest `/clear` when the owner moves to unrelated work.
- Don't load all of `docs/` up front. Read what the current task needs.
- Folder rules load on their own: each app and package (and `deploy/`) has a short `CLAUDE.md` that Claude Code reads when you open a file there. Keep them short: rules and patterns, never history.

## Feature workflow

`/spec` (own session, `high`, ends with the spec merged) → `/feature-slice` (one session per PR: plan, implement, `reviewer`, browser check, then the PR merged and `docs/ROADMAP.md` updated). Deploys follow the rule in `docs/workflow.md` ("When a deploy happens"). Sessions, effort and first messages: `docs/workflow.md`.

## Compaction

When compacting, keep: the current feature and its spec path, files changed, failing checks with their exact commands, the open PR and its wait, open decisions, and the state of `TASKS.md`.
