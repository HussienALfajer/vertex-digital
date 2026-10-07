# Working method

How Vertex Digital is built with Claude Code (Opus 5.5). The method is the one that runs Vertex Hub, adapted to a system that moves money. `AGENTS.md` holds the rules agents follow; this file explains the method for the owner and for agents that need detail.

## Why it works this way

- **Context is the scarcest resource.** Every turn resends the whole conversation, and model quality drops as context fills.
- **Cost ≈ turns × context size.** The prompt cache makes re-reading cheap (cache reads cost 1/20 of fresh input) as long as it stays warm.
- **Output is ~100× the price of a cache read.** Effort level mainly controls output (thinking), so it is the main cost lever.
- **Verification enables autonomy.** With a check it can run, the agent iterates until the check passes, without supervision.
- **Knowledge lives in files, not chat.** Sessions, accounts and tools change; the repository stays.

## The feature cycle

A feature runs through separate sessions. The unit is a spec from `docs/ROADMAP.md` (`S01`…`S15`), which may group related features; `<id>` below is that spec id. Each session ends with a merged PR (or a finished deploy) and `/clear`, so the next one starts from files and git, not from a long conversation. Set the model and effort before the first message of each session.

| # | Session | Model and effort | First message | The owner | Ends with |
|---|---|---|---|---|---|
| 1 | Spec | Opus 5.5, `high` | `/spec <id>` | Answers the interview; approves the spec | The spec's PR (`docs/<id>-spec`) opened with auto-merge |
| 2 | Backend PR | Opus 5.5, `high` for money, orders, suppliers or new core tables, else `medium` | `/feature-slice <id>` | Approves the PR split and `TASKS.md`; may try the endpoints at `/api/docs` | PR 1 (contracts, db, api, worker) opened with auto-merge |
| 3 | Front-end PR | Opus 5.5, `medium` | `/feature-slice <id>` | Runs the acceptance steps in the browser (store and/or admin) | PR 2 (store/admin, E2E) opened with auto-merge; `docs/ROADMAP.md` marks the feature done |
| 4 | Phase deploy (once per phase) | Opus 5.5, `low` | `Deploy phase <n> to production` | Approves the deploy; checks the live site | Deploy done, the phase's deploy item ticked in `docs/ROADMAP.md` |

- A grouped spec usually needs more than two PRs: `/feature-slice` splits it per feature or per layer so each PR stays reviewable; the spec is done when its last PR merges.
- A small feature (about one table and one screen) does sessions 2 and 3 in one session and one PR.
- A new supplier or a supplier API change runs `/supplier-adapter <code>` in its own session at `high`.
- `/feature-slice` reads `TASKS.md` and continues from the first open PR, so a session can stop between PRs and a new one picks up. `TASKS.md` is committed with each PR.
- After each merge the owner runs the cleanup line from the report, then `/clear`.
- **Deploys happen at the end of a phase, not after each feature.** A hotfix for a bug in production is the exception, deployed when the owner asks.
- **Registration stays closed in production until the pilot** (F26): the Phase 1 and Phase 2 deploys run with admin-created test customers only, so nobody can deposit real money before there is something to buy.
- Inside session 2 or 3, use `/compact` between layers if the context grows, never in the middle of one.
- The "Next step" of every report names the next session: whether it needs `/clear`, its model and effort from this table, and its exact first message.

Steps inside a session:

1. **Spec** (`/spec`): the agent interviews the owner about the feature from `v1-scope.md` and writes `docs/specs/<id>-<name>.md` from `docs/specs/_template.md`: access, data, states, money flows, API, screens, abuse cases, edge cases, and an end-to-end acceptance check.
2. **Plan** (`/feature-slice`, first step): the agent splits the feature into PRs and writes `TASKS.md`; the owner approves before any code.
3. **Implement** (`/feature-slice`): one layer at a time, contracts → db → api/worker → bridge (OpenAPI) → admin/store → E2E, each followed by a check gate through the `checker` subagent. The wiring checklist is in `.claude/skills/feature-slice/wiring.md`.
4. **Review:** the `reviewer` subagent (fresh context) checks the branch against the spec and the rules, with a money, security and fraud checklist, and reports blocking issues only.
5. **Accept and open the PR at once:** the owner tries it in the browser; in the same turn the agent follows "Finishing a task" in `AGENTS.md`: updates `docs/ROADMAP.md`, runs only the checks that have not already passed on the same files (`scripts/check-record.mjs`), commits, pushes, opens the PR and enables auto-merge. There is no separate shipping command (owner, 2026-10-06). CI runs every check on every PR before the merge.

## How the instructions are layered

Each rule lives in one place and loads only when it is needed.

| Layer | Files | Loaded |
|---|---|---|
| Project rules | `AGENTS.md` (shared with Codex), `CLAUDE.md` (Claude-specific, imports `AGENTS.md`) | Every session |
| Folder rules | `<app or package>/CLAUDE.md` (created with the Phase 0 scaffold); the root `AGENTS.md` points other agents to them | When the agent reads a file in that folder |
| Decisions and specs | `docs/decisions/`, `docs/specs/`, `docs/product/v1-scope.md` | On demand, the parts the task needs |
| Workflows | `.claude/skills/`: `spec`, `feature-slice`, `db-migration`, `supplier-adapter` (each ends by opening its PR) | When invoked (`db-migration` also when a schema change is detected) |
| Subagents | `.claude/agents/`: `checker` (Haiku, runs checks, returns failures only), `reviewer` (Opus, fresh-context review) | In their own context; only their summary returns |
| Enforcement | Biome hook on every edit (`.claude/hooks/`), architecture and conventions tests, CI, gitleaks | Always, without costing context |
| Guard rails | `.claude/settings.json`: model and effort, permissions, reads of secrets and generated files denied | Always |

A rule that a machine can check belongs in a test or lint rule, not in prose (ADR 0011). A rule that only applies to one folder belongs in that folder's `CLAUDE.md`, not the root.

## Anatomy of a good request

- **Goal:** what to build.
- **Reference:** which spec file.
- **Scope:** what may change and what must not.
- **Finish line:** a checkable condition (e.g. "typecheck, lint and tests pass; RTL screenshot of the page attached").
- **Stop conditions:** only for owner decisions, destructive actions, and anything that spends real money.

Don't write "think hard" or "step by step": effort controls depth.

## Effort and model by task

| Task | Model | Effort |
|---|---|---|
| Ledger, orders, fulfilment, deposits, security (data model and code) | Opus 5.5 | `high`, `xhigh` for the core ledger and order model |
| Spec interviews | Opus 5.5 | `high` |
| A supplier adapter | Opus 5.5 | `high` |
| Implementing a clearly specified non-money feature | Opus 5.5 | `medium` |
| Production deploy at the end of a phase | Opus 5.5 | `low` |
| Mechanical edits (renames, translation keys, applying a pattern) | Opus 5.5 | `low` |
| Searching code, reading logs and test output | Subagent on Haiku or Sonnet | — |
| A problem that failed twice at `xhigh` | Fable 5.1, for that problem only | — |

Avoid `max` unless a gain is measured. Agent teams, fast mode and `opusplan` are not used by default.

## Session habits

1. Set model, effort and connectors at session start; don't change them mid-session.
2. Avoid pauses longer than the cache lifetime (1 hour on a subscription). Finish or wrap up a task before a long break.
3. `/clear` between unrelated tasks (`/rename` first if you may come back).
4. `/compact <what to keep>` at natural breaks; `/rewind` to abandon a failed path.
5. After two failed corrections on the same issue, `/clear` and start again with a better request.
6. Side questions: `/btw`, so they don't enter the context.
7. Disconnect connectors and plugins the project does not need. The project turns off the `ui-ux-pro-max` plugin (the identity is fixed in `brand/identity.md`); turn Hostinger DNS on only for DNS work.
8. Let the `checker` subagent run long checks, so their output never enters the main context.
9. Check `/usage` after each feature: cache share should be high; output should be small relative to the change.

## Accounts and tools

- Several Claude accounts: switch accounts **between** tasks, not in the middle of one; the prompt cache does not carry over.
- Codex reads `AGENTS.md` directly and can continue work when Claude limits are reached.
- Everything needed to resume lives in `docs/`, `TASKS.md` and git history.

## Cloud sessions

Sessions can run on the owner's machine (**Local**) or in a Claude Code cloud environment (**Cloud**, Ubuntu 24.04). Skills, subagents, hooks, `CLAUDE.md` files and settings come with the repository, and the two scripts below give a cloud session the same toolchain and databases as the owner's machine.

| Script | Runs | Does |
|---|---|---|
| `scripts/cloud-setup.sh` | Once per environment, as its setup script; the result is cached (rebuilt when the script or network list changes, or after about seven days) | Installs Node 24, pulls the `postgres:17` image and installs Chromium's system libraries |
| `scripts/cloud-session.sh` | On every cloud session start and resume (SessionStart hook in `.claude/settings.json`); exits at once outside the cloud | Starts PostgreSQL 17, `pnpm install`, creates `.env` and the dev and test databases (`db:setup-local`), migrates the dev database (`db:migrate`), installs Playwright's Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`) |

The dev database in a cloud session is disposable. No secret is needed: `.env` gets a random password on each VM.

### One-time setup (the owner, at claude.ai/code)
1. Create a cloud environment named `vertex-digital`.
2. **Network access:** Custom, with the default (Trusted) domains included, plus Playwright's browser downloads: `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`, `playwright.azureedge.net`.
3. **Setup script:** paste the whole of `scripts/cloud-setup.sh`. Paste it again whenever that file changes.
4. **Environment variables:** none.
5. The Claude GitHub App is installed on the repository (needed to clone and push).

If the hook reports "Cloud session problems", fix the environment before running checks: a check that fails for environment reasons says nothing about the code. In a cloud session `/clear` does not exist (start a new session instead), the model and effort are set with `/model` and `/effort` before the first message, and the cleanup line after a merge is for the local checkout.

What always stays local:
- **Production deploys** (`ssh`): the server's SSH key never goes into a cloud environment.
- **The owner's acceptance test in the browser:** pull the branch into the local checkout, migrate and run `pnpm dev`.
- **Anything with real secrets:** live supplier smoke tests, real chain-reader keys, the Madani font files.

## References

- Getting the most out of Opus 5.5 — https://claude.dev/blog/getting-the-most-out-of-opus-5-5/
- Prompting Claude Opus 5.5 — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
- Claude Code best practices — https://code.claude.com/docs/en/best-practices
- Claude Code memory (CLAUDE.md, AGENTS.md) — https://code.claude.com/docs/en/memory
- Claude Code costs — https://code.claude.com/docs/en/costs
