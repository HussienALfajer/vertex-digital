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
- [x] Design system: tokens from `brand/identity.md`, Vertex Hub components copied and adapted, VERTEX DIGITAL logo (final, Q16 resolved 2026-10-15; fonts: Noto Kufi Arabic and Montserrat, Q2 resolved 2026-10-14)
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
- [x] Production deploy of Phase 1 (registration closed: test customers only): deployed on 2026-10-12 in one release with Phases 2 and 3 (commit `6230b05`, all of `main`)

## Phase 2 — Selling
- [x] S06 Catalog and pricing: F08 Catalog · F10 Pricing engine; spec `docs/specs/S06-catalog-and-pricing.md` (two PRs: contracts, db and the `catalog` and `pricing` API modules, then the admin `/catalog`, game and `/pricing` screens with E2E)
- [x] S07 Suppliers: F09 alone (product mapping and price sync; adapters `wdgzone`, `manual`); spec `docs/specs/S07-suppliers.md` (three PRs: contracts, db and api; worker jobs; the admin `/suppliers`, routes drawer, `/pricing/reviews` and policy screens with E2E)
- [x] S07 real adapter: `/supplier-adapter wdgzone` (`docs/suppliers/wdgzone.md`; real orders may be routed to it since S16 PR 1's re-send safety net (RS1–RS4, Q18 resolved); the launch checklist's small live order still applies); the other planned supplier was dropped on 2026-10-14 (ADR 0031)
- [x] S08 Orders and fulfilment: F11 alone (money core); spec `docs/specs/S08-orders-and-fulfilment.md` (three PRs: contracts, db and api with the purchase and webhook routes; worker jobs; store `/orders` and the admin order screens with E2E)
- [x] S09 Storefront and purchase: F12 Store home and game pages · F13 Purchase flow and live order tracking · F15 Smart search; spec `docs/specs/S09-storefront-and-purchase.md` (three PRs: contracts, db and api with player checks and reservations; worker jobs; store pages, buy box, search and admin additions with E2E)
- [x] S10 Convenience: F14 Saved player IDs and one-tap recharge · F16 Cart, gift top-up and shareable receipt; spec `docs/specs/S10-convenience.md` (two PRs: contracts, db and api with checkouts, saved IDs, share links and images; store cart, buy box additions, share pages and admin additions with E2E)
- Automations A02–A08, A14, A15 (order notifications through F27): inside the spec they belong to
- [x] Production deploy of Phase 2 (registration still closed): deployed on 2026-10-12 in one release with Phases 1 and 3 (commit `6230b05`)

## Phase 3 — Operations
- [x] S11 Live operations: F17 Live orders room · F18 Admin dashboard; spec `docs/specs/S11-live-operations.md` (two PRs: contracts, db, api with the admin stream and the dashboard read, worker guards; the admin dashboard home page, `/orders/live` with its side sheet, the reroute and manual fulfil dialogs with E2E)
- [x] S12 Customers and support: F19 Customers administration · F23 Support tickets; spec `docs/specs/S12-customers-and-support.md` (two PRs: contracts, db with the freeze and cap guards, api `customers` and `support` modules, worker jobs and Telegram; the admin customers, profile, support queue, thread and settings screens and the store frozen state and support pages with E2E)
- [x] S13 Reconciliation and reports: F20 Daily reconciliation (A11) · F22 Reports; spec `docs/specs/S13-reconciliation-and-reports.md` (three PRs: contracts, db with the cost of goods sign fix and api; worker jobs and chain balance reads; the admin `/reconciliation` and `/reports` screens with E2E)
- [x] S14 Content and live activity: F21 Content · F25 Live activity; spec `docs/specs/S14-content-and-live-activity.md` (two PRs, owner 2026-10-11: contracts, db and the api `content` module; the `RichText` renderer, the admin `/content` screens and the store announcement bar, banners, activity cards, `/faq` and the four pages, with E2E). The page texts stay unpublished until Q10 is answered before the pilot
- [x] S15 PWA and web push: F24 alone; spec `docs/specs/S15-pwa-and-web-push.md` (two PRs, owner 2026-10-11: contracts, db, the api push routes and the worker's `push.send`; the store manifest, `/sw.js`, `/offline`, install, the permission card, the device switch and the "الهاتف" preferences column, the admin profile's device count, with E2E). Pushes and the PWA install were confirmed by the owner on a real phone in Syria on 2026-10-15
- [x] S16 Supplier catalog and admin orders (added by the owner on 2026-10-12, before the pilot; extends F08, F09, F11): the re-send safety net (Q18), admin purchases (walk-in, on behalf, gift, compensation) with owner drawings, the supplier catalog browser and category import, supplier images and fields; spec `docs/specs/S16-supplier-catalog-and-admin-orders.md` (four PRs: re-send rule and admin purchases; catalog back end; catalog panel; two fields and select fields); PR 1 (re-send rule and admin purchases), PR 2 (supplier catalog back end: category mirror, import and link, images, statement, platform status, low-stock alerts) and PR 3 (the panel: the catalog tab, import and link sheets, offer fields, the statement, cards and badge, "تفعيل الكل", the game page's links and supplier cover, stock chips, nearby supplier orders) and PR 4 (two fields and select fields with option maps on routes and attempts, WDG delivery replies with pins, the poll's 202 read through the order's state; Q19 answered on 2026-10-13: 4,944 of WDG's 5,602 top-ups now supported) done
  - [x] PR 1: the re-send safety net (RS1–RS4) and purchases from the panel (AP1–AP15, AM1–AM4): `/orders/new` in four modes, owner drawings and the owner daily cap, the customer's chips, reports and reconciliation
  - [x] PR 2: supplier catalog, back end (SC, IM, SF rules; nearby supplier orders of RS3/SF4)
  - [x] PR 3: supplier catalog, panel
  - [x] PR 4: two fields and select fields, WDG delivery replies (MF1–MF5; Q19 answered on 2026-10-13)
- [x] Production deploy of Phase 3: deployed on 2026-10-12 in one release with Phases 1 and 2 (commit `6230b05`, all of `main`); the server was rebooted afterwards and every site's health check passed. The owner confirmed pushes and the PWA install on a real phone in Syria on 2026-10-15 (S15)
- [x] Production deploy of S16: deployed on 2026-10-13 (commit `0495047`, all of `main`: migrations 0050–0059, no new secret and no `deploy/` change, so `provision.sh` was not re-run); the health checks passed and no error was logged after the switch
- [x] Production deploys of 2026-10-14: the worker memory fixes (commits `58dbeee`, then `39ead74`), then the SHOP2TOPUP drop, ADR 0031 step 1 (commit `e849fa5`, all of `main`: migration 0060 applied, 61 migrations, the SHOP2TOPUP supplier row deleted with nothing referencing it; no new secret, and `deploy/ecosystem.config.cjs` is read from the release, so `provision.sh` was not re-run); the API, store and worker came back online and no new worker error was logged after the switch
- [x] ADR 0031 step 2: migration 0061 drops the `supplier_code` value `shop2topup` and the `store_switch` value `shop2topup_paused`; deployed on 2026-10-14 (commit `c2ac68e`, all of `main`: 62 migrations applied, neither enum holds a SHOP2TOPUP value; no new secret and no `deploy/` change, so `provision.sh` was not re-run); the API, store and worker came back online and the API health check answers 200

- [x] Production deploys of 2026-10-14 and 2026-10-15: the launch hardening (PR #94, commit `0ce64f0`, 2026-10-14; `provision.sh` re-run for the store's `/favicon.ico` nginx location), then the catalog counts and covers fix (PR #97, commit `b0794fa`, 2026-10-15); no migration (62 applied), no new secret; checked on 2026-10-15: `current/REVISION` is `b0794fa`, the installed nginx site matches the repository, `/favicon.ico` and `/api/health` answer 200, the three PM2 processes online with no unstable restart

## Pilot — open quiet launch
- [ ] Full system test of every V1 feature on production, end to end, before any second supplier is added (owner, 2026-10-15); features 1–5 of 22 accepted (features 4 and 5 on 2026-10-16, case 4.12 step 2 due 2026-10-17), progress and findings in `docs/testing/v1-system-test.md`
- [ ] Second automatic supplier, chosen by the owner after the full system test (`/supplier-adapter`; Q17 answered first; FazerCards evaluated in `docs/suppliers/fazercards.md`)
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
- [x] Domains and TLS for both hosts (checked 2026-10-12)
- [ ] Production secrets on the server only; supplier keys entered in the panel
- [x] SPF, DKIM and DMARC for the sending mailbox (checked 2026-10-14 on public DNS: SPF includes Hostinger mail, DKIM `hostingermail-a` published, DMARC `p=quarantine`)
- [x] VPS IP registered in the supplier's allowlist; one small live order approved by the owner (WDGZone: key in the panel and IP registered by the owner on 2026-10-14, healthy and syncing; live order VO-5QXTCT on 2026-10-14: a walk-in 60 UC for $0.99 approved and confirmed by the owner, sent at once, delivered in under two minutes through the signed webhook (WDG order 3507, cost $0.887, the supplier balance down by exactly that))
- [x] Arabic typeface: the owner keeps Noto Kufi Arabic and Montserrat for launch (Q2 resolved 2026-10-14; Madani not licensed)
- [x] Terms, privacy and refund policies published (with "من نحن", version 1 of each, 2026-10-13; texts in `docs/content/`)
- [x] Admin account with 2FA; Telegram bot linked (2026-10-12: `info@vertexmedia.pro`, TOTP enrolled, the bot linked and its test message received)
- [x] USDT receiving addresses and chain-reader keys in the server environment; one small live USDT deposit per network approved by the owner (S04; 2026-10-14: TRC20 $1.50 (1.5024 USDT) found by the scanner and credited in about a minute; BEP20 $3.00 (3.0075 USDT) credited once `BSC_RPC_URL` moved from the keyless public endpoint, which refuses `eth_getTransactionReceipt`, to a NodeReal key; each with its three-posting journal, audit entries and the credited email)
