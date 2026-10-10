# TASKS — S10 Convenience

Spec: `docs/specs/S10-convenience.md` (F14, F16; ADRs 0003, 0004, 0011, 0015, 0019, 0022, 0023, 0024). Two PRs, as the spec's implementation notes suggest; each leaves `main` green.

## PR 1 — Contracts, db, api (checkouts, saved IDs, gifts, share links and images, admin additions), bridge · Opus 5.5 `high`
- [x] Contracts `orders.ts`: limits, `savedPlayerLabelSchema`, `savedPlayerSchema`, `giftSchema`, `createOrderSchema` (`savePlayer`, `gift`), checkout line/request/response schemas, receipt options, share kinds, token, link and public share schemas; order shapes gain `checkoutId`, `isGift`, `repeatable`, `gift`, `shareLinks`
- [x] Contracts pure rules (100% coverage): `giftTextAllowed`, `maskFieldValue`, `canonicalFields`, `shareStage`, `cartLineKey`, `checkoutTotal`
- [x] Contracts: notification `checkout_finished` and template `customer_checkout_finished`; wallet `purchase` extras `checkout`; error codes `CHECKOUT_REFUSED`, `ORDER_NOT_SHAREABLE` with Arabic store and admin text; audit `order.share_revoked` with its label, `order.paid` details
- [x] Db (`/db-migration`): `checkouts` (trigger: only `finished_at` once), `orders` changes (checkout pair, partial unique journal, journal match on insert, no reserved cart line, gift columns and checks, identity guard), `saved_players`, `order_share_links` (trigger, one live link per kind); grants; tests
- [x] Db write path: `checkoutOrders` beside `purchaseOrder` sharing its line checks (switches lock, products `FOR SHARE` in id order, all refusals collected, one journal M1); saved IDs (SP1, SP2, SP4, SP6) and gift link (GF4) in purchase, RS4 payment and checkout; CT7 finishing hook in the terminal path; `notifyCustomer` without email (CT8); concurrency tests (one key in parallel, repricing and stop races, opposite product order, two orders finishing together, checkout vs single purchase on one balance, journal = sum of orders)
- [x] Api `orders`: saved-players routes; `POST /api/checkouts` (idempotency, purchase rate limit counted once); order extensions (save, gift, `checkout` filter, `repeatable`, `shareLinks`); receipt/gift link routes and revoke (20 per hour); public `GET /api/shares/:token` and `/image` (sharp + SVG template, bundled Noto Kufi Arabic; verify Arabic shaping and report the choice), 60/min/IP, cache headers, no cookie
- [x] Api admin: order detail and list (`checkout`, `gift`, `shareLinks`, badges data, `q` by checkout id); `POST /api/admin/orders/:id/share-links/:linkId/revoke` with audit
- [x] Api wallet: `checkout` on the purchase entry extras (customer and admin entries)
- [x] Email template `customer_checkout_finished`; Telegram daily summary line "سلال اليوم"
- [x] Dev CLI: `order:place --gift-message --gift-sender --save`; new `checkout:place`; commands table in `AGENTS.md`
- [x] Tests: `test/orders.test.ts` / new `test/checkouts.test.ts`, `test/saved-players.test.ts`, `test/shares.test.ts`, wallet and admin additions; worker CT8 tests (center rows without email, one `checkout_finished` with the right counts)
- [x] Bridge: build, OpenAPI export, admin client; admin and store E2E mocks follow changed shapes
- [x] Wiring checklist, docs (`docs/architecture.md`, S02 W5 list, folder `CLAUDE.md` files, spec "Settled in implementation")
- [x] Review fix: gift texts read as shown (joiners, combining marks and ideographic full stops no longer hide a phone, handle or domain)
- [x] Checks (lint, typecheck, test, build, e2e, drift: passed and recorded on 5e99a3d0e6c3), reviewer (one blocking finding: GF3 bypass by invisible characters; fixed), owner acceptance (2026-10-09), PR with auto-merge

## PR 2 — Store and admin screens, E2E, nginx · Opus 5.5 `high`
- [x] Store cart store (`vd-cart`, versioned, try/catch, merge by key, 10 lines, gift lines apart, cleared at sign-out) with unit tests; header cart button
- [x] Store buy box: saved-ID chips (SP3, SP6, SP7), save box, gift box (GF1, GF3), "أضف إلى السلة"; calculator "أضف الكل إلى السلة" (CT3); repeat (`?repeat=`, OT1, OT2); `?player=`
- [x] Store `/cart` (CT4, CT6) and `/orders?checkout=`; order page: repeat, gift section, receipt sheet, "ضمن سلة"; `/orders` badges and repeat
- [x] Store `/account/players`; `/g/[token]`, `/r/[token]` (per request, `noindex`, `no-referrer`, `og:image`); wallet checkout entry; i18n keys
- [x] Admin order page: checkout block, gift block, share links with the revoke dialog; list badges; i18n keys
- [x] Share pages' server render: the API's 60/min/IP limit on `/api/shares/*` must key on the visitor, not the store's loopback address — done: the store forwards the visitor's `X-Forwarded-For` (set by nginx), which the API trusts from loopback; E2E checks it reaches the API
- [x] nginx `vdshare`; `robots.txt` disallows `/g/`, `/r/`, `/cart`; `docs/deployment.md`
- [x] E2E flows and RTL screenshots (store phone and desktop, dark and light; admin light and dark); budgets for `/cart` and share pages in `apps/store/CLAUDE.md`
- [x] Wiring checklist, docs (`docs/ROADMAP.md` S10 done, `apps/store/CLAUDE.md`, `wiring.md` patterns)
- [x] Checks (lint, typecheck, build, e2e: passed and recorded; db, api and worker tests left to CI: the local test database needs a reset), reviewer (two blocking findings: sign-out from the account page kept the cart; repeat trusted undelivered orders; both fixed), owner acceptance (2026-10-10), PR with auto-merge
