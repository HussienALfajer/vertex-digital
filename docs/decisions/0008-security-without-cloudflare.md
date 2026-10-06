# 0008 — Security and performance without Cloudflare

Status: Accepted · Date: 2026-10-06

## Context
Cloudflare (and similar CDNs) is blocked in Syria, so the usual managed shield and CDN are not available. The store holds money, attracts bots (credential stuffing, OTP abuse, card-testing-style deposit spam) and will be attacked. The server is shared with other sites, so one site must not be able to exhaust it.

## Decision

### Edge (nginx, the only public listener)
- TLS by Let's Encrypt, HSTS, modern ciphers; HTTP→HTTPS redirect.
- `limit_req` zones per IP: general pages, `/api` general, auth (sign-in, sign-up, OTP, reset), purchase and deposit creation, receipt upload, webhooks; `limit_conn` per IP; tight body size limits (larger only on the receipt upload route); slow-client timeouts.
- Security headers on both hosts: CSP (nonce-based on the store, hash-based on the admin), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors 'none'`. The admin host also sends `X-Robots-Tag: noindex`.
- `/api/admin/` returns 404 on the store host (ADR 0007). Internal locations (receipt files, the store's revalidation endpoint) are never reachable from outside.
- **Brotli** (nginx brotli module) and gzip for text; long-lived immutable caching for hashed assets; `proxy_cache` for anonymous catalog pages with short TTLs, bypassed when a session cookie is present.
- Access logs mask tokens and never include request bodies.

### Server
- **fail2ban** jails on nginx: repeated 401/403/429 and auth failures per IP, alongside the server's existing SSH jail.
- The app processes listen on `127.0.0.1` only and run as their own system user (ADR 0009).

### Application
- **ALTCHA** (self-hosted proof-of-work, HMAC key from the environment): on auth forms, OTP requests, deposit creation and ticket creation; escalated to every form when an "under attack" setting is on.
- API rate limits per customer and per IP on top of nginx, with counters in PostgreSQL where they must survive restarts (OTP, deposits).
- Zod validation of every input; Drizzle parameterized queries only; no raw SQL built from input.
- Same-origin check on every state-changing request (CSRF); cookies `SameSite=Lax`, `__Host-`.
- Uploads: images only, magic-byte check, size cap, re-encoded with sharp, EXIF stripped, stored outside the web root, served after authorization.
- Webhooks: HMAC with timing-safe compare, timestamp tolerance and stored event ids against replay (ADR 0005).
- Secrets only in the server's `.env` (mode 600) and, for supplier keys, encrypted in the database. gitleaks runs in CI; `.env.example` holds fake values only.
- Logs and Sentry events scrub tokens, keys, passwords, OTPs, receipts and phone numbers.
- Fraud controls: per-customer limits, new-account limits, velocity rules, freezing (F19), and the deposit signals (ADR 0006).

### Speed without a CDN
- The store renders on the server and caches catalog pages (ADR 0002); images are resized to a few fixed widths and served as AVIF/WebP from nginx with long cache; fonts are subset and preloaded; JavaScript on the first page is kept small (budget set in the Phase 0 scaffold and checked in CI).

## Consequences
- A large volumetric DDoS cannot be absorbed by this setup; the response is the hosting provider's network protection and temporary stricter limits. This risk is accepted for V1.
- Every new public endpoint needs a rate-limit zone and a test that it rejects abuse; the reviewer checks it.
