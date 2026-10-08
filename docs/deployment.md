# Deployment

Production runs on the owner's VPS (`ssh vertex`), shared with other sites, following the server's conventions (ADR 0009, `/root/SERVER.md` on the server): the store and its API at **https://digital.vertexmedia.pro**, the admin panel at **https://digital-admin.vertexmedia.pro**. Everything on the server comes from `deploy/` in this repository: never edit files there by hand.

Server work needs the owner's explicit approval in the current conversation (AGENTS.md). Deploys happen once per phase, in their own session (`docs/workflow.md`).

Status: provisioned and first deployed on 2026-10-07 (Phase 0, commit `3074d0c`); the health timer is on. Sentry (Q15) and the Telegram alerts (Q11) are not configured yet: add their values to `shared/.env` when decided.

## Layout

| What | Where |
|---|---|
| System user | `vertexdigital` (no sudo), PM2 under `pm2-vertexdigital.service` |
| Processes | `vertexdigital-api` (127.0.0.1:3060), `vertexdigital-store` (Next.js, 127.0.0.1:3061), `vertexdigital-worker` (no port); memory limits 512, 512 and 384 MB |
| Releases | `/srv/digital.vertexmedia.pro/releases/<UTC time>-<sha>`; `current` links to the active one |
| Repository mirror | `/srv/digital.vertexmedia.pro/repo.git` (public repository over HTTPS, no credentials) |
| Environment | `/srv/digital.vertexmedia.pro/shared/.env` (600), linked into each release as `.env`; read by the apps |
| Owner role credentials | `/etc/vertexdigital/owner.env` (600, root): `DATABASE_OWNER_URL` only, handed by `vertexdigital-deploy` to the migrate, snapshot and restore steps (ADR 0014); never in `shared/.env` |
| Receipts and attachments | `/srv/digital.vertexmedia.pro/shared/files/` (`FILES_ROOT`, outside the releases; F05, F23), group `www-data` so nginx sends them through `X-Accel-Redirect` (`FILES_ACCEL_PREFIX=/internal-files`, an `internal` location on each host) |
| Pre-migration snapshots | `/srv/digital.vertexmedia.pro/shared/db-snapshots/` (last 10) |
| State before a restore | `/srv/digital.vertexmedia.pro/shared/db-before-restore/` (never pruned) |
| Madani font files | `/srv/digital.vertexmedia.pro/fonts/madani/` (ADR 0012; empty until Q2). The builds load them only when they are there: copy them in, then deploy again |
| App logs | `/var/log/digital.vertexmedia.pro/{api,worker,store}.{out,err}.log` (14 days) |
| nginx logs | `/var/log/nginx/digital.vertexmedia.pro.*.log`, `/var/log/nginx/digital-admin.vertexmedia.pro.*.log` |
| nginx | `sites-available/digital.vertexmedia.pro`, `sites-available/digital-admin.vertexmedia.pro`, `snippets/vertexdigital-*.conf` (headers, CSP, proxy, compression), `conf.d/vertexdigital-limits.conf` |
| Database | PostgreSQL 17, database `vertex_digital`; owner role `vertex_digital_owner` (migrations, dumps, restores), app role `vertex_digital` (the apps); `CONNECT` and `TEMPORARY` revoked from `PUBLIC`; schema `pgboss` owned by the owner (ADR 0014) |
| fail2ban | `vertexdigital-auth` jail: 20 failed sign-ins (store or panel) in 10 minutes ban the address for an hour; the server's nginx jails watch these logs too |
| Daily backups | `/var/backups/digital.vertexmedia.pro/` (700, root), 03:50, 14 days |
| Health check | `vertexdigital-health.timer`, every 2 minutes: API, store, worker heartbeat, PM2, certificates, disk; restarts with a 10-minute cooldown |

| Repository file | Installed as |
|---|---|
| `deploy/provision.sh` | run once (idempotent) to set up everything below |
| `deploy/deploy.sh` | run by `/usr/local/bin/vertexdigital-deploy`, always the copy on `origin/main` |
| `deploy/ecosystem.config.cjs` | PM2 process file, read from the current release |
| `deploy/bin/*` | `/usr/local/bin/vertexdigital-{deploy,healthcheck}`, `/usr/local/sbin/vertexdigital-backup` |
| `deploy/systemd/*` | `/etc/systemd/system/` |
| `deploy/nginx/*` | `/etc/nginx/sites-available/`, `snippets/`, `conf.d/` |
| `deploy/fail2ban/*` | `/etc/fail2ban/filter.d/`, `/etc/fail2ban/jail.d/` |
| `deploy/logrotate/*` | `/etc/logrotate.d/digital.vertexmedia.pro` |

### Request routing

| Host | Path | Goes to |
|---|---|---|
| store | `/_next/static/*` | disk, cached a year |
| store | `/api/admin/*` (any case), `/api/docs` | 404 |
| store | `/api/auth/sign-in/email` | API, 30 a minute per address (burst 10) |
| store | `/api/deposits/{sham-cash,usdt}`, `/api/deposits/:id/txid` | API, 10 a minute per address (burst 5) |
| store | `/api/deposits/:id/receipt` | API, bodies up to 6 MB, the upload limit |
| store | `/api/*` | API |
| store | everything else | store (Next.js) |
| admin | `/assets/*` | disk, cached a year |
| admin | `/api/admin/auth/{sign-in/email,two-factor/verify-*}` | API, 30 a minute per address (burst 10) |
| admin | `/api/admin/*` | API |
| admin | `/api/altcha/challenge` | API (the admin sign-in's proof of work), same limit |
| admin | other `/api/*` | 404 |
| admin | everything else | `index.html` (SPA), never cached |

nginx overwrites `X-Forwarded-For` with the client address: the API's rate limits and Better Auth's sign-in limits key on it. Compression is Brotli when the server's nginx has the module (`provision.sh` checks), gzip otherwise; the apps do not compress.

## Deploy

Merge to `main` (CI green), then:

```bash
ssh vertex vertexdigital-deploy
```

What it does, in order, stopping at the first failure:
1. Fetch `origin/main` and extract it into a new release directory.
2. `pnpm install --frozen-lockfile` and `pnpm build` inside the release (the store, the panel, the API, the worker and the packages).
3. Snapshot the database (`pg_dump` as the owner), then apply the migrations as the owner (Drizzle, then pg-boss).
4. Switch `current` atomically and reload PM2.
5. Check health: the API's `/api/health` and the store's home page within 60 s, and a worker heartbeat written after PM2 replaced the processes, within two minutes. If PM2 fails to start the release, or a check fails, switch back to the previous one (checked the same way) and delete the failed release, so a later rollback never picks it.
6. Keep the last 5 releases.

The running site is untouched until step 4. A failed build or migration leaves the previous release serving.

Deploy another ref: `ssh vertex "vertexdigital-deploy <sha-or-origin/branch>"`.

### Migrations must stay backward compatible

The previous release keeps running until the switch, and a rollback runs old code against the migrated database. Write migrations as expand then contract: add columns and tables first, remove old ones in a later release once no deployed code uses them.

## Roll back

```bash
ssh vertex "vertexdigital-deploy rollback"
```

Switches to the previous release and checks it; if it is unhealthy, switches back to the one that was running. Migrations are not reverted. To restore the database as it was before a deploy, restore the snapshot named after that release (as the owner role; the password reaches `pg_restore` through its environment, never its arguments):

```bash
ssh vertex "vertexdigital-deploy restore <release>"
```

The restore stops the three apps, saves the current database to `shared/db-before-restore/` (never pruned), replaces the database, and leaves the apps stopped: start a release whose code matches the restored schema with `vertexdigital-deploy rollback` or `vertexdigital-deploy <ref>`. Everything written after the snapshot (ledger journals, orders, queued jobs) is gone from the live database but kept in the saved dump: reconcile it before reopening the store (re-post the missing journals as new entries, never by editing rows; ADR 0003).

## Accounts

Customer registration stays closed in production until the pilot: `REGISTRATION_OPEN` stays unset (closed) in `shared/.env` until S05 replaces it with the panel's switch (F26).

There is one admin account (ADR 0016), created and recovered on the server only. Each command prints a generated password once, to whoever runs it, and writes an audit entry. A printed password must be changed at the next sign-in, then TOTP is enrolled: sign in right away, since until then anyone who learns the password could enrol their own authenticator first.

```bash
ssh -t vertex "cd /srv/digital.vertexmedia.pro/current && sudo -u vertexdigital node apps/api/dist/cli/create-admin.js --email <email> --name '<name>'"
```

A forgotten password: `node apps/api/dist/cli/reset-password.js --email <email>` the same way (a new printed password, every session signed out, TOTP kept). A lost authenticator and backup codes: `node apps/api/dist/cli/reset-two-factor.js --email <email>` (TOTP removed, every session signed out). Without server access there is no recovery, by design (ADR 0016).

### Phase 1 deploy: the staff → admin rename (S01)
The S01 migration renames the Phase 0 `staff_*` tables to `admin_*` in place, so the Phase 0 account survives with its password and TOTP. Before the first Phase 1 release starts, rename the key `STAFF_AUTH_SECRET` to `ADMIN_AUTH_SECRET` in `shared/.env` **keeping its value**: it encrypts the TOTP secret, so a new value means enrolling again. The API refuses to start in production without `ADMIN_AUTH_SECRET`. Add the SMTP values (`SMTP_*`, `EMAIL_FROM`, `EMAIL_TRANSPORT=smtp`) at the same time. Once this migration ran, a Phase 0 release cannot sign the admin in (it reads `staff_*`): go back with `restore`, not `rollback`, if it is ever needed.

## Operate

```bash
ssh vertex "sudo -u vertexdigital PM2_HOME=/home/vertexdigital/.pm2 pm2 list"
ssh vertex "sudo -u vertexdigital PM2_HOME=/home/vertexdigital/.pm2 pm2 logs vertexdigital-api --lines 100"
ssh vertex "journalctl -t vertexdigital-health -n 50"
ssh vertex "journalctl -t vertexdigital-backup -n 20"
ssh vertex "cat /srv/digital.vertexmedia.pro/current/REVISION"      # deployed commit
```

## Backups and restore

`vertexdigital-backup` writes the database dump, its table of contents, the environment, both nginx sites, the deployed revision and the stored files (a hard-linked snapshot of the previous backup: unchanged files take no extra space). Restore the database from a daily backup as the owner role:

```bash
ssh vertex "runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=vertex_digital_owner -d vertex_digital /var/backups/digital.vertexmedia.pro/<time>/database.dump"
```

Restore the files from the same backup:

```bash
ssh vertex "rsync -a /var/backups/digital.vertexmedia.pro/<time>/files/ /srv/digital.vertexmedia.pro/shared/files/ && chown -R vertexdigital:www-data /srv/digital.vertexmedia.pro/shared/files"
```

Backups stay on the server until an off-server destination is chosen. That is required before launch (ADR 0009), and before the first real deposit receipt is stored.

## First-time setup

Done on 2026-10-07 (ports 3060 and 3061 confirmed free in `/root/SERVER.md`, both A records added at Hostinger). For a rebuilt server, in a deploy session with the owner:
1. Read `/root/SERVER.md` on the server and confirm the ports 3060 (API) and 3061 (store) are free in its port map; if not, change them in every file listed in `deploy/CLAUDE.md`.
2. Confirm the server address in `provision.sh` (`SERVER_IP`, the address of `ssh vertex`) and point both DNS records (`digital`, `digital-admin` under `vertexmedia.pro`) at it.
3. Confirm the Sentry account (open question Q15); its DSN goes into `shared/.env` after provisioning (`SENTRY_DSN`), and the Telegram alert values (Q11) the same way.

Then, from a checkout:

```bash
ssh vertex 'bash -s' < deploy/provision.sh
ssh vertex vertexdigital-deploy
ssh vertex "systemctl enable --now vertexdigital-health.timer"
```

`provision.sh` creates the owner and app roles with the app role's default privileges before the first migration, the `pgboss` schema owned by the owner, revokes `CONNECT` and `TEMPORARY` from `PUBLIC`, and generates the database passwords and app secrets (`CUSTOMER_AUTH_SECRET`, `ADMIN_AUTH_SECRET`, `ALTCHA_HMAC_KEY`, `STORE_REVALIDATE_SECRET`) into `shared/.env`, and the owner role's URL into `/etc/vertexdigital/owner.env`, without printing them. It issues each certificate through a temporary HTTP-only site, so a missing certificate can never break nginx for the other sites. Re-running it reinstalls the configuration files from `origin/main` (pass another ref as an argument) and leaves the database and secrets alone.

## Changing configuration

- nginx, fail2ban, systemd, logrotate or scripts: change `deploy/`, merge, then re-run `provision.sh`.
- The inline theme script in `apps/admin/index.html`: its hash is in the CSP in `deploy/nginx/vertexdigital-admin-csp.conf`, and `apps/admin/src/csp.test.ts` fails until both match; re-run `provision.sh` after the merge.
- Secrets: edit `shared/.env` on the server as `vertexdigital`, then `pm2 reload all --update-env`. Rotating `CUSTOMER_AUTH_SECRET` or `ADMIN_AUTH_SECRET` signs everyone out (the admin secret also encrypts the TOTP secret: rotating it means the admin enrols again).
- USDT receiving addresses (S04, ADR 0018): `USDT_TRC20_ADDRESS` and `USDT_BEP20_ADDRESS` in `shared/.env`, the owner's own wallets (never a private key). Empty leaves that network unavailable; a value that fails its checksum stops the API from starting, so check the log after the reload. Change an address only when no USDT deposit is open (the panel's queue and pending count are empty): open deposits keep the address they showed, and a transfer to an old address is then caught only by its TXID. The panel shows the addresses read-only and cannot change them. The worker checks the same addresses at boot and refuses a bad one too.
- Chain readers (S04 PR 2), in the worker's environment: `CHAIN_READER=live` (production refuses `fake`), `TRONGRID_API_KEY` (required when the TRC20 address is set; `TRONGRID_API_URL` defaults to `https://api.trongrid.io`) and `BSC_RPC_URL` (an HTTPS JSON-RPC endpoint of a BSC provider, required when the BEP20 address is set; a provider's key is part of the URL, so treat it as a secret). The provider must allow `eth_getLogs` over 1,000 blocks and the `finalized` block tag. After the reload, the panel's deposit settings show each network's last scan: a network stays `delayed` (new USDT deposits wait) until its scanner has caught up.
