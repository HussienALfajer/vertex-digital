#!/usr/bin/env bash
# Waits for a pull request opened with auto-merge to land on main, so a session carries on (the
# deploy, the report) without asking the owner to come back after the merge ("Finishing a task" in
# AGENTS.md). Run it in the background and act on its exit code:
#   0  merged (prints the merge commit)
#   1  closed without a merge
#   2  still open after the time limit (prints the checks)
#   3  a check failed: fix it on the branch, push, and wait again
#   4  merge conflict with main: merge main into the branch, push, and wait again
#   5  GitHub could not be reached for five minutes
# Green checks with auto-merge idle get a plain merge (`--merge`, never squash or rebase). A branch
# behind main is brought up to date with a merge commit on GitHub, as branch protection requires:
# run `git pull --no-rebase` before the next push to it.
#   bash scripts/wait-merge.sh <pr number> [minutes, default 60]
set -uo pipefail

pr="${1:?usage: bash scripts/wait-merge.sh <pr number> [minutes]}"
minutes="${2:-60}"
deadline=$((SECONDS + minutes * 60))
idle=0
updated=""
unreachable_since=""

# One line of tab-separated fields: state, merge state, failed checks, unfinished checks. Check runs
# report status and conclusion; commit statuses (other apps) report a state.
read_pr() {
  gh pr view "$pr" --json state,mergeStateStatus,statusCheckRollup --jq '
    [.state, .mergeStateStatus,
     ([.statusCheckRollup[] | select(
        (.conclusion // "" | test("^(FAILURE|TIMED_OUT|CANCELLED|STARTUP_FAILURE|ACTION_REQUIRED)$"))
        or (.state // "" | test("^(FAILURE|ERROR)$")))] | length),
     ([.statusCheckRollup[] | select(
        (.__typename == "CheckRun" and .status != "COMPLETED")
        or (.__typename == "StatusContext" and (.state == "PENDING" or .state == "EXPECTED")))] | length)]
    | @tsv'
}

while true; do
  if ! line=$(read_pr) || [ -z "$line" ]; then
    unreachable_since="${unreachable_since:-$SECONDS}"
    if [ $((SECONDS - unreachable_since)) -ge 300 ]; then
      echo "PR #$pr: GitHub could not be reached for five minutes."
      exit 5
    fi
    sleep 30
    continue
  fi
  unreachable_since=""
  IFS=$'\t' read -r state merge failed pending <<<"$line"

  case "$state" in
    MERGED)
      echo "PR #$pr merged: $(gh pr view "$pr" --json mergeCommit --jq .mergeCommit.oid)"
      exit 0
      ;;
    CLOSED)
      echo "PR #$pr was closed without a merge."
      exit 1
      ;;
  esac
  if [ "$failed" -gt 0 ]; then
    echo "PR #$pr: $failed check(s) failed."
    gh pr checks "$pr"
    exit 3
  fi
  case "$merge" in
    DIRTY)
      echo "PR #$pr conflicts with main."
      exit 4
      ;;
    BEHIND)
      # Once: GitHub reports BEHIND for a while after the update.
      if [ -z "$updated" ] && gh pr update-branch "$pr"; then updated=yes; fi
      ;;
    CLEAN)
      # Auto-merge normally merges within seconds of the last green check.
      if [ "$pending" -eq 0 ]; then idle=$((idle + 1)); else idle=0; fi
      if [ "$idle" -ge 2 ]; then gh pr merge "$pr" --merge; fi
      ;;
    *)
      idle=0
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "PR #$pr is not merged after $minutes minutes (state $state, $merge)."
    gh pr checks "$pr"
    exit 2
  fi
  sleep 30
done
