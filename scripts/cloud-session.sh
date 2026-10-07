#!/usr/bin/env bash
# Prepares a Claude Code cloud session: Node 24 on PATH, PostgreSQL 17 running, packages installed,
# `.env` with the dev and test databases. Run by the SessionStart hook in .claude/settings.json on
# every start and resume; it does nothing outside cloud sessions. The VM itself is provisioned once
# by scripts/cloud-setup.sh (the environment's setup script).
#
# Standard output reaches Claude's context, so it prints a short status only; details go to the log.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 0
LOG=/tmp/vertex-digital-cloud-session.log
NODE_DIR=/opt/node24
CONTAINER=vertex-digital-postgres
status=()
problems=()

SUDO=
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO=sudo

# Node 24 from the setup script; the image's default is older.
if [ -x "$NODE_DIR/bin/node" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
else
  problems+=("Node 24 missing at $NODE_DIR: the environment's setup script did not run (see docs/workflow.md)")
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
[ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0" >>"$CLAUDE_ENV_FILE"
status+=("node $(node --version 2>/dev/null)")

# PostgreSQL 17 in Docker, as in CI; the image's PostgreSQL 16 service is the fallback.
start_docker_postgres() {
  if ! $SUDO docker info >/dev/null 2>&1; then
    ($SUDO dockerd >/tmp/dockerd.log 2>&1 &)
    for _ in $(seq 1 30); do $SUDO docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  $SUDO docker start "$CONTAINER" >/dev/null 2>&1 ||
    $SUDO docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17 >/dev/null ||
    return 1
  for _ in $(seq 1 30); do
    $SUDO docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

start_service_postgres() {
  $SUDO service postgresql start >/dev/null 2>&1 || return 1
  for _ in $(seq 1 30); do pg_isready -h localhost >/dev/null 2>&1 && break; sleep 1; done
  $SUDO su postgres -c "psql -qc \"ALTER USER postgres PASSWORD 'postgres'\"" >/dev/null
}

if start_docker_postgres >>"$LOG" 2>&1; then
  status+=("postgres 17 (docker)")
elif start_service_postgres >>"$LOG" 2>&1; then
  status+=("postgres 16 (fallback service)")
  problems+=("PostgreSQL 17 did not start in Docker; using the image's PostgreSQL 16, while CI and production use 17")
else
  problems+=("PostgreSQL did not start; see $LOG")
fi

run() {
  local label=$1
  shift
  if "$@" >>"$LOG" 2>&1; then status+=("$label"); else problems+=("$label failed; see $LOG"); fi
}

run "packages installed" pnpm install --frozen-lockfile
# Creates .env from .env.example with a random password, then the role and both databases.
run "dev and test databases" env PGPASSWORD=postgres node scripts/setup-local-db.mjs
# The dev database of a cloud session is disposable; tests migrate the test database themselves.
# A fresh clone has no build output: packages/db compiles against the built contracts, so the
# packages it depends on are built first (cached by Turborepo on later sessions).
run "db dependencies built" pnpm turbo run build --filter=@vertex-digital/db^... --output-logs=errors-only
run "dev database migrated" pnpm db:migrate
# Chromium for the E2E tests (pnpm test:e2e), at the Playwright version in the lockfile; its
# system libraries come from scripts/cloud-setup.sh. A no-op when it is already there.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
[ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright" >>"$CLAUDE_ENV_FILE"
$SUDO mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" && $SUDO chmod 777 "$PLAYWRIGHT_BROWSERS_PATH"
run "chromium for playwright" pnpm --filter @vertex-digital/store exec playwright install chromium

summary=$(printf '%s, ' "${status[@]}")
echo "Cloud session ready: ${summary%, }."
if [ ${#problems[@]} -gt 0 ]; then
  echo "Cloud session problems (tell the owner before running checks):"
  printf -- '- %s\n' "${problems[@]}"
fi
exit 0
