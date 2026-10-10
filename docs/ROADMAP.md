# Roadmap

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done. Feature IDs (F, A) refer to `docs/product/v1-scope.md`. Work is grouped into specs (S01–S15): one spec, one `/spec` session, covering related features; the money cores (F03, F11) and the external-money integrations (F06, F09) stay alone. Production is deployed once at the end of each phase (`docs/workflow.md`).

## Phase 0 — Foundation
- [x] Product scope, decisions and working method documented; Claude Code setup (settings, `checker` and `reviewer` subagents, skills `spec`, `feature-slice`, `db-migration`, `supplier-adapter` (no shipping skill: every task opens its PR with auto-merge at once), Biome hook, spec template)
- [x] Monorepo scaffold (pnpm, Turborepo, TypeScript, Biome, shared config in `packages/config`), cloud session scripts, `pnpm db:setup-local`; each later folder brings its own `CLAUDE.md`
- [x] `packages/db` with Drizzle, first migration, conventions test; ledger tables with append-only grants and trigger, and the posting function with concurrency tests (ADR 0003)
- [x] `packages/contracts`: money math (`CURRENCY_SCALE`, rounding, SYP conversion), order transition table (ADR 0004, 0013), error codes, 100% coverage gate
- [x] `packages/suppliers`: `SupplierAdapter` interface, HMAC helpers, the `fake` adapter
- [x] `apps/api` skeleton: NestJS 12, Standard Schema validation, OpenAPI, pino, Sentry, `/api/health`, access decorators and architecture test, rate limits, ALTCHA verification
- [x] `apps/worker` skeleton: pg-boss wiring, heartbeat job, Sentry, Telegram alert channel
- [x] `apps/store` skeleton: Next.js 16, Cache Components, Arabic RTL shell, dark default, customer sign-in page, performance budget, Playwright smoke and screenshots
- [x] `apps/admin` skeleton: Vite, TanStack Router/Query, RTL shell, staff sign-in with TOTP and enrolment, client typed from OpenAPI, Playwright smoke and screenshots
- [x] Design system: tokens from `brand/identity.md`, Vertex Hub components copied and adapted, VERTEX DIGITAL logo draft (Q16: designer files may replace it; fonts: Madani pending its license, fallback until then)
- [x] Auth skeletons: customer and staff Better Auth instances, staff TOTP enforcement, first-owner CLI, permission map skeleton in `packages/contracts`, sign-in pages in the store and the panel
- [x] CI: typecheck, lint, test, build, gitleaks and migration drift (PostgreSQL 17 service, non-superuser app role), OpenAPI and admin client drift, a start check of the built API and worker, E2E (store and panel, screenshots as artifacts)
- [x] Deployment skeleton: `deploy/` (both hosts, TLS, nginx limits and headers, Brotli when available, fail2ban jail, PM2 store/api/worker, atomic releases with rollback, health checks, daily backups) and `docs/deployment.md` written; provisioned and first deployed on 2026-10-07

## Phase 1 — Money core
- [x] S01 Accounts: F01 Customer accounts · F02 Admin account, 2FA and audit log (one admin, no staff: ADR 0016)
- [x] S02 Wallet and ledger: F03 alone (money core); spec `docs/specs/S02-wallet-ledger.md`
- [x] S03 Exchange rate and Sham Cash deposits: F04 Exchange rate and SYP display · F05 Sham Cash deposits; spec `docs/specs/S03-exchange-rate-sham-cash-deposits.md`
- [x] S04 USDT deposits: F06 alone; spec `docs/specs/S04-usdt-deposits.md` (three PRs: contracts, db and api; chain readers and worker jobs; store and admin screens)
- [x] S05 Alerts and control: F07 Telegram admin bot · F27 Customer notifications (email and notification center; deposit events) · F26 Store switches and emergency stop (registration closed by default); spec `docs/specs/S05-alerts-and-control.md` (four PRs: F26 switches, F27 notifications, the Telegram bot foundation, then the deposit cards, decisions from Telegram, the review reminder and the daily summary)
- Automations A01, A09, A10, A12, A13, A16, A17: each is specified and built inside the spec it belongs to, not as a separate item
- [ ] Production deploy of Phase 1 (registration closed: test customers only)

## Phase 2 — Selling
- [x] S06 Catalog and pricing: F08 Catalog · F10 Pricing engine; spec `docs/specs/S06-catalog-and-pricing.md` (two PRs: contracts, db and the `catalog` and `pricing` API modules, then the admin `/catalog`, game and `/pricing` screens with E2E)
- [x] S07 Suppliers: F09 alone (product mapping and price sync; adapters `shop2topup`, `wdgzone`, `manual`); spec `docs/specs/S07-suppliers.md` (three PRs: contracts, db and api; worker jobs; the admin `/suppliers`, routes drawer, `/pricing/reviews` and policy screens with E2E)
- [ ] S07 real adapters: `/supplier-adapter shop2topup`, then `/supplier-adapter wdgzone`, one PR each once its account and API documentation arrive (Q12)
- [x] S08 Orders and fulfilment: F11 alone (money core); spec `docs/specs/S08-orders-and-fulfilment.md` (three PRs: contracts, db and api with the purchase and webhook routes; worker jobs; store `/orders` and the admin order screens with E2E)
- [x] S09 Storefront and purchase: F12 Store home and game pages · F13 Purchase flow and live order tracking · F15 Smart search; spec `docs/specs/S09-storefront-and-purchase.md` (three PRs: contracts, db and api with player checks and reservations; worker jobs; store pages, buy box, search and admin additions with E2E)
- [x] S10 Convenience: F14 Saved player IDs and one-tap recharge · F16 Cart, gift top-up and shareable receipt; spec `docs/specs/S10-convenience.md` (two PRs: contracts, db and api with checkouts, saved IDs, share links and images; store cart, buy box additions, share pages and admin additions with E2E)
- Automations A02–A08, A14, A15 (order notifications through F27): inside the spec they belong to
- [ ] Production deploy of Phase 2 (registration still closed)

## Phase 3 — Operations
- [x] S11 Live operations: F17 Live orders room · F18 Admin dashboard; spec `docs/specs/S11-live-operations.md` (two PRs: contracts, db, api with the admin stream and the dashboard read, worker guards; the admin dashboard home page, `/orders/live` with its side sheet, the reroute and manual fulfil dialogs with E2E)
- [~] S12 Customers and support: F19 Customers administration · F23 Support tickets
- [ ] S13 Reconciliation and reports: F20 Daily reconciliation (A11) · F22 Reports
- [ ] S14 Content and live activity: F21 Content · F25 Live activity
- [ ] S15 PWA and web push: F24 alone
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
- [ ] Admin account with 2FA; Telegram bot linked
- [ ] USDT receiving addresses and chain-reader keys in the server environment; one small live USDT deposit per network approved by the owner (S04)
