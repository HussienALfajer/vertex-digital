#!/usr/bin/env bash
# Provisions the VM of a Claude Code cloud environment for Vertex Digital. It is the repository's own
# reference: the shared `vertex` environment's setup script is a superset of it and is what runs
# (docs/workflow.md, "Cloud sessions"). It runs as root on
# Ubuntu 24.04 before Claude Code starts, and its result is cached as a filesystem snapshot when it
# finishes within about five minutes, so later sessions skip it.
#
# It installs what the image lacks: Node 24 (the image ships 20-22), the PostgreSQL 17 image (the
# image ships 16; CI and production use 17) and the system libraries of Playwright's Chromium (the
# browser itself is downloaded per session at the version in the lockfile). Per-session work (start the database, install
# packages, create the databases) is scripts/cloud-session.sh, run by a SessionStart hook.
set -uo pipefail

NODE_DIR=/opt/node24

install_node() {
  [ -x "$NODE_DIR/bin/node" ] && return 0
  local base=https://nodejs.org/dist/latest-v24.x
  local sums archive download
  sums=$(curl -fsSL "$base/SHASUMS256.txt")
  archive=$(echo "$sums" | grep -oE 'node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' | head -1)
  download=$(mktemp -d)
  curl -fsSL -o "$download/$archive" "$base/$archive"
  # The archive must match its published checksum before anything runs from it (audit A10-70).
  (cd "$download" && echo "$sums" | grep " $archive\$" | sha256sum -c --quiet -) || {
    echo "the Node archive does not match SHASUMS256.txt" >&2
    rm -rf "$download"
    return 1
  }
  mkdir -p "$NODE_DIR"
  tar -xJ -f "$download/$archive" -C "$NODE_DIR" --strip-components=1
  rm -rf "$download"
  # pnpm comes from Corepack at the version in package.json ("packageManager").
  PATH="$NODE_DIR/bin:$PATH" corepack enable
}

pull_postgres() {
  if ! docker info >/dev/null 2>&1; then
    (dockerd >/var/log/dockerd.log 2>&1 &)
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  docker pull -q postgres:17
}

# Chromium's system libraries need root, so they come here; the version-matched browser is
# installed by scripts/cloud-session.sh into PLAYWRIGHT_BROWSERS_PATH.
install_chromium_deps() {
  PATH="$NODE_DIR/bin:$PATH" npx -y playwright@1 install-deps chromium
}

install_node || echo "cloud-setup: Node 24 install failed" >&2
install_chromium_deps || echo "cloud-setup: Chromium libraries install failed" >&2
pull_postgres || echo "cloud-setup: PostgreSQL 17 image pull failed" >&2
exit 0
