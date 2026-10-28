#!/usr/bin/env bash
# Runs `nginx -t` on this folder's nginx configuration in the server's nginx version (CI, the
# static job; audit A10-2), with stand-ins for what the server provides and the repository does
# not: its security headers snippet, the `general` and `perip` zones, and certificates.
#
#   bash deploy/test/nginx-check.sh          (needs Docker)
set -euo pipefail

IMAGE=nginx:1.24.0
# Git Bash on Windows turns arguments that look like paths into Windows paths: turned off, and
# the host paths handed to Docker and OpenSSL are converted here instead.
export MSYS2_ARG_CONV_EXCL='*'
host() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

check() {
  local variant=$1 conf="$tmp/$1/nginx" certs="$tmp/$1/letsencrypt"
  mkdir -p "$conf/snippets" "$conf/conf.d" "$conf/sites-enabled" "$certs/live"
  docker run --rm "$IMAGE" cat /etc/nginx/mime.types >"$conf/mime.types"
  cat >"$conf/nginx.conf" <<'EOF'
events {}
http {
    include mime.types;
    limit_req_zone $binary_remote_addr zone=general:10m rate=20r/s;
    limit_conn_zone $binary_remote_addr zone=perip:10m;
    include conf.d/*.conf;
    include sites-enabled/*;
}
EOF
  echo 'add_header Strict-Transport-Security "max-age=31536000" always;' >"$conf/snippets/security-headers.conf"
  for snippet in vertexdigital-store-headers.conf vertexdigital-admin-headers.conf \
    vertexdigital-store-csp.conf vertexdigital-admin-csp.conf vertexdigital-proxy.conf; do
    cp "$here/nginx/$snippet" "$conf/snippets/$snippet"
  done
  cp "$here/nginx/vertexdigital-compression-gzip.conf" "$conf/snippets/vertexdigital-compression.conf"
  cp "$here/nginx/vertexdigital-limits.conf" "$conf/conf.d/vertexdigital-limits.conf"
  for domain in digital.vertexmedia.pro digital-admin.vertexmedia.pro; do
    if [ "$variant" = bootstrap ]; then
      cp "$here/nginx/$domain.bootstrap" "$conf/sites-enabled/$domain"
    else
      cp "$here/nginx/$domain" "$conf/sites-enabled/$domain"
    fi
    mkdir -p "$certs/live/$domain"
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$domain" \
      -keyout "$(host "$certs/live/$domain/privkey.pem")" \
      -out "$(host "$certs/live/$domain/fullchain.pem")" 2>/dev/null
  done
  docker run --rm -v "$(host "$conf"):/etc/nginx:ro" -v "$(host "$certs"):/etc/letsencrypt:ro" \
    "$IMAGE" nginx -t
  echo "nginx -t passed ($variant)"
}

check sites
check bootstrap
