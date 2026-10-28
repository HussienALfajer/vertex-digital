# TASKS — Local/Cloud handoff rules (branch `docs/cloud-handoff`, no spec)

The owner runs one spec's PRs sometimes locally, sometimes in the cloud. Make the handoff explicit so a cloud session can always continue.

- [x] Repository state checked on 2026-10-28: every branch merged into `main`, no open PR, no stash or extra worktree, local `main` equals `origin/main`
- [x] Production runs `c982286` (audit A10); `main` adds only docs, tests, CI and scripts since, so no runtime deploy is pending
- [x] `docs/workflow.md`: "Moving work between Local and Cloud" (between PRs, in the middle of a PR with a `Stopped at:` line, local-only steps)
- [x] `AGENTS.md` and `/feature-slice`: point to it; resume from a pushed branch
- [x] PR and merge
