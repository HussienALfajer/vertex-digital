# deploy

Everything installed on the production server comes from this folder (ADR 0009, 0014). Runbook: `docs/deployment.md`. Adapted from Vertex Hub's deploy folder; the server's own conventions are in `/root/SERVER.md` on the server.

## Layout
- `provision.sh`: one-time and idempotent server setup (user, directories, repository mirror, roles and database, `shared/.env`, nginx, certificates, fail2ban, systemd). `deploy.sh`: atomic releases, rollback and restore, run through `bin/vertexdigital-deploy`.
- `ecosystem.config.cjs`: PM2 processes `vertexdigital-api`, `vertexdigital-worker`, `vertexdigital-store`, with memory limits.
- `nginx/`: one site per host (`digital.vertexmedia.pro`, `digital-admin.vertexmedia.pro`), their `.bootstrap` variants for the first certificate, and the `vertexdigital-*` snippets (headers, CSP, proxy, compression) and rate-limit zones.
- `fail2ban/`: the `vertexdigital-auth` filter and jail (failed sign-ins on both hosts). `systemd/`: PM2 service, health timer, backup timer. `logrotate/`: app logs. `bin/`: deploy entry point, health check, backup.

## Rules
- Never run commands on the server (`ssh vertex ...`) without the owner's explicit approval in the current conversation. Reading and editing this folder locally needs no approval.
- The server is never edited by hand. A change lands here, merges to `main`, and is installed by `deploy.sh` or `provision.sh`.
- `provision.sh` stays idempotent: running it twice changes nothing the second time.
- Apps listen on `127.0.0.1` only; nginx is the only public listener. One system user (`vertexdigital`), no sudo. Ports (API 3060, store 3061) are set in `provision.sh`, `deploy.sh`, `ecosystem.config.cjs`, `bin/vertexdigital-healthcheck` and the nginx sites: change them together, after reading the server's port map.
- Database roles (ADR 0014): the owner role migrates, dumps and restores; the apps connect as the app role. The owner URL lives only in `/etc/vertexdigital/owner.env` (root), reaches `deploy.sh` on file descriptor 3 and stays an unexported variable: never put it in `shared/.env` or the script's exported environment (`pm2 --update-env` copies that into the apps). Passwords reach `psql`/`pg_dump` through the environment of that one command, never arguments.
- `deploy.sh` never sources `shared/.env`: it would export `NODE_ENV=production`, and pnpm would skip the devDependencies the build needs. Read single values with `env_value`.
- nginx: `X-Forwarded-For $remote_addr` (overwritten, never appended); `add_header` in a location drops the server's headers, so such locations include the headers snippet again; regex locations match in file order. The admin CSP hash must match `apps/admin/index.html` (`apps/admin/src/csp.test.ts`).
- Scripts use `set -euo pipefail` and stop at the first failure (the health check uses `set -u`: it must survive failed probes). Quote every variable. Check with `bash -n <file>` before committing.
- Secrets live only in `/srv/digital.vertexmedia.pro/shared/.env` on the server, never in this folder (the repository is public).
- A deploy must be able to roll back: migrations are backward compatible (`packages/db/CLAUDE.md`).
- nginx changes are tested with `nginx -t` on the server before reload, as part of an approved server session (`provision.sh` does it and disables a rejected site).
