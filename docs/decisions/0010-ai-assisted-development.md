# 0010 — Claude Code (Opus 5.5) as the primary developer; AGENTS.md shared with Codex

Status: Accepted · Date: 2026-10-06

## Context
The system is built by the owner working with Claude Code (Opus 5.5) in the desktop app, across several accounts, with Codex available as a fallback. The same method already runs Vertex Hub, the owner's other project, and is reused here. Knowledge must survive session resets, account switches and tool switches. This project moves money, so the method adds checks aimed at money, security and fraud.

## Decision
- **`AGENTS.md`** holds all shared project instructions (read directly by Codex).
- **`CLAUDE.md`** imports it with `@AGENTS.md` and adds Claude-specific guidance only. An import is used instead of a symlink because symlinks are unreliable on Windows and in git.
- Project knowledge lives in files (`docs/`), not in chat history.
- Deterministic rules are enforced with hooks, tests and CI; `AGENTS.md`/`CLAUDE.md` hold guidance; repeatable workflows are skills (`spec`, `feature-slice`, `db-migration`, `supplier-adapter`, `ship`); checks and reviews run in subagents (`checker`, `reviewer`).
- The `reviewer` has an explicit money, security and fraud checklist (ledger invariants, idempotency, state transitions, margin guard, authorization, abuse limits).
- Work follows the feature cycle in `docs/workflow.md`.
- Agents never see real secrets or customer data: `.env` reads are denied in `.claude/settings.json`, supplier fixtures are sanitized, and live supplier or blockchain calls with real money need the owner's approval.

## Consequences
- `AGENTS.md` and `CLAUDE.md` stay short (target under 200 lines combined) and are pruned when behavior shows a rule is not needed.
- Switching accounts or tools happens between tasks, not mid-task, because the prompt cache does not carry over.
