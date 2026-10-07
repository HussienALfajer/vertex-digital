---
name: spec
description: Interview the owner about a V1 feature and write its spec to docs/specs/. First step of the feature cycle, before any plan or code.
argument-hint: <feature id or name, e.g. F03>
disable-model-invocation: true
effort: high
---

Write the spec for **$ARGUMENTS**.

## 1. Read (only this)
- The feature's section of `docs/product/v1-scope.md`: find its heading with a search, then read that section and every automation (A01–A15) that mentions it.
- `docs/open-questions.md`, and the ADRs the feature touches (`docs/decisions/README.md` lists them; money features always read 0003, 0004 or 0006).
- Specs it depends on in `docs/specs/`, and the relevant tables in `packages/db/src/schema/` and `packages/contracts/src/` (permissions, error codes, money).
- The template: `docs/specs/_template.md`.

## 2. Interview the owner
- In Arabic, with the question tool, at most 4 questions per round, each with concrete options and your recommendation first.
- Ask only what changes the result: business rules, limits and amounts, states and transitions, who can do what, required fields, what the customer sees, edge cases, notifications. Don't ask what the scope, an ADR or the code already answers.
- For money features, settle explicitly: every money flow (who pays, which accounts, when it reverses), limits, rounding direction, and what happens on timeouts and races.
- Open questions that block this feature (see "Needed before" in `docs/open-questions.md`) are asked here; record the answers. Never fill one in yourself.
- Stop when every template section, including "Money flows" and "Abuse and fraud", can be written without guessing.

## 3. Write
- `docs/specs/<id>-<kebab-name>.md` (for example `docs/specs/S02-wallet-ledger.md`; `<id>` is the spec id from `docs/ROADMAP.md`, which lists the features it covers), in English, following the template. Mark anything still undecided under "Open questions" instead of guessing.
- Record answered open questions in `docs/open-questions.md` (move them to Resolved with the date). A business decision that shapes the system also gets an ADR.
- Mark the feature `[~]` in `docs/ROADMAP.md`.

## 4. Hand over
Summarize the spec for the owner in Arabic, in a few lines: what V1 of the feature does, the main rules and money flows, what stays open. Revise it until the owner approves, then set `Status: Approved` and, in the same turn, open the spec's PR with auto-merge on branch `docs/<id>-spec`, following "Finishing a task" in `AGENTS.md`. The next session starts `/feature-slice <id>`.
