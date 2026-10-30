# deploy

Everything installed on the production server comes from this folder (ADR 0009, 0014). Runbook: `docs/deployment.md`. The server's own conventions are in `/root/SERVER.md` on the server: read it before any server work.

## Layout
- `provision.sh`: one-time, idempotent server setup (user, directories, repository mirror, roles and database, `shared/.env`, nginx, certificates, fail2ban, systemd). `deploy.sh`: atomic releases, rollback and restore, run through `bin/vertexdigital-deploy`.
- `ecosystem.config.cjs`: PM2 processes `vertexdigital-api`, `vertexdigital-worker`, `vertexdigital-store` with memory limits; the api and worker cap V8's heap below theirs through `NODE_OPTIONS` (PM2's `--update-env` applies env, not `node_args`).
- `nginx/`: one site per host (`digital.vertexmedia.pro`, `digital-admin.vertexmedia.pro`), their `.bootstrap` variants for the first certificate, the `vertexdigital-*` snippets (headers, CSP, proxy, compression) and rate-limit zones.
- `fail2ban/` (failed sign-ins and 429 floods), `systemd/` (PM2 service, health and backup timers), `logrotate/`, `bin/` (deploy entry point, health check, backup, `vertexdigital-notify` for Telegram alerts from the server).
- `backup-public.asc`: the owner's public key the off-server backup copies are encrypted to (Q1). Public, safe in the repository; its private key never reaches the server or this folder.
- Tests: `deploy/test/nginx-check.sh` (`nginx -t` on this folder with Docker, run by CI) and `apps/api/test/deploy-scripts.test.ts` (the scripts and nginx sites; the `bin/` scripts take `VD_*` path variables for it). Run the latter with `pnpm verify apps/api/test/deploy-scripts.test.ts`.

## Approvals
- Server commands (`ssh vertex ...`), deploys and rollbacks need no approval in the conversation (owner, 2026-10-18). Deploy `main` to production whenever a task calls for it, not only once per phase, and report what changed.
- Still need the owner's explicit approval: `vertexdigital-deploy restore` (restoring a database snapshot), deleting data, dropping tables, and anything that moves real money.

## Server safety
- Run long jobs with `systemd-run`, and never run git as root in the server's repository mirror (`/root/SERVER.md` rules 5 and 16).
- The server is never edited by hand. A change lands here, merges to `main`, and is installed by `deploy.sh` or `provision.sh`.
- `provision.sh` stays idempotent: running it twice changes nothing the second time.
- Apps listen on `127.0.0.1` only; nginx is the only public listener. One system user (`vertexdigital`), no sudo. Ports (API 3060, store 3061) are set in `provision.sh`, `deploy.sh`, `ecosystem.config.cjs`, `bin/vertexdigital-healthcheck` and the nginx sites: change them together, after reading the server's port map.
- Secrets live only in `/srv/digital.vertexmedia.pro/shared/.env` on the server, never in this folder (the repository is public).
- Database roles (ADR 0014): the owner role migrates, dumps and restores; the apps connect as the app role.
- The owner URL lives only in `/etc/vertexdigital/owner.env` (root), reaches `deploy.sh` on file descriptor 3 and stays an unexported variable: never put it in `shared/.env` or the script's exported environment (`pm2 --update-env` copies that into the apps).
- Passwords reach `psql`/`pg_dump`/`pg_restore` through the environment of that one command, never its arguments.
- `deploy.sh` never sources `shared/.env`: it would export `NODE_ENV=production`, and pnpm would skip the devDependencies the build needs. Read single values with `env_value`.
- The health check heals only after two failed runs, waits while `.deploy.lock` exists and heals nothing while `.hold` exists (left by a restore).
- A deploy must be able to roll back: migrations are backward compatible (`packages/db/CLAUDE.md`). A data step the previous release cannot read (`pricing:reprice-lists`) runs after a healthy deploy and is listed under "One-way steps after a deploy" in `docs/deployment.md`; past it, only a restore goes back.

## nginx
- `X-Forwarded-For $remote_addr` (overwritten, never appended).
- `add_header` in a location drops the server's headers, so such locations include the headers snippet again.
- Regex locations match in file order. A regex with a `{n}` quantifier is quoted (`location ~* "^/x/[0-9a-f-]{36}$"`), or nginx reads the brace as a block and rejects the whole site.
- The admin CSP hash must match `apps/admin/index.html` (`apps/admin/src/csp.test.ts`).
- Both sites log in the `vdprivacy` format (no query string, share tokens masked) and set `limit_req_log_level notice`; `deploy-scripts.test.ts` checks both.
- Catalog images are sent from disk by the sites' own location (`try_files`, then the API for what is not there): `proxy_cache` cannot keep an `X-Accel-Redirect` answer. Every stored file kind the store's API serves needs its `/internal-files/<kind>/` location on the store's site.
- `provision.sh` installs Ubuntu's Brotli modules and the matching compression snippet; `deploy.sh` runs `precompress-static.mjs` for `brotli_static` and `gzip_static`. The nginx check in CI has no Brotli module, so only the gzip snippet goes through its `nginx -t`.
- `provision.sh` installs every nginx file through `nginx_install`/`nginx_link` and tests them once with `nginx_commit`: a refused configuration puts every file back as it was and reloads nothing. Keep new nginx files on that path.

## Scripts
- `set -euo pipefail`, stop at the first failure (the health check uses `set -u` only: it must survive failed probes). Quote every variable. Check with `bash -n <file>` before committing.
