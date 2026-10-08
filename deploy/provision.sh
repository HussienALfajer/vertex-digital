#!/usr/bin/env bash
# Server setup for digital.vertexmedia.pro and digital-admin.vertexmedia.pro (docs/deployment.md,
# ADR 0009, 0014). Idempotent: safe to run again, it only creates what is missing and reinstalls
# the configuration files from the repository. Run as root from a checkout, streaming this file:
#
#   ssh vertex 'bash -s' < deploy/provision.sh            # configuration from origin/main
#   ssh vertex 'bash -s -- <ref>' < deploy/provision.sh   # from another ref
#
# It never prints secrets. Database passwords and the app secrets are generated here and written
# only to /srv/digital.vertexmedia.pro/shared/.env (600, read by the apps) and, for the owner
# role, to /etc/vertexdigital/owner.env (600, root: read by the deploy only, ADR 0014).
set -euo pipefail

STORE_DOMAIN=digital.vertexmedia.pro
ADMIN_DOMAIN=digital-admin.vertexmedia.pro
APP_USER=vertexdigital
SITE_DIR=/srv/$STORE_DOMAIN
LOG_DIR=/var/log/$STORE_DOMAIN
BACKUP_DIR=/var/backups/$STORE_DOMAIN
ACME_ROOT=/var/www/vertexdigital-acme
REPO_URL=https://github.com/HussienALfajer/vertex-digital.git
DB=vertex_digital
DB_OWNER=vertex_digital_owner
# Proposed slots, confirmed against the port map in /root/SERVER.md before the first run.
API_PORT=3060
STORE_PORT=3061
SERVER_IP=109.199.111.169
REF=${1:-origin/main}

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# The whole body is one function, so bash has read all of it before anything runs: commands
# that read stdin cannot swallow the rest of a script streamed through `ssh ... bash -s`.
main() {
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

step "Preflight"
for port in "$API_PORT" "$STORE_PORT"; do
  if ss -ltn | awk 'NR>1{print $4}' | grep -qx "127.0.0.1:$port"; then
    pgrep -u "$APP_USER" >/dev/null 2>&1 || { echo "port $port is taken by another program" >&2; exit 1; }
  fi
done
for domain in "$STORE_DOMAIN" "$ADMIN_DOMAIN"; do
  resolved=$(getent ahostsv4 "$domain" | awk 'NR==1{print $1}' || true)
  [ "$resolved" = "$SERVER_IP" ] || { echo "$domain resolves to '${resolved:-nothing}', expected $SERVER_IP" >&2; exit 1; }
done
echo "DNS ok, ports $API_PORT and $STORE_PORT free"

step "System user $APP_USER"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "/home/$APP_USER" --shell /bin/bash "$APP_USER"
  echo "created"
fi
chmod 750 "/home/$APP_USER"

step "Directories"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$SITE_DIR" "$SITE_DIR/releases"
# nginx (www-data) serves the admin build, the store's static files and the Madani fonts.
install -d -o "$APP_USER" -g www-data -m 750 "$SITE_DIR/fonts" "$SITE_DIR/fonts/madani"
# Receipts and QR images (S03) live outside the releases; .env stays 600. nginx (www-data) may
# cross shared/ and read shared/files/ only, to send files through X-Accel-Redirect; setgid keeps
# new folders and files in the www-data group.
install -d -o "$APP_USER" -g "$APP_USER" -m 711 "$SITE_DIR/shared"
install -d -o "$APP_USER" -g www-data -m 2750 "$SITE_DIR/shared/files"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$LOG_DIR"
install -d -o root -g root -m 700 "$BACKUP_DIR"
install -d -o root -g root -m 755 "$ACME_ROOT"

step "Repository"
if [ ! -d "$SITE_DIR/repo.git" ]; then
  runuser -u "$APP_USER" -- git init --quiet --bare "$SITE_DIR/repo.git"
  runuser -u "$APP_USER" -- git -C "$SITE_DIR/repo.git" remote add origin "$REPO_URL"
fi
runuser -u "$APP_USER" -- git -C "$SITE_DIR/repo.git" fetch --quiet --prune origin \
  '+refs/heads/*:refs/remotes/origin/*'
sha=$(runuser -u "$APP_USER" -- git -C "$SITE_DIR/repo.git" rev-parse --verify "$REF^{commit}")
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
runuser -u "$APP_USER" -- git -C "$SITE_DIR/repo.git" archive "$sha" deploy | tar -x -C "$src"
echo "configuration from ${sha:0:7}"

step "Scripts, systemd units, logrotate"
install -m 755 "$src/deploy/bin/vertexdigital-deploy" /usr/local/bin/vertexdigital-deploy
install -m 755 "$src/deploy/bin/vertexdigital-healthcheck" /usr/local/bin/vertexdigital-healthcheck
install -m 700 "$src/deploy/bin/vertexdigital-backup" /usr/local/sbin/vertexdigital-backup
for unit in pm2-vertexdigital.service vertexdigital-health.service vertexdigital-health.timer \
  vertexdigital-backup.service vertexdigital-backup.timer; do
  install -m 644 "$src/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
install -m 644 "$src/deploy/logrotate/$STORE_DOMAIN" "/etc/logrotate.d/$STORE_DOMAIN"
systemctl daemon-reload

step "PostgreSQL (ADR 0014)"
env_file="$SITE_DIR/shared/.env"
owner_env=/etc/vertexdigital/owner.env
install -d -o root -g root -m 700 /etc/vertexdigital
role_exists=$(runuser -u postgres -- psql -tAc "select 1 from pg_roles where rolname = '$DB'")
if [ "$role_exists" != 1 ]; then
  [ ! -e "$env_file" ] || { echo "$env_file exists but role $DB does not; refusing to guess" >&2; exit 1; }
  owner_password=$(openssl rand -hex 32)
  app_password=$(openssl rand -hex 32)
  # Through stdin, not argv: other users on the server can read process arguments. Before the
  # first migration: the owner owns everything, the app role only gets privileges by default.
  runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 <<SQL
create role $DB_OWNER login nosuperuser nocreatedb nocreaterole password '$owner_password';
create role $DB login nosuperuser nocreatedb nocreaterole password '$app_password';
create database $DB owner $DB_OWNER encoding 'UTF8' template template0;
\connect $DB
revoke connect, temporary on database $DB from public;
grant connect on database $DB to $DB;
grant usage on schema public to $DB;
alter default privileges for role $DB_OWNER in schema public grant select, insert, update, delete on tables to $DB;
alter default privileges for role $DB_OWNER in schema public grant usage, select on sequences to $DB;
create schema if not exists pgboss authorization $DB_OWNER;
grant usage on schema pgboss to $DB;
alter default privileges for role $DB_OWNER in schema pgboss grant select, insert, update, delete on tables to $DB;
alter default privileges for role $DB_OWNER in schema pgboss grant usage, select on sequences to $DB;
SQL
  (
    umask 077
    cat >"$env_file" <<EOF
# Production environment for $STORE_DOMAIN (generated by deploy/provision.sh). Never commit.
NODE_ENV=production
LOG_LEVEL=info
API_HOST=127.0.0.1
API_PORT=$API_PORT
STORE_PORT=$STORE_PORT
STORE_URL=https://$STORE_DOMAIN
ADMIN_URL=https://$ADMIN_DOMAIN
API_INTERNAL_URL=http://127.0.0.1:$API_PORT
STORE_REVALIDATE_SECRET=$(openssl rand -hex 32)
WORKER_NAME=production
DATABASE_URL=postgres://$DB:$app_password@127.0.0.1:5432/$DB
CUSTOMER_AUTH_SECRET=$(openssl rand -hex 32)
ADMIN_AUTH_SECRET=$(openssl rand -hex 32)
ALTCHA_HMAC_KEY=$(openssl rand -hex 32)
FILES_ROOT=$SITE_DIR/shared/files
FILES_ACCEL_PREFIX=/internal-files
# Empty until the owner sets them (docs/deployment.md): Sentry (Q15), the Telegram bot (ADR 0019).
SENTRY_DSN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
TELEGRAM_WEBHOOK_URL=https://$STORE_DOMAIN/api/webhooks/telegram
EOF
  )
  chown "$APP_USER:$APP_USER" "$env_file"
  (
    umask 077
    cat >"$owner_env" <<EOF
# The owner role (ADR 0014): migrations, snapshots and restores only. Root's alone; the deploy
# passes it to deploy.sh as an open file. Never copy it into shared/.env.
DATABASE_OWNER_URL=postgres://$DB_OWNER:$owner_password@127.0.0.1:5432/$DB
EOF
  )
  unset owner_password app_password
  echo "roles, database, pgboss schema and $env_file created"
else
  [ -f "$env_file" ] || { echo "role $DB exists but $env_file is missing" >&2; exit 1; }
  [ -f "$owner_env" ] || { echo "role $DB exists but $owner_env is missing" >&2; exit 1; }
  echo "already set up"
fi
chmod 600 "$env_file" "$owner_env"
# The apps must never see the owner role (ADR 0014).
if grep -q '^DATABASE_OWNER_URL=' "$env_file"; then
  echo "$env_file holds DATABASE_OWNER_URL: move it to $owner_env" >&2
  exit 1
fi

step "nginx"
# The sites rely on the server's shared security headers and the general request zones, which
# this folder does not install: refuse to go on without them, rather than serve without HSTS.
grep -q 'Strict-Transport-Security' /etc/nginx/snippets/security-headers.conf 2>/dev/null ||
  { echo "/etc/nginx/snippets/security-headers.conf with HSTS is missing" >&2; exit 1; }
for zone in 'zone=general:' 'zone=perip:'; do
  nginx -T 2>/dev/null | grep -q "$zone" ||
    { echo "the nginx ${zone%:} zone the sites use is not defined" >&2; exit 1; }
done
for snippet in vertexdigital-store-headers.conf vertexdigital-admin-headers.conf \
  vertexdigital-store-csp.conf vertexdigital-admin-csp.conf vertexdigital-proxy.conf; do
  install -m 644 "$src/deploy/nginx/$snippet" "/etc/nginx/snippets/$snippet"
done
install -m 644 "$src/deploy/nginx/vertexdigital-limits.conf" /etc/nginx/conf.d/vertexdigital-limits.conf
# Brotli where the server's nginx has the module (ADR 0008: slow connections), gzip otherwise.
if nginx -V 2>&1 | grep -q brotli || ls /etc/nginx/modules-enabled/ 2>/dev/null | grep -q brotli; then
  install -m 644 "$src/deploy/nginx/vertexdigital-compression-brotli.conf" /etc/nginx/snippets/vertexdigital-compression.conf
  echo "compression: brotli and gzip"
else
  install -m 644 "$src/deploy/nginx/vertexdigital-compression-gzip.conf" /etc/nginx/snippets/vertexdigital-compression.conf
  echo "compression: gzip (no brotli module in this nginx)"
fi

# A config that fails `nginx -t` is removed from sites-enabled at once: one broken file there
# takes every site down on the next reload or restart (SERVER.md rule 1).
activate() {
  local file=$1 name=$2
  install -m 644 "$file" "/etc/nginx/sites-available/$name"
  ln -sfn "/etc/nginx/sites-available/$name" "/etc/nginx/sites-enabled/$name"
  if ! nginx -t 2>/tmp/vertexdigital-nginx-test; then
    rm -f "/etc/nginx/sites-enabled/$name"
    cat /tmp/vertexdigital-nginx-test >&2
    echo "nginx rejected $name; it was disabled again, other sites untouched" >&2
    exit 1
  fi
  systemctl reload nginx
}

for domain in "$STORE_DOMAIN" "$ADMIN_DOMAIN"; do
  if [ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
    activate "$src/deploy/nginx/$domain.bootstrap" "$domain"
    certbot certonly --webroot -w "$ACME_ROOT" -d "$domain" --non-interactive --keep-until-expiring
  fi
done
for domain in "$STORE_DOMAIN" "$ADMIN_DOMAIN"; do
  activate "$src/deploy/nginx/$domain" "$domain"
done
echo "sites enabled with TLS"

step "fail2ban"
install -m 644 "$src/deploy/fail2ban/filter.d/vertexdigital-auth.conf" /etc/fail2ban/filter.d/vertexdigital-auth.conf
install -m 644 "$src/deploy/fail2ban/jail.d/vertexdigital.conf" /etc/fail2ban/jail.d/vertexdigital.conf
fail2ban-client reload >/dev/null && echo "fail2ban reloaded"
# The server's nginx jails expand their log globs when they start: they now watch these logs too.
for jail in vertexdigital-auth nginx-4xx-flood nginx-limit-req; do
  fail2ban-client status "$jail" >/dev/null 2>&1 && echo "$jail active"
done

step "PM2 service"
systemctl enable --now pm2-vertexdigital.service
systemctl is-active pm2-vertexdigital.service

step "Backup timer"
systemctl enable --now vertexdigital-backup.timer

cat <<EOF

Provisioning complete. Next:
  vertexdigital-deploy                                    # first release
  systemctl enable --now vertexdigital-health.timer       # once the first release is healthy
EOF
}

main "$@"
