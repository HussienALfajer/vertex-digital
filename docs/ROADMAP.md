# Roadmap

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done. Feature IDs refer to `docs/product/v1-scope.md`. Production is deployed once at the end of each phase (`docs/workflow.md`).

## Phase 0 — Foundation
- [~] Product scope, decisions and working method documented; Claude Code setup (settings, `checker` and `reviewer` subagents, skills `spec`, `feature-slice`, `db-migration`, `supplier-adapter` (no shipping skill: every task opens its PR with auto-merge at once), Biome hook, spec template)
- [ ] Monorepo scaffold (pnpm, Turborepo, TypeScript, Biome, shared config), folder `CLAUDE.md` files, cloud session scripts, `pnpm db:setup-local`
- [ ] `packages/db` with Drizzle, first migration, conventions test; ledger tables with append-only grants and trigger, and the posting function with concurrency tests (ADR 0003)
- [ ] `packages/contracts`: money math (`CURRENCY_SCALE`, rounding, SYP conversion), order transition table, error codes, permission map skeleton
- [ ] `packages/suppliers`: `SupplierAdapter` interface, HMAC helpers, the `fake` adapter
- [ ] `apps/api` skeleton: NestJS 12, Standard Schema validation, OpenAPI, pino, Sentry, `/api/health`, access decorators and architecture test, rate limits, ALTCHA verification
- [ ] `apps/worker` skeleton: pg-boss wiring, heartbeat job, Sentry, Telegram alert channel
- [ ] `apps/store` skeleton: Next.js 16, Cache Components, Arabic RTL shell, dark default, performance budget, Playwright smoke and screenshots
- [ ] `apps/admin` skeleton: Vite, TanStack Router/Query, RTL shell, Playwright smoke
- [ ] Design system: tokens from `brand/identity.md`, Vertex Hub components copied and adapted, VERTEX DIGITAL wordmark (fonts: Madani pending its license; fallback until then)
- [ ] Auth skeletons: customer and staff Better Auth instances, sign-in pages, staff TOTP enforcement, first-owner CLI
- [ ] CI: typecheck, lint, test, build, E2E, migration drift, OpenAPI drift, gitleaks
- [ ] Deployment skeleton on the VPS: both hosts, TLS, nginx limits and headers, Brotli, fail2ban jails, PM2 (store, api, worker), atomic releases, health checks, daily backups, `docs/deployment.md`

## Phase 1 — Money core
- [ ] F01 Customer accounts
- [ ] F02 Staff accounts, roles, 2FA and audit log
- [ ] F03 Wallet and ledger
- [ ] F04 Exchange rate and SYP display
- [ ] F05 Sham Cash deposits
- [ ] F06 USDT deposits
- [ ] F07 Telegram admin bot
- [ ] F26 Store switches and emergency stop (registration closed by default)
- [ ] F27 Customer notifications (email and notification center; deposit events)
- [ ] Automations A01, A09, A10, A12, A13, A16, A17
- [ ] Production deploy of Phase 1 (registration closed: test customers only)

## Phase 2 — Selling
- [ ] F08 Catalog
- [ ] F09 Suppliers, product mapping and price sync (adapters: `shop2topup`, `wdgzone`, `manual`)
- [ ] F10 Pricing engine
- [ ] F11 Orders and fulfilment engine
- [ ] F12 Store home and game pages
- [ ] F13 Purchase flow and live order tracking
- [ ] F14 Saved player IDs and one-tap recharge
- [ ] F15 Smart search
- [ ] F16 Cart, gift top-up and shareable receipt
- [ ] Automations A02–A08, A14, A15 (order notifications through F27)
- [ ] Production deploy of Phase 2 (registration still closed)

## Phase 3 — Operations
- [ ] F17 Live orders room
- [ ] F18 Admin dashboard
- [ ] F19 Customers administration
- [ ] F20 Daily reconciliation (A11)
- [ ] F21 Content
- [ ] F22 Reports
- [ ] F23 Support tickets
- [ ] F24 PWA and web push
- [ ] F25 Live activity
- [ ] Production deploy of Phase 3

## Pilot — open quiet launch
- [ ] Launch checklist done (below)
- [ ] Registration opened with the F26 switch, without promotion; low deposit and purchase limits
- [ ] Limits raised step by step as reconciliation stays clean

## Phase 4 — Growth (after V1)
- [ ] Resellers with tiers and a reseller API
- [ ] Telegram purchase bot
- [ ] Loyalty and referrals
- [ ] Syrian mobile credit
- [ ] Sham Cash automation
- [ ] English UI

## Launch checklist
- [ ] Off-server backups configured and a restore tested
- [ ] Domains and TLS for both hosts
- [ ] Production secrets on the server only; supplier keys entered in the panel
- [ ] SPF, DKIM and DMARC for the sending mailbox
- [ ] VPS IP registered in supplier allowlists; one small live order per supplier approved by the owner
- [ ] Madani Arabic web license and files in place
- [ ] Terms, privacy and refund policies published
- [ ] Owner and staff accounts with 2FA; Telegram bot linked
