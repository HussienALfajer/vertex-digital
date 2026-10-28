# Deployment

Production runs on the owner's VPS (`ssh vertex`), shared with other sites, following the server's conventions (ADR 0009, `/root/SERVER.md` on the server): the store and its API at **https://digital.vertexmedia.pro**, the admin panel at **https://digital-admin.vertexmedia.pro**. Everything on the server comes from `deploy/` in this repository: never edit files there by hand.

Server commands, deploys and rollbacks need no approval in the conversation (owner, 2026-10-18; `AGENTS.md`); a restore, deleting data and real-money actions still do.

Status: provisioned and first deployed on 2026-10-07 (Phase 0, commit `3074d0c`); Phases 1–3 deployed together on 2026-10-12 (commit `6230b05`); S16 deployed on 2026-10-13 (commit `0495047`); the worker memory fixes on 2026-10-14 (commits `58dbeee`, then `39ead74`); the SHOP2TOPUP drop on 2026-10-14 (ADR 0031 step 1, migration 0060, commit `e849fa5`; step 2, migration 0061, commit `c2ac68e`: a rollback to `39ead74` or older now needs a restore, since that code sends `shop2topup_paused`); the launch hardening on 2026-10-14 (commit `0ce64f0`, with `provision.sh` re-run for the `/favicon.ico` location) and the catalog counts fix on 2026-10-15 (commit `b0794fa`); the account and exchange rate fixes on 2026-10-15 (commit `a2bfdb7`, then `877c951`: the server clock for countdowns, rate reads inside transactions (F3-4), no migration) and the F3-4 sweep with its pool safeguard on 2026-10-16 (commit `55a2757`: every read inside a transaction goes through it; the API and worker pools fail a 10 s connection wait or a 15 s lock wait, no migration); the Sham Cash deposit fixes on 2026-10-16 (commit `18336fe`: Sham Cash deposit fixes F4-2 to F4-16, migration 0062 adds `payment_references_reference_ascii_check`, 63 migrations applied; no new secret and no `deploy/` change, so `provision.sh` was not re-run); the feature 5 audit fixes and the wallet-style QR on 2026-10-17 (commit `c00576e`: migration 0063 adds `payment_references_usdt_txid_idx` after a read-only check found no TXID claimed under both networks, 64 migrations applied; no new secret and no `deploy/` change, so `provision.sh` was not re-run); the F6-1 ledger summary fix on 2026-10-17 (commit `d5cad4d`: SYP system accounts shown in pounds, admin panel only, no migration, 64 migrations applied); the feature 6 audit fixes and the store's idempotency keys on 2026-10-17 (commit `0e7de6b`: F6-4 to F6-14, `postJournal` locks every wallet a journal touches, search terms scrubbed from the API logs and Sentry, the panel's referrer limited to its origin; no migration, 64 migrations applied; no new secret and no `deploy/` change, so `provision.sh` was not re-run); the feature 7 audit fixes on 2026-10-17 (commit `bfae339`); the feature 8 results and audit fixes on 2026-10-17 (commit `f4e3d88`: F8-1 to F8-8 and Q21, restores and rule changes reprice, the rule lock order fixed, a select option dropped by a sync reprices; no migration, 64 migrations applied; no new secret and no `deploy/` change, so `provision.sh` was not re-run); the feature 9 results and audit fixes on 2026-10-18 (commit `07800ff`: F9-4 to F9-14, per-offer route maps, `kind_mismatch`, the replaced-keys test, the balance streak read from its messages, same-origin supplier redirects; no migration, 64 migrations applied, no new secret and no `deploy/` change; after it the missing "✅ رصيد WDGZone عاد إلى الحد" was sent at the first balance read, 01:55 Damascus, and the 02:00 sync succeeded with 11,640 offers); S17, the WDGZone Web Purchase route, on 2026-10-18 (commit `bcf2d42`: migration 0064 drops the one-route-per-supplier index and adds the routes' price basis and timing and the attempts' timing copies, 65 migrations applied, every existing route counts for the price; no new secret and no `deploy/` change, so `provision.sh` was not re-run); the store's savings badge fix (F10-2) on 2026-10-18 (commit `d1f70f3`: no migration, no new secret, no `deploy/` change); Phase M, S20 merchant accounts and price lists, on 2026-10-21 (commit `e1e652a`: migrations 0075–0081, 82 applied; then `pricing:reprice-lists` added the wholesale and cost global rules and wrote 302 list rows, no retail row and no review, and a second run wrote nothing: from here a rollback before S20 needs `restore`; no new secret and no `deploy/` change besides its `CLAUDE.md`, so `provision.sh` was not re-run); S21 merchant tools and S22 quick buy, passkeys and order help on 2026-10-26 (commit `26cac0b`: migrations 0082–0095, 96 applied, no new secret; `provision.sh` re-run for the `vdverify` and `vdquick` zones on `/v/`, `/api/verify/`, `/q/`, `/api/q/` and the merchant logo upload under `vdupload`); the A01 audit fixes on 2026-10-27 (commit `097b869`: no migration, 96 applied, no new secret; `provision.sh` re-run for the passkey routes in the `vdsignin` zone); the A02 audit fixes on 2026-10-27 (commit `610a388`: no migration, 96 applied, no new secret; `provision.sh` re-run for requotes and cancellations in the `vddeposit` zone); the A03 audit fixes on 2026-10-27 (commit `788f309`: no migration, 96 applied, no new secret; `provision.sh` re-run for the `vdcatalog` zone; then the A03-1 data fix, one audited transaction clearing the in-game amount of 19 PUBG Mobile packs); the A04 audit fixes on 2026-10-27 (commit `7914ca2`: no migration, 96 applied, no new secret and no `deploy/` change, so `provision.sh` was not re-run), then A04-21 after Q24 (commit `8cef153`, the same day: no migration, no new secret, no `deploy/` change); the A05 audit fixes on 2026-10-27 (commit `3f2def4`: no migration, 96 applied, no new secret and no `deploy/` change, so `provision.sh` was not re-run; the sync schedule now skips a supplier whose plan is inactive, FazerCards since then); audit A06 (merchants) on 2026-10-27 (commit `60f46b0`, no migration and no `deploy/` change, so `provision.sh` was not re-run); audit A07 (customers, support and notifications) on 2026-10-28 (commit `e9977c6`: migration 0096, indexes only, 97 applied, no new secret; `provision.sh` re-run for the `vdstream` zone on the store's notification stream); audit A08 (content) on 2026-10-28 (commit `0a7650b`: no migration, 97 applied, no new secret and no `deploy/` change, so `provision.sh` was not re-run); audit A09 (control, reconciliation and reports) on 2026-10-28 (commit `ec5168e`: migration 0097, three indexes, 98 applied, no new secret and no `deploy/` change, so `provision.sh` was not re-run); the health timer is on. Sentry reports the store's server errors too (audit A10-18: `SENTRY_DSN` copied into the store, posted without an SDK) and the panel's crashes through `POST /api/admin/client-errors` (A10-26). Sentry (Q15, resolved) is configured for the API and the worker (`SENTRY_DSN` in `shared/.env`). Customer registration stays closed until the pilot. The Telegram bot (S05, ADR 0019) is set up as "Telegram admin bot" below says.

## Layout

| What | Where |
|---|---|
| System user | `vertexdigital` (no sudo), PM2 under `pm2-vertexdigital.service` |
| Processes | `vertexdigital-api` (127.0.0.1:3060), `vertexdigital-store` (Next.js, 127.0.0.1:3061), `vertexdigital-worker` (no port); 512 MB each; the worker's PM2 `kill_timeout` is 35 s, above pg-boss's 25 s stop (audit A10-5) |
| Releases | `/srv/digital.vertexmedia.pro/releases/<UTC time>-<sha>`; `current` links to the active one |
| Repository mirror | `/srv/digital.vertexmedia.pro/repo.git` (public repository over HTTPS, no credentials) |
| Environment | `/srv/digital.vertexmedia.pro/shared/.env` (600), linked into each release as `.env`; read by the apps |
| Owner role credentials | `/etc/vertexdigital/owner.env` (600, root): `DATABASE_OWNER_URL` only, handed by `vertexdigital-deploy` to the migrate, snapshot and restore steps (ADR 0014); never in `shared/.env` |
| Receipts, attachments and catalog images | `/srv/digital.vertexmedia.pro/shared/files/` (`FILES_ROOT`, outside the releases; F05, F08, F23), group `www-data` so nginx sends them through `X-Accel-Redirect` (`FILES_ACCEL_PREFIX=/internal-files`, an `internal` location on each host; the store host serves only `sham_cash_qr/` and `catalog_image/`) |
| Pre-migration snapshots | `/srv/digital.vertexmedia.pro/shared/db-snapshots/` (last 10) |
| State before a restore | `/srv/digital.vertexmedia.pro/shared/db-before-restore/` (never pruned) |
| Madani font files | `/srv/digital.vertexmedia.pro/fonts/madani/` (ADR 0012; empty until Q2). The builds load them only when they are there: copy them in, then deploy again |
| App logs | `/var/log/digital.vertexmedia.pro/{api,worker,store}.{out,err}.log` (14 days) |
| nginx logs | `/var/log/nginx/digital.vertexmedia.pro.*.log`, `/var/log/nginx/digital-admin.vertexmedia.pro.*.log`; access logs in the `vdprivacy` format: no query string, the tokens of `/g/`, `/r/`, `/v/`, `/q/` and their API reads masked, in the path and the referrer (audit A10-8) |
| nginx | `sites-available/digital.vertexmedia.pro`, `sites-available/digital-admin.vertexmedia.pro`, `snippets/vertexdigital-*.conf` (headers, CSP, proxy, compression), `conf.d/vertexdigital-limits.conf` |
| Database | PostgreSQL 17, database `vertex_digital`; owner role `vertex_digital_owner` (migrations, dumps, restores), app role `vertex_digital` (the apps); `CONNECT` and `TEMPORARY` revoked from `PUBLIC`; schema `pgboss` owned by the owner (ADR 0014) |
| fail2ban | `vertexdigital-auth` jail: 20 failed sign-ins (store or panel) in 10 minutes ban the address for an hour; `vertexdigital-limit` jail: 300 rate refusals (429) in 10 minutes ban it for an hour. The sites log their own `limit_req` refusals at `notice`, below their error log, so the server's `nginx-limit-req` jail (10 in 10 minutes, every site) no longer bans a carrier address shared by many customers (audit A10-10); its `nginx-4xx-flood` jail still reads the access logs |
| Daily backups | `/var/backups/digital.vertexmedia.pro/` (700, root), 03:50, 14 days; written into `<time>.partial` and renamed when complete, with a `SHA256SUMS` manifest; a failure is logged and sent to Telegram (audit A10-13) |
| Health check | `vertexdigital-health.timer`, every 2 minutes: API, store, worker heartbeat, PM2, the public pages, certificates, disk, the newest backup under 26 hours; heals a check only after two failed runs in a row, with a 10-minute cooldown, never the store while the API is down; waits while a deploy holds its lock and heals nothing while `.hold` exists (a restore); one Telegram message when a problem starts and one when it ends, through `vertexdigital-notify` (audit A10-1, A10-3, A10-12) |

| Repository file | Installed as |
|---|---|
| `deploy/provision.sh` | run once (idempotent) to set up everything below |
| `deploy/deploy.sh` | run by `/usr/local/bin/vertexdigital-deploy`, always the copy on `origin/main` |
| `deploy/ecosystem.config.cjs` | PM2 process file, read from the current release |
| `deploy/bin/*` | `/usr/local/bin/vertexdigital-{deploy,healthcheck}`, `/usr/local/sbin/vertexdigital-{backup,notify}` |
| `deploy/test/nginx-check.sh` | not installed: CI runs `nginx -t` on `deploy/nginx` in nginx 1.24 (audit A10-2) |
| `deploy/systemd/*` | `/etc/systemd/system/` |
| `deploy/nginx/*` | `/etc/nginx/sites-available/`, `snippets/`, `conf.d/` |
| `deploy/fail2ban/*` | `/etc/fail2ban/filter.d/`, `/etc/fail2ban/jail.d/` |
| `deploy/logrotate/*` | `/etc/logrotate.d/digital.vertexmedia.pro` |

### Request routing

| Host | Path | Goes to |
|---|---|---|
| store | `/_next/static/*` | disk, cached a year; 100 a second per address (burst 400, `vdstatic`) instead of the server-wide `general` zone |
| store | `/api/admin/*` (any case), `/api/docs`, `/_internal/*` (any case, S09: the store's cache refresh, for the worker on 127.0.0.1 only) | 404 |
| store | `/api/auth/sign-in/email` | API, 30 a minute per address (burst 10) |
| store | `/api/deposits/{sham-cash,usdt}`, `/api/deposits/:id/txid` | API, 10 a minute per address (burst 5) |
| store | `/api/deposits/:id/receipt` | API, bodies up to 6 MB, the upload limit |
| store | `/api/notifications/stream` | API, unbuffered, open up to an hour (S05 server-sent events) |
| store | `/api/orders`, `/api/checkouts` | API, POST 6 a minute per address (burst 10, `vdpurchase`; S08, S10) |
| store | `/api/shares/*` | API, 60 a minute per address (burst 20, `vdshare`; S10 gift and receipt data and images) |
| store | `/g/*`, `/r/*` | store, 60 a minute per address (burst 20, `vdshare`; S10 gift and receipt pages) |
| store | `/api/webhooks/telegram` (any case) | API from Telegram's webhook ranges only (149.154.160.0/20, 91.108.4.0/22), bodies up to 64 KB |
| store | `/api/*` | API |
| store | everything else | store (Next.js) |
| admin | `/assets/*` | disk, cached a year; 100 a second per address (burst 400, `vdstatic`): the panel preloads 100+ chunks on its first load |
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
4. Copy the running release's hashed static files of the last 7 days into the new one (`.next/static`, the panel's `assets`), so a tab opened before the switch still loads its chunks (audit A10-6); switch `current` atomically and reload PM2. The deploy holds `.deploy.lock` throughout, and the health timer waits for it (audit A10-3).
5. Check health: the API's `/api/health` and the store's home page within 60 s, and a worker heartbeat written after PM2 replaced the processes, within two minutes. If PM2 fails to start the release, or a check fails, switch back to the previous one (checked the same way) and delete the failed release, so a later rollback never picks it.
6. Keep the last 5 releases.

The running site is untouched until step 4. A failed build or migration leaves the previous release serving.

Deploy another ref: `ssh vertex "vertexdigital-deploy <sha-or-origin/branch>"`.

Over an unstable connection, run it detached from the SSH session, so a dropped link cannot kill it mid-migration, then follow its journal:

```bash
ssh vertex "systemd-run --unit=vertexdigital-deploy-<date> --collect --property=TimeoutStartSec=infinity /usr/local/bin/vertexdigital-deploy"
ssh vertex "journalctl -u vertexdigital-deploy-<date> --no-pager -o cat | tail -40"
```

The migrate step prints "Migrations are up to date." whether it applied migrations or not: to confirm, count the applied ones (`select count(*) from drizzle.__drizzle_migrations`, one per file in `packages/db/migrations`).

### Migrations must stay backward compatible

The previous release keeps running until the switch, and a rollback runs old code against the migrated database. Write migrations as expand then contract: add columns and tables first, remove old ones in a later release once no deployed code uses them.

### One-way steps after a deploy

- **S20 price lists:** once the S20 release is healthy, run `pnpm --filter @vertex-digital/api pricing:reprice-lists` as the site user in the current release (the commands table in `AGENTS.md`). It adds the wholesale and cost rules and every list's prices. Until it runs, no list but retail is priced and a rollback stays safe; **after it, going back to a release before S20 needs `restore`, not `rollback`**: that code reads the newest price row of any list and would sell at the cost list's price. Migration 0082 (the release after) drops the retail default of `price_list_id` on `margin_rules`, `product_prices` and `orders`: from then on a release before S20 cannot even insert a rule, a price or an order.

## Roll back

```bash
ssh vertex "vertexdigital-deploy rollback"
```

Switches to the previous release and checks it; if it is unhealthy, switches back to the one that was running. Migrations are not reverted. Never roll back past a one-way step that has run ("One-way steps after a deploy"): restore instead. To restore the database as it was before a deploy, restore the snapshot named after that release (as the owner role; the password reaches `pg_restore` through its environment, never its arguments):

```bash
ssh vertex "vertexdigital-deploy restore <release>"
```

The restore writes `/srv/digital.vertexmedia.pro/.hold` first, so the health timer starts nothing (audit A10-1: it used to restart the apps on the current code within two minutes), stops the three apps, saves the current database to `shared/db-before-restore/` (never pruned), replaces the database, and leaves the apps stopped: start a release whose code matches the restored schema with `vertexdigital-deploy rollback` or `vertexdigital-deploy <ref>`, whose healthy switch removes `.hold`. Everything written after the snapshot (ledger journals, orders, queued jobs) is gone from the live database but kept in the saved dump: reconcile it before reopening the store (re-post the missing journals as new entries, never by editing rows; ADR 0003).

## Accounts

Customer registration stays closed in production until the pilot. It is the panel's `registration_open` switch (S05, F26: `/settings/switches`, closed by default); no migration or seed opens it. The former `REGISTRATION_OPEN` variable is ignored: remove it from `shared/.env`.

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

`vertexdigital-backup` writes, into `<time>.partial` renamed `<time>` once complete, the database dump, its table of contents, the environment, both nginx sites, the deployed revision and the stored files (a hard-linked snapshot of the previous backup: unchanged files take no extra space). Restore the database from a daily backup as the owner role:

```bash
ssh vertex "runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=vertex_digital_owner -d vertex_digital /var/backups/digital.vertexmedia.pro/<time>/database.dump"
```

Restore the files from the same backup:

```bash
ssh vertex "rsync -a /var/backups/digital.vertexmedia.pro/<time>/files/ /srv/digital.vertexmedia.pro/shared/files/ && chown -R vertexdigital:www-data /srv/digital.vertexmedia.pro/shared/files"
```

Check a copy before restoring it: `cd <backup> && sha256sum -c SHA256SUMS`. The dumps are not encrypted yet: encrypting them needs a key the owner holds off the server, set up with the off-server destination (audit A10-13). Backups stay on the server until an off-server destination is chosen. That is required before launch (ADR 0009). Interim (owner, 2026-10-20): they stay on this server until the owner subscribes to a second server, which then becomes the destination (Q1); a disk or server loss until then loses the backups with the database.

## First-time setup

Done on 2026-10-07 (ports 3060 and 3061 confirmed free in `/root/SERVER.md`, both A records added at Hostinger). For a rebuilt server, in a deploy session with the owner:
1. Read `/root/SERVER.md` on the server and confirm the ports 3060 (API) and 3061 (store) are free in its port map; if not, change them in every file listed in `deploy/CLAUDE.md`.
2. Confirm the server address in `provision.sh` (`SERVER_IP`, the address of `ssh vertex`) and point both DNS records (`digital`, `digital-admin` under `vertexmedia.pro`) at it.
3. The Sentry DSN (the owner's account, Q15) goes into `shared/.env` after provisioning (`SENTRY_DSN`); the Telegram bot as "Telegram admin bot" below says.

Then, from a checkout:

```bash
ssh vertex 'bash -s' < deploy/provision.sh
ssh vertex vertexdigital-deploy
ssh vertex "systemctl enable --now vertexdigital-health.timer"
```

`provision.sh` creates the owner and app roles with the app role's default privileges before the first migration, the `pgboss` schema owned by the owner, revokes `CONNECT` and `TEMPORARY` from `PUBLIC`, and generates the database passwords and app secrets (`CUSTOMER_AUTH_SECRET`, `ADMIN_AUTH_SECRET`, `ALTCHA_HMAC_KEY`, `SUPPLIER_KEYS_SECRET`, `ORDER_CODES_SECRET`, `PLAYER_CHECK_SECRET`, `STORE_REVALIDATE_SECRET`) into `shared/.env`, and the owner role's URL into `/etc/vertexdigital/owner.env`, without printing them. It issues each certificate through a temporary HTTP-only site, so a missing certificate can never break nginx for the other sites. Re-running it reinstalls the configuration files from `origin/main` (pass another ref as an argument) and leaves the database and secrets alone.

## Changing configuration

- nginx, fail2ban, systemd, logrotate or scripts: change `deploy/`, merge, then re-run `provision.sh`.
- The inline theme script in `apps/admin/index.html`: its hash is in the CSP in `deploy/nginx/vertexdigital-admin-csp.conf`, and `apps/admin/src/csp.test.ts` fails until both match; re-run `provision.sh` after the merge.
- Secrets: edit `shared/.env` on the server as `vertexdigital`, then `pm2 reload all --update-env`. Keep every line readable by a shell too (`set -a; . shared/.env` in ops commands): a value with anything but letters, digits and `_@%+=:,./-` (a space, `;`, `$`, `#`, `&`, quotes…) goes in single quotes, `NAME='value'`; the apps' parser (Node's `process.loadEnvFile` and `util.parseEnv`) and bash read a single-quoted value the same, while bash cuts an unquoted one at the space or `;` and runs the rest as a command (2026-10-14: `SMTP_PASSWORD`, line 30). `bash -n` does not catch it (the line is valid syntax); check the new line by its name only, never printing the value. Quoted on 2026-10-15 with the owner's approval: a 600 backup, every value's hash identical for the apps' parser and for a shell load before the swap, an atomic rename, `pm2 reload all --update-env`, health checked (API with its database, store, a worker heartbeat after the restart, no new error-log line); the backup and the older `/root/vertexdigital-env.bak` then shredded. A value holding a single quote itself needs the owner's decision (none does today). `provision.sh` writes only hex, base64 and URLs, which need no quotes. Rotating `CUSTOMER_AUTH_SECRET` or `ADMIN_AUTH_SECRET` signs everyone out (the admin secret also encrypts the TOTP secret: rotating it means the admin enrols again).
- USDT receiving addresses (S04, ADR 0018): `USDT_TRC20_ADDRESS` and `USDT_BEP20_ADDRESS` in `shared/.env`, the owner's own wallets (never a private key). Empty leaves that network unavailable; a value that fails its checksum stops the API from starting, so check the log after the reload. Change an address only when no USDT deposit is open (the panel's queue and pending count are empty): open deposits keep the address they showed, and a transfer to an old address is then caught only by its TXID. The panel shows the addresses read-only and cannot change them. The worker checks the same addresses at boot and refuses a bad one too.
- Chain readers (S04 PR 2), in the worker's environment: `CHAIN_READER=live` (production refuses `fake`), `TRONGRID_API_KEY` (required when the TRC20 address is set; `TRONGRID_API_URL` defaults to `https://api.trongrid.io`) and `BSC_RPC_URL` (an HTTPS JSON-RPC endpoint of a BSC provider, required when the BEP20 address is set; a provider's key is part of the URL, so treat it as a secret; a URL with a user name or password (`https://user:pass@...`) is refused at boot, and the worker keeps URL paths and queries out of Sentry). The provider must allow `eth_getLogs` over 1,000 blocks, `eth_getTransactionReceipt` and the `finalized` block tag: the keyless public endpoint `bsc-rpc.publicnode.com` refuses receipts (HTTP 403, "Archive requests require a personal token"), so the scanner sees a transfer and then fails on every run until the URL carries a key (production uses NodeReal MegaNode since 2026-10-14). Since the audit of 2026-10-17 (F5-8) a URL with a user name or password stops the worker at boot: production's NodeReal URL carries its key in the path, which is accepted. A rollback to a release before that audit reads the TRON cursor `<ms>:continue` as no number: if TRC20 then reads `delayed`, set its cursor back to the number before the colon. Migration 0063 (F5-7) stops the deploy if one TXID is already claimed under both networks: read `payment_references` for it and ask the owner which credit stands before going on. Check a new URL on the server before the reload, without printing it: each of the four calls must answer 200. After the reload, the panel's deposit settings show each network's last scan: a network stays `delayed` (new USDT deposits wait) until its scanner has caught up.

### Supplier keys (S07, ADR 0005)
1. Before the first deploy that contains S07, add `SUPPLIER_KEYS_SECRET=$(openssl rand -base64 32)` to `shared/.env` (read by the API and the worker; both refuse to start in production without it). `provision.sh` generates it on a new server; an existing `shared/.env` needs it added by hand.
2. Never change it once a supplier's keys are set: it decrypts them. Rotating it means setting every supplier's keys again in the panel (`/suppliers/<code>`, "تعيين المفاتيح"). Back it up with the database backups' credentials, never in the repository.
3. `SUPPLIER_FAKE_ENABLED` stays unset in production: the API and the worker refuse to start with it.

### Order codes (S08, ADR 0004)
1. Before the first deploy that contains S08, add `ORDER_CODES_SECRET=$(openssl rand -base64 32)` to `shared/.env`: a key of its own, not `SUPPLIER_KEYS_SECRET` (read by the API and the worker; both refuse to start in production without it). `provision.sh` generates it on a new server; an existing `shared/.env` needs it added by hand.
2. Never change it once an order code is stored: it is the only way to show the codes customers bought, and the stored supplier webhooks. Back it up with the database backups' credentials, never in the repository.
3. nginx limits purchases (`vdpurchase`), code reveals (`vdreveal`) and supplier webhooks (`vdwebhook`, 64 KB bodies): re-run `provision.sh` after the merge so the new zones and locations are installed.

### Player checks and the store's catalog cache (S09)
1. Before the first deploy that contains S09, add `PLAYER_CHECK_SECRET=$(openssl rand -base64 32)` to `shared/.env`: a key of its own (read by the API only; it refuses to start in production without it). `provision.sh` generates it on a new server; an existing `shared/.env` needs it added by hand. Changing it only empties the player-check cache (24 hours at most).
2. nginx limits player checks (`vdplayercheck`, POST only) and answers 404 for `/_internal/` on the public host: re-run `provision.sh` after the merge so the zone and the locations are installed.
3. `STORE_REVALIDATE_SECRET` (at least 32 characters, `openssl rand -hex 32`) is read by the worker and the store: the store refuses to start in production without it, and copies only `API_INTERNAL_URL`, `STORE_URL` and `STORE_REVALIDATE_SECRET` from `shared/.env` (through the release's `.env`, `apps/store/src/instrumentation-node.ts`): the store process never holds the database password or the other secrets. `provision.sh` generates it on a new server; an existing `shared/.env` that lacks it needs it added by hand. The store's server components read the catalog from `API_INTERNAL_URL` at request time (never during the build), cache it under the `catalog` tag for at most 5 minutes, and the worker's `store.revalidate` expires it after a change. `STORE_URL` gives the sitemap and the Open Graph images their absolute links.

### Cart, gifts and share links (S10)
1. No new secret. nginx adds the zone `vdshare` (60 a minute per address) on `/api/shares/`, `/g/` and `/r/`, and puts `/api/checkouts` under `vdpurchase`: re-run `provision.sh` after the merge so the zone and the locations are installed.
2. The store renders `/g/<token>` and `/r/<token>` per request and reads `/api/shares/<token>` from `API_INTERNAL_URL` with the visitor's `X-Forwarded-For` (set by nginx), so the API's per-address limit counts each visitor, not the store. `STORE_URL` gives the pages their `og:image` and verification links.
3. The share images are rendered by the API with `sharp` from the TrueType fonts in `apps/api/assets/fonts` (part of the release, nothing to install).

### Telegram admin bot (S05, ADR 0019)
1. The owner creates the bot with BotFather (`/newbot`) and keeps its token private.
2. In `shared/.env`: `TELEGRAM_BOT_TOKEN` (the worker only reads it; the API never does), `TELEGRAM_BOT_USERNAME` (without `@`), `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`, read by both) and `TELEGRAM_WEBHOOK_URL=https://digital.vertexmedia.pro/api/webhooks/telegram`. `TELEGRAM_TRANSPORT` defaults to `api` in production (`log` is refused there). Remove the former `TELEGRAM_ALERTS_CHAT_ID`: it is ignored.
3. `pm2 reload all --update-env`: at start the worker calls `setWebhook` with the URL, the secret and the update kinds `message` and `callback_query` (every start, idempotent; a failure is logged and retried at the next start).
4. In the panel, `/settings/telegram` → "ربط تيليجرام" (re-authentication), then open the link on the owner's phone and press Start. The page turns to linked; "إرسال رسالة اختبار" checks the whole path.

nginx accepts the webhook only from Telegram's published ranges (`deploy/nginx/digital.vertexmedia.pro`); recheck them at core.telegram.org/bots/webhooks when Telegram announces a change, then re-run `provision.sh`. Rotating the secret: change it in `shared/.env` and reload; the worker registers the new one. A leaked token: revoke it in BotFather (`/revoke`), set the new one and reload.

### Web push (S15, F24)
1. Generate the VAPID pair once, on any machine with Node (never in the repository, a log or chat):
   ```bash
   node -e "const e=require('crypto').createECDH('prime256v1');e.generateKeys();const d=Buffer.alloc(32);e.getPrivateKey().copy(d,32-e.getPrivateKey().length);console.log('VAPID_PUBLIC_KEY='+e.getPublicKey().toString('base64url'));console.log('VAPID_PRIVATE_KEY='+d.toString('base64url'))"
   ```
2. In `shared/.env`: `VAPID_PUBLIC_KEY` (read by the API, which serves it to the store, and the worker), `VAPID_PRIVATE_KEY` (the worker only; the API never reads it), `VAPID_SUBJECT=mailto:info@vertexmedia.pro` (defaults to `mailto:` and `EMAIL_FROM`) and `PUSH_TRANSPORT=web-push` (its default in production; `log` is refused there). The worker refuses to start with one key of the pair and not the other. Without both, push stays off: the store shows no push controls and the worker drops push jobs; email and the notification center are unaffected.
3. `pm2 reload all --update-env`. Then, in the store, signed in as a test customer, turn push on from the preferences ("الهاتف" column) and place a test deposit: the device gets a push. The store's `/sw.js` needs nothing from nginx (the store sends its headers).
4. Never change the pair without a reason: a new pair drops every device's subscription. Devices re-subscribe on their next signed-in visit; until then the worker skips and deletes the rows made with the old key (S15 PS7). A leaked private key: generate a new pair, set both and reload.
