#!/usr/bin/env bash
# Deploys a commit of Vertex Digital as an atomic release (ADR 0009). Runs as the `vertexdigital`
# user, started by /usr/local/bin/vertexdigital-deploy (root), which always runs the latest copy
# of this script from origin/main.
#
#   deploy.sh [<git ref>]       build and switch to a release (default: origin/main)
#   deploy.sh rollback          switch back to the previous release (migrations are not reverted)
#   deploy.sh restore <release> restore the database snapshot taken before that release migrated
#
# Nothing touches the running release until the new one is built, the database is backed up
# and migrated. If the new release fails its health checks (API, store, worker heartbeat), the
# previous one is restored and the failed release removed.
set -euo pipefail
umask 022

SITE_DIR=/srv/digital.vertexmedia.pro
REPO="$SITE_DIR/repo.git"
RELEASES="$SITE_DIR/releases"
SHARED="$SITE_DIR/shared"
CURRENT="$SITE_DIR/current"
ECOSYSTEM="$CURRENT/deploy/ecosystem.config.cjs"
API_HEALTH_URL="http://127.0.0.1:3060/api/health"
STORE_URL="http://127.0.0.1:3061/"
WORKER_NAME=production
KEEP_RELEASES=5
KEEP_DB_SNAPSHOTS=10

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export TURBO_TELEMETRY_DISABLED=1
export NEXT_TELEMETRY_DISABLED=1
export CI=1

log() { printf '\033[1m[deploy %s]\033[0m %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ "$(id -un)" = vertexdigital ] || fail "run as vertexdigital (use /usr/local/bin/vertexdigital-deploy)"
exec 9>"$SITE_DIR/.deploy.lock"
flock -n 9 || fail "another deploy is running"

# The owner role's URL (ADR 0014) never enters shared/.env, which the apps load, nor this
# script's exported environment, which `pm2 --update-env` would copy into the apps: the root
# wrapper opens /etc/vertexdigital/owner.env (root, 600) on file descriptor 3, and it is read
# here into an unexported variable, passed only to the migrate, dump and restore commands.
[ -e /dev/fd/3 ] || fail "run through /usr/local/bin/vertexdigital-deploy (it passes the owner credentials)"
OWNER_URL=$(sed -n 's/^DATABASE_OWNER_URL=//p' <&3 | tail -1)
exec 3<&-
[ -n "$OWNER_URL" ] || fail "DATABASE_OWNER_URL is missing from /etc/vertexdigital/owner.env"

# One value of shared/.env, without sourcing it: sourcing would export NODE_ENV=production, and
# pnpm then skips the devDependencies the build needs.
env_value() { sed -n "s/^$1=//p" "$SHARED/.env" | tail -1; }
APP_URL=$(env_value DATABASE_URL)
[ -n "$APP_URL" ] || fail "DATABASE_URL is missing from $SHARED/.env"

# libpq reads the password from the environment of psql/pg_dump/pg_restore only: other users on
# the server can read process arguments, never another user's environment.
password_of() { URL="$1" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.URL).password))'; }
# The connection string without its password, safe to pass as an argument.
target_of() { URL="$1" node -e 'const u = new URL(process.env.URL); u.password = ""; process.stdout.write(u.href)'; }
OWNER_PASSWORD=$(password_of "$OWNER_URL")
OWNER_TARGET=$(target_of "$OWNER_URL")
APP_PASSWORD=$(password_of "$APP_URL")
APP_TARGET=$(target_of "$APP_URL")

healthy_url() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# The worker serves no HTTP: it is healthy when it writes a heartbeat after the switch (the
# heartbeat job runs every minute, so this waits up to two minutes).
worker_beating() {
  local since=$1
  for _ in $(seq 1 24); do
    if [ "$(PGPASSWORD="$APP_PASSWORD" psql -tAq --dbname="$APP_TARGET" \
      -c "select count(*) from worker_heartbeats where worker = '$WORKER_NAME' and beat_at > to_timestamp($since)")" = 1 ]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

healthy() {
  local since=$1
  healthy_url "$API_HEALTH_URL" || { log "the API does not answer its health check"; return 1; }
  healthy_url "$STORE_URL" || { log "the store does not answer"; return 1; }
  worker_beating "$since" || { log "the worker wrote no heartbeat"; return 1; }
}

# Returns non-zero instead of exiting when PM2 fails, so the caller can still restore the
# previous release (set -e does not apply inside a function called from a condition).
switch_to() {
  ln -sfn "$1" "$SITE_DIR/current.next" &&
    mv -T "$SITE_DIR/current.next" "$CURRENT" &&
    pm2 startOrReload "$ECOSYSTEM" --update-env >/dev/null &&
    pm2 save >/dev/null
}

# Switches to a release and checks it; on failure switches back to `fallback` (when given) and
# checks that. The heartbeat window starts once PM2 has replaced the processes, so a beat of the
# old worker never counts for the new one.
switch_checked() {
  local target=$1 fallback=${2:-} since
  if switch_to "$target" && since=$(date +%s) && healthy "$since"; then return 0; fi
  log "$(basename "$target") failed to start or its health checks"
  if [ -n "$fallback" ] && [ -d "$fallback" ]; then
    if switch_to "$fallback" && since=$(date +%s) && healthy "$since"; then
      log "back on $(basename "$fallback")"
    else
      log "$(basename "$fallback") is unhealthy too"
    fi
  fi
  return 1
}

if [ "${1:-}" = rollback ]; then
  active=$(readlink -f "$CURRENT")
  # Release names start with a UTC timestamp, so the previous one sorts just before the active one.
  # Releases that failed their checks were removed, so it is the last one that ran healthy.
  previous=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort |
    awk -v active="$active" '$0 < active' | tail -1)
  [ -n "$previous" ] || fail "no previous release to roll back to"
  log "rolling back to $(basename "$previous")"
  switch_checked "$previous" "$active" || fail "rollback failed; check: pm2 logs --err"
  log "rolled back to $(basename "$previous")"
  exit 0
fi

if [ "${1:-}" = restore ]; then
  name="${2:-}"
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$ ]] || fail "usage: deploy.sh restore <release>"
  snapshot="$SHARED/db-snapshots/$name.dump"
  [ -f "$snapshot" ] || fail "no snapshot $snapshot"
  # Nothing may write while the tables are replaced: stop every process first.
  log "stopping the apps"
  pm2 stop "$ECOSYSTEM" >/dev/null
  # Everything written since the snapshot (journals, orders, queued jobs) is lost by the restore:
  # keep it in a dump that is never pruned, to reconcile from (docs/deployment.md).
  mkdir -p "$SHARED/db-before-restore"
  kept="$SHARED/db-before-restore/$(date -u +%Y%m%dT%H%M%SZ).dump"
  log "saving the current database to $kept"
  (umask 077 && PGPASSWORD="$OWNER_PASSWORD" pg_dump --format=custom --file="$kept" --dbname="$OWNER_TARGET")
  log "restoring the database from $name (taken before that release migrated)"
  # As the owner (ADR 0014): it drops and recreates the tables it owns, grants included. The
  # ledger triggers refuse DELETE and TRUNCATE, not DROP, so no row is ever edited in place.
  PGPASSWORD="$OWNER_PASSWORD" pg_restore --clean --if-exists --no-owner --single-transaction \
    --dbname="$OWNER_TARGET" "$snapshot"
  log "restored; the apps stay stopped. Start a release whose code matches this schema:"
  log "  vertexdigital-deploy rollback   or   vertexdigital-deploy <ref>"
  exit 0
fi

ref="${1:-origin/main}"
log "fetching"
git -C "$REPO" fetch --quiet --prune origin '+refs/heads/*:refs/remotes/origin/*'
sha=$(git -C "$REPO" rev-parse --verify "$ref^{commit}") || fail "unknown ref $ref"
release="$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}"
log "building ${sha:0:7} in $(basename "$release")"

mkdir -p "$release"
cleanup_failed() { log "removing unfinished release"; rm -rf "$release"; }
trap cleanup_failed ERR

git -C "$REPO" archive "$sha" | tar -x -C "$release"
echo "$sha" >"$release/REVISION"
ln -s "$SHARED/.env" "$release/.env"

(
  cd "$release"
  corepack pnpm install --frozen-lockfile --reporter=append-only
  # The store and the panel load the Madani Arabic faces only when their files are on the server.
  MADANI_FONTS_DIR="$SITE_DIR/fonts/madani" corepack pnpm build
)

# A snapshot right before migrating, restorable with `deploy.sh restore` if a migration goes wrong.
mkdir -p "$SHARED/db-snapshots"
snapshot="$SHARED/db-snapshots/$(basename "$release").dump"
log "database snapshot"
(umask 077 && PGPASSWORD="$OWNER_PASSWORD" pg_dump --format=custom --file="$snapshot" --dbname="$OWNER_TARGET")
ls -1t "$SHARED"/db-snapshots/*.dump 2>/dev/null | tail -n +$((KEEP_DB_SNAPSHOTS + 1)) | xargs -r rm -f

# Drizzle migrations, then pg-boss, as the owner role (ADR 0014): its URL reaches this one
# command's environment only.
log "migrating"
DATABASE_OWNER_URL="$OWNER_URL" node "$release/packages/db/dist/cli/migrate.js"
trap - ERR

previous=$(readlink -f "$CURRENT" 2>/dev/null || true)
log "switching to $(basename "$release")"
if ! switch_checked "$release" "$previous"; then
  # A release that failed its checks is removed, so `rollback` never picks it later.
  rm -rf "$release"
  fail "release ${sha:0:7} is not healthy and was removed; logs: pm2 logs --err"
fi

log "pruning old releases"
active=$(readlink -f "$CURRENT")
# grep exits 1 when nothing is left to prune; that is success, not a failed deploy.
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"$KEEP_RELEASES" |
  { grep -v -x "$active" || true; } | xargs -r rm -rf

log "deployed ${sha:0:7}"
