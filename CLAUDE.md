@AGENTS.md

# Claude Code specifics

## Model and effort

- Default: Opus 5.5 at `medium` (set in `.claude/settings.json`). Use `high` for specs, data-model, money, fulfilment and security work; `low` for mechanical edits (renames, applying a known pattern, translation keys).
- Set model and effort at session start. Don't switch models mid-session: it drops the prompt cache.
- If the same problem fails twice at `xhigh`, say so and suggest switching to Fable 5.1 for that problem only.

## Delegation

- `checker` subagent (Haiku): runs typecheck, lint and tests and returns only the failures. Use it instead of reading long check output in the main session.
- `reviewer` subagent (Opus, fresh context): reviews the branch against its spec and the conventions, with extra focus on money, security and fraud; blocking issues only. Use it at the review step of every feature.
- Built-in `Explore` subagent: broad searches across many files, when only the conclusion is needed.

## Skills

- `/spec <feature>`: interview the owner, then write `docs/specs/<feature>.md`.
- `/feature-slice <feature>`: implement an approved spec layer by layer (contracts → db → api/worker → bridge → admin/store → E2E) with a check gate per layer, the reviewer and the owner's acceptance steps; stops before `/ship`.
- `/db-migration`: change the schema, generate and review the migration, test it.
- `/supplier-adapter <supplier>`: add or change a supplier adapter in `packages/suppliers` with recorded fixtures, error mapping and webhook verification.
- `/ship`: final checks, commit, PR with auto-merge, final report.

## Context hygiene

- One feature or task per session. Suggest `/clear` when the owner moves to unrelated work.
- Don't load all of `docs/` up front. Read what the current task needs.
- Folder rules load on their own: each app and package (and `deploy/`) has a `CLAUDE.md` that Claude Code reads when you open a file there.

## Feature workflow

`/spec` (own session, `high`) → `/feature-slice` (one session per PR: plan, implement, `reviewer`, owner acceptance) → `/ship` (updates `docs/ROADMAP.md`). Production deploys happen once per phase, in their own session. Sessions, effort and first messages: `docs/workflow.md`.

## Compaction

When compacting, keep: the current feature and its spec path, files changed, failing checks with their exact commands, open decisions, and the state of `TASKS.md`.
