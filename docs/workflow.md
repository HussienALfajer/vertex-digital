# Working method

How Vertex Digital is built with Claude Code (Opus 5.5). The method is the one that runs Vertex Hub, adapted to a system that moves money. `AGENTS.md` holds the rules agents follow; this file explains the method for the owner and for agents that need detail.

## Why it works this way

- **Context is the scarcest resource.** Every turn resends the whole conversation, and model quality drops as context fills.
- **Cost ≈ turns × context size.** The prompt cache makes re-reading cheap (cache reads cost 1/20 of fresh input) as long as it stays warm.
- **Output is ~100× the price of a cache read.** Effort level mainly controls output (thinking), so it is the main cost lever.
- **Verification enables autonomy.** With a check it can run, the agent iterates until the check passes, without supervision.
- **Knowledge lives in files, not chat.** Sessions, accounts and tools change; the repository stays.

## The feature cycle

A feature runs through separate sessions. The unit is a spec from `docs/ROADMAP.md` (`S01`, `S02`, …), which may group related features; `<id>` below is that spec id. Each session ends with its PR merged (or a finished deploy) and `/clear`, so the next one starts from files and git, not from a long conversation. Set the model and effort before the first message of each session.

| # | Session | Model and effort | First message | The owner | Ends with |
|---|---|---|---|---|---|
| 1 | Spec | Opus 5.5, `high` | `/spec <id>` | Answers the interview; approves the spec | The spec's PR (`docs/<id>-spec`) merged |
| 2 | Backend PR | Opus 5.5, `high` for money, orders, suppliers or new core tables, else `medium` | `/feature-slice <id>` | Approves the PR split and `TASKS.md`; may try the endpoints at `/api/docs` | PR 1 (contracts, db, api, worker) merged |
| 3 | Front-end PR | Opus 5.5, `medium` | `/feature-slice <id>` | Nothing required; may try the screens once merged | PR 2 (store/admin, E2E) merged; `docs/ROADMAP.md` marks the feature done |
| 4 | Phase deploy | Opus 5.5, `low` | `Deploy phase <n> to production` | May check the live site | Deploy done, the phase's deploy item ticked in `docs/ROADMAP.md` |

- A grouped spec usually needs more than two PRs: `/feature-slice` splits it per feature or per layer so each PR stays reviewable; the spec is done when its last PR merges.
- A small feature (about one table and one screen) does sessions 2 and 3 in one session and one PR.
- A new supplier or a supplier API change runs `/supplier-adapter <code>` in its own session at `high`.
- `/feature-slice` reads `TASKS.md` and continues from the first open PR, so a session can stop between PRs and a new one picks up. `TASKS.md` is committed with each PR, and the next session may run Local or Cloud ("Moving work between Local and Cloud" below).
- After each merge the owner runs the cleanup line from the report, then `/clear`.
- **When a deploy happens:** when the task includes one: the owner asks for it, an audit group, a fix of a production bug, or the end of a phase. Other feature PRs wait for the next deploy. A deploy needs no approval (`AGENTS.md`, "How to work").
- **Registration stays closed in production until the pilot** (F26): the Phase 1 and Phase 2 deploys run with admin-created test customers only, so nobody can deposit real money before there is something to buy.
- Inside session 2 or 3, use `/compact` between layers if the context grows, never in the middle of one.
- The "Next step" of every report names the next session: whether it needs `/clear`, its model and effort from this table, and its exact first message.

Steps inside a session:

1. **Spec** (`/spec`): the agent interviews the owner about the feature from `v1-scope.md` and writes `docs/specs/<id>-<name>.md` from `docs/specs/_template.md`: access, data, states, money flows, API, screens, abuse cases, edge cases, and an end-to-end acceptance check.
2. **Plan** (`/feature-slice`, first step): the agent splits the feature into PRs and writes `TASKS.md`; the owner approves the split before any code.
3. **Implement** (`/feature-slice`): one layer at a time, contracts → db → api/worker → bridge (OpenAPI) → admin/store → E2E, each followed by a check gate on the layer's own tests (`pnpm verify <files>`, `docs/testing.md`). The wiring checklist is in `.claude/skills/feature-slice/wiring.md`.
4. **Review:** the `reviewer` subagent (fresh context) checks the branch against the spec and the rules, with a money, security and fraud checklist, and reports blocking issues only.
5. **Browser check, then the PR at once:** the agent walks the spec's "Acceptance" section in the browser itself (fake supplier, test deposits, RTL screenshots) and fixes what it finds; in the same turn it follows "Finishing a task" in `AGENTS.md`: updates `docs/ROADMAP.md`, runs `pnpm verify` again if anything changed since its last green run (Turbo's cache replays every task whose inputs did not change), commits, pushes, opens the PR with auto-merge and Auto-fix, and waits for the merge. Nothing in it waits for the owner (owner, 2026-10-28). CI runs every check on every PR before the merge (the full E2E suite over four shards); a PR that changes only Markdown outside `brand/` skips them.

## The audit cycle

Before the pilot the whole product was audited in ten groups, A01 to A10 (`docs/audits/README.md`: scope, order, dimensions, severity, report template); all ten were deployed by 2026-10-28, and the skill stays for re-auditing a group. One group per session, Opus 5.5 at `high`; the first message is `ابدأ المجموعة A<nn>` or `/audit-group A<nn>`. The `audit-group` skill maps the group, audits every dimension, tests it live in the browser, fixes every finding with a regression test, runs the `reviewer`, opens the PR with auto-merge, waits for the merge and deploys `main` to production. Each group's report is `docs/audits/A<nn>-<slug>.md`; decisions it raises go to `docs/open-questions.md`.

## How the instructions are layered

Each rule lives in one place and loads only when it is needed.

| Layer | Files | Loaded |
|---|---|---|
| Project rules | `AGENTS.md` (shared with Codex), `CLAUDE.md` (Claude-specific, imports `AGENTS.md`) | Every session |
| Folder rules | `<app or package>/CLAUDE.md`: layout, local rules and the patterns to copy, short; the root `AGENTS.md` points other agents to them | When the agent reads a file in that folder |
| Decisions and specs | `docs/decisions/`, `docs/specs/`, `docs/product/v1-scope.md` | On demand, the parts the task needs |
| Workflows | `.claude/skills/`: `spec`, `feature-slice`, `db-migration`, `supplier-adapter`, `audit-group` (each ends with "Finishing a task": PR, merge, deploy when included) | When invoked (`db-migration` also when a schema change is detected) |
| Subagents | `.claude/agents/`: `checker` (Haiku, runs `pnpm verify` and returns its summary), `reviewer` (Opus, fresh-context review) | In their own context; only their summary returns |
| Enforcement | Biome hook on every edit and the test guard on every shell command (`.claude/hooks/`: one test run at a time, no whole E2E suite locally, no `timeout` around tests), architecture and conventions tests, CI, gitleaks | Always, without costing context |
| Guard rails | `.claude/settings.json`: model and effort, permissions, reads of `.env` files, keys and generated files denied | Always |

A rule that a machine can check belongs in a test or lint rule, not in prose (ADR 0011). A rule that only applies to one folder belongs in that folder's `CLAUDE.md`, not the root.

## Anatomy of a good request

- **Goal:** what to build.
- **Reference:** which spec file.
- **Scope:** what may change and what must not.
- **Finish line:** a checkable condition (e.g. "`pnpm verify` passes; RTL screenshot of the page attached").
- **Stop conditions:** only for owner decisions, destructive actions, and anything that spends real money.

Don't write "think hard" or "step by step": effort controls depth.

## Effort and model by task

| Task | Model | Effort |
|---|---|---|
| Ledger, orders, fulfilment, deposits, security (data model and code) | Opus 5.5 | `high`, `xhigh` for the core ledger and order model |
| Spec interviews | Opus 5.5 | `high` |
| An audit group (`/audit-group`) | Opus 5.5 | `high` |
| A supplier adapter | Opus 5.5 | `high` |
| Implementing a clearly specified non-money feature | Opus 5.5 | `medium` |
| A production deploy in a session of its own | Opus 5.5 | `low` |
| Mechanical edits (renames, translation keys, applying a pattern) | Opus 5.5 | `low` |
| Searching code, reading logs and test output | Subagent on Haiku or Sonnet | — |
| A problem that failed twice at `xhigh` | Fable 5.1, for that problem only | — |

Avoid `max` unless a gain is measured. Agent teams, fast mode and `opusplan` are not used by default.

## Session habits

1. Set model, effort and connectors at session start; don't change the model mid-session (it drops the prompt cache). A skill may set the effort of its own work in its frontmatter.
2. Avoid pauses longer than the cache lifetime (1 hour on a subscription). Finish or wrap up a task before a long break.
3. `/clear` between unrelated tasks (`/rename` first if you may come back).
4. `/compact <what to keep>` at natural breaks; `/rewind` to abandon a failed path.
5. After two failed corrections on the same issue, `/clear` and start again with a better request.
6. Side questions: `/btw`, so they don't enter the context.
7. Disconnect connectors and plugins the project does not need. The project turns off the `ui-ux-pro-max` plugin (the identity is fixed in `brand/identity.md`); turn Hostinger DNS on only for DNS work.
8. Run checks with `pnpm verify`: it prints a short summary and keeps the whole output in `.verify/`, so long output never enters the context. Delegate a long run to the `checker` when something else can go on meanwhile (the reviewer), never edits.
9. Check `/usage` after each feature: cache share should be high; output should be small relative to the change.

## Accounts and tools

- Several Claude accounts: switch accounts **between** tasks, not in the middle of one; the prompt cache does not carry over.
- Codex reads `AGENTS.md` directly and can continue work when Claude limits are reached.
- Everything needed to resume lives in `docs/`, `TASKS.md` and git history.

## Cloud sessions

Sessions can run on the owner's machine (**Local**) or in a Claude Code cloud environment (**Cloud**, Ubuntu 24.04). Skills, subagents, hooks, `CLAUDE.md` files and settings come with the repository, and the two scripts below give a cloud session the same toolchain and databases as the owner's machine.

| Script | Runs | Does |
|---|---|---|
| `scripts/cloud-setup.sh` | Not run directly: the repository's own reference for what its VM needs. The shared `vertex` environment's setup script is a superset of it | Installs Node 24, pulls the `postgres:17` image and installs Chromium's system libraries |
| `scripts/cloud-session.sh` | On every cloud session start and resume (SessionStart hook in `.claude/settings.json`); exits at once outside the cloud | Starts PostgreSQL 17 (or reuses a server that already answers on `127.0.0.1:5432`, password `postgres`), `pnpm install`, creates `.env` and the dev and test databases (`db:setup-local`), builds the packages `packages/db` depends on, migrates the dev database (`db:migrate`), installs Playwright's Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`) |

The dev database in a cloud session is disposable. No secret is needed: `.env` gets a random password on each VM.

### The shared `vertex` environment

All five Vertex repositories use one cloud environment named `vertex`, kept by the owner at claude.ai/code. Its setup script covers `scripts/cloud-setup.sh`: Node 24 at `/opt/node24` (default on `PATH`) with Corepack and pnpm, Docker with `postgres:17` and `axllent/mailpit`, Playwright's Chromium with its system libraries in `/opt/ms-playwright`, `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` and `NODE_OPTIONS=--max-old-space-size=6144`. **Network access** is Full, which this repository accepts. When `scripts/cloud-setup.sh` changes, the owner carries the change into the shared script.

The shared script also installs `vertex-session [repo-dir]`: it starts one PostgreSQL 17 container, `vertex-postgres`, on `127.0.0.1:5432` (`postgres`/`postgres`) and prepares every Vertex repository it finds. In a session with several repositories, repository hooks do not run, so run `vertex-session` first. In a single-repository session the hook runs `scripts/cloud-session.sh`, which reuses that server when it is already up.

If the hook reports "Cloud session problems", fix the environment before running checks: a check that fails for environment reasons says nothing about the code. In a cloud session `/clear` does not exist (start a new session instead), the model and effort are set with `/model` and `/effort` before the first message, and the cleanup line after a merge is for the local checkout.

Cloud limits:
- `gh pr create` is refused in a cloud session: push the branch, the owner presses **Create PR**, then auto-merge is turned on as in "Finishing a task".
- `pnpm db:seed-local` does not work in the cloud: it needs the production catalog snapshot, copied over SSH (`scripts/pull-catalog-snapshot.sh`).
- The Claude GitHub App must be installed on the repository (needed to clone and push).

### Moving work between Local and Cloud

One spec often runs some PRs locally and others in the cloud. The only shared state is GitHub, so everything the next session needs is committed and pushed before a session ends:

- `TASKS.md` is tracked (never git-ignored). Its first line names the task, the spec path and the branch; each PR's heading says whether it is merged, open (its number) or not started.
- **Between PRs:** nothing extra; the merged PR carried `TASKS.md`. The next session pulls `main` and continues from the first open PR.
- **In the middle of a PR:** tick what is done in `TASKS.md`, add a line `Stopped at: <what is half done, the next step, any failing check and its command>`, commit everything with `chore: wip <topic>` (never `.env` or local data) and push the branch without opening the PR. The next session runs `git fetch && git switch <branch>` (the branch named in `TASKS.md` on that branch; `git branch -r` lists it), reads `TASKS.md` and continues; the wip commits stay in the PR, which is merged with a merge commit, never squashed.
- **Local-only steps** (the list below) are written in `TASKS.md` as items for a local session, so a cloud session leaves them open instead of skipping them silently.
- Never leave work only in a local stash, an uncommitted tree or a local-only file: `CLAUDE.local.md`, `TASKS.local.md`, `.env` and `storage/` never reach the cloud.

What always stays local:
- **Production deploys** (`ssh`): the server's SSH key never goes into a cloud environment.
- **A browser test against the full local store** (`pnpm db:seed-local` needs the production catalog snapshot over SSH).
- **Anything with real secrets:** live supplier checks, real chain-reader keys, the Madani font files.

## References

- Getting the most out of Opus 5.5 — https://claude.dev/blog/getting-the-most-out-of-opus-5-5/
- Prompting Claude Opus 5.5 — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
- Claude Code best practices — https://code.claude.com/docs/en/best-practices
- Claude Code memory (CLAUDE.md, AGENTS.md) — https://code.claude.com/docs/en/memory
- Claude Code costs — https://code.claude.com/docs/en/costs
