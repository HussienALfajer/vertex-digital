# 0009 — Deploy to the existing VPS with PM2 and nginx

Status: Accepted · Date: 2026-10-06

## Context
The owner runs an Ubuntu 24.04 VPS with Node 24, PostgreSQL 17, nginx, PM2 and fail2ban, already hosting other sites (including Vertex Hub, deployed the same way). Docker is not installed. Sites are isolated from each other, and the server's conventions are documented in `/root/SERVER.md` on the server.

## Decision
Follow the server's conventions, as Vertex Hub does:
- **Domains:** store and API at `digital.vertexmedia.pro` (API under `/api`); admin panel at `digital-admin.vertexmedia.pro` (its own `/api` proxied to the same API, staff routes only). DNS records point at the VPS; TLS by Let's Encrypt.
- **Isolation:** a dedicated system user (no sudo) and PM2 service for Vertex Digital; processes `store` (Next.js), `api` and `worker`, all on `127.0.0.1` with ports chosen at provisioning after reading `/root/SERVER.md` (free ports, recorded in `docs/deployment.md`). nginx is the only public gateway and serves the admin SPA build and static assets directly.
- **Layout:** code in `/srv/digital.vertexmedia.pro/` with atomic releases (`releases/<time>-<sha>`, `current` symlink, `shared/.env` mode 600, `shared/files/` for receipts and attachments outside the releases); app logs in `/var/log/digital.vertexmedia.pro/`; nginx logs in `/var/log/nginx/<host>.*.log`; backups in `/var/backups/digital.vertexmedia.pro/`.
- **Database:** PostgreSQL 17, a dedicated database and role (`vertex_digital`), `CONNECT` revoked from `PUBLIC`. The app role has no `UPDATE`/`DELETE` on ledger and audit tables (ADR 0003).
- **Deploys:** everything on the server comes from `deploy/` in the repository (provision script, deploy script, PM2 ecosystem, nginx sites and snippets, fail2ban filters and jails, systemd timers, logrotate). The deploy fetches `origin/main`, builds, snapshots the database, migrates, switches `current`, reloads PM2, checks health and rolls back automatically if unhealthy. Never as root, never by hand.
- **Health and backups:** a health timer restarts unhealthy processes with a cool-down; daily database and files backups. An **off-server backup destination is required before launch** (open question).
- Deploys happen at the end of a phase, not after each feature (`docs/workflow.md`), except hotfixes the owner asks for. Server commands always need the owner's explicit approval in the conversation.
- The VPS outbound IP is registered in supplier IP allowlists (ADR 0005).

## Consequences
- Three Node processes for this site on a shared server: memory limits are set per process in the PM2 ecosystem and checked at provisioning.
- No staging environment in V1; the fake supplier and test mode settings keep risky tests off production.
- `docs/deployment.md` (the runbook) is written with the deployment skeleton in Phase 0.
