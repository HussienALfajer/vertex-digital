# Decision records

Short records of decisions that shape the system. Each has a status: **Accepted**, **Superseded by NNNN**, or **Proposed**. To change a decision, add a new record that supersedes the old one; don't rewrite history.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-and-apps.md) | One repository, four apps (store, admin, api, worker), a modular backend | Accepted |
| [0002](0002-stack-per-app.md) | Stack per app: Next.js store, Vite admin, NestJS api and worker, PostgreSQL, pg-boss, SSE | Accepted |
| [0003](0003-money-currencies-and-ledger.md) | USD base in micro-dollars, SYP with stored rates, double-entry append-only ledger, no withdrawals | Accepted |
| [0004](0004-orders-and-fulfilment-state-machine.md) | Order state machine, idempotent attempts, never retry elsewhere on an unknown outcome | Accepted |
| [0005](0005-supplier-adapters-and-routing.md) | One supplier interface; routing to the cheapest healthy profitable supplier with fallback | Accepted |
| [0006](0006-payments-and-deposits.md) | Sham Cash by reviewed receipt with fraud checks; USDT TRC20/BEP20 verified on chain | Accepted |
| [0007](0007-auth-customers-and-staff.md) | Customers by email OTP with required phone; the admin separate with mandatory TOTP (amended by 0016) | Accepted |
| [0008](0008-security-without-cloudflare.md) | Security and speed without Cloudflare: nginx, ALTCHA, rate limits, fail2ban, Brotli, caching | Accepted |
| [0009](0009-deployment-existing-vps.md) | Deploy to the existing VPS with PM2 and nginx | Accepted |
| [0010](0010-ai-assisted-development.md) | Claude Code (Opus 5.5) as the primary developer; AGENTS.md shared with Codex | Accepted |
| [0011](0011-engineering-conventions.md) | Engineering conventions: layout, module anatomy, data, errors, tests | Accepted |
| [0012](0012-brand.md) | Brand: Vertex colors, dark store, per-game accent, Madani Arabic, Arabic-only UI in V1 | Accepted |
| [0013](0013-refund-paid-order-without-route.md) | A paid order with no profitable route left is refunded (`paid → refunded`, amends 0004) | Accepted |
| [0014](0014-database-owner-and-app-roles.md) | Database roles: an owner role runs migrations, a restricted app role serves the apps (amends 0009) | Accepted |
| [0015](0015-store-csp-inline-scripts.md) | The store's CSP allows inline scripts instead of nonces, so pages stay cached (amends 0008) | Accepted |
| [0016](0016-single-admin-account.md) | One admin account with full access; no staff, roles or permission map (amends 0003–0007, 0011) | Accepted |
| [0017](0017-sham-cash-deposits-and-exchange-rate.md) | One SYP rate; Sham Cash in SYP and USD; SYP held in the books; lock covers the submission; deposit states and approval re-authentication (amends 0003, 0006) | Accepted |
| [0018](0018-usdt-deposits.md) | USDT: automatic detection by exact amount with a sub-cent tail, addresses in the server environment, shared limits with a $5 minimum, bounces for failed or fake-token transfers, system decisions (amends 0006, 0017) | Accepted |
| [0019](0019-telegram-bot-switches-notifications.md) | Telegram bot by webhook to the API in the admin's private chat, approval only unflagged Sham Cash up to $100, emergency stop on-only from Telegram; store switches as a pause layer that blocks creation only; one notification write path with SSE (amends 0002, 0006) | Accepted |
| [0020](0020-pricing-engine.md) | Pricing: margin rules per category, game and product over a 10% / $0.10 default, prices rounded up to whole cents on the cheapest healthy route, the guard at `price − cost ≥ minimum margin`, admin-entered official prices (amends 0005) | Accepted |
| [0021](0021-supplier-sync-price-review-and-health.md) | Supplier sync every 15 minutes with costs stale after 2 hours, cost changes above 10% held for review, route changes reprice at once, manual supplier as last resort, health and balance thresholds, no supplier funding in the ledger before S13, adapters once documented (amends 0005, 0020) | Accepted |
| [0022](0022-order-fulfilment-timing-reviews-and-test-orders.md) | Orders: polling then held for the admin after 30 minutes, unknown outcomes re-sent with the same key, four re-authenticated admin decisions, delivered is final, manual cards, input rejections refunded at once, test orders on `fake` and `manual` only, logged code reveal, delivery time over 50 orders (amends 0004, 0005) | Accepted |
| [0023](0023-reservations-and-player-validation.md) | Reservations: 3 per customer for 24 hours, paid after a deposit at the lower of the saved and current price, skipping what the balance cannot cover; player validation cached and limited, a "not found" a warning the customer confirms (amends 0004) | Accepted |
| [0024](0024-cart-checkout-saved-ids-and-share-links.md) | Cart checkout in one purchase journal shared by its orders, all or nothing, one summary email; saved player IDs as customer-confirmed; revocable public gift and receipt links that never show codes (amends 0003, 0004) | Accepted |
| [0025](0025-live-operations-reroute-manual-fulfil-dashboard.md) | Live operations: admin reroute to an eligible profitable route and manual fulfil with a screenshot and the actual cost (held and manual orders only), refund of manual orders, dashboard sales and profit by delivered orders of real customers, today against yesterday to the same hour (amends 0004, 0022) | Accepted |
| [0026](0026-customer-freeze-limits-archive-and-support-tickets.md) | Customers: freeze blocks new deposits and purchases only, per-customer deposit overrides and a daily purchase cap, archive at a zero balance; support tickets with types, images, auto-close, Telegram notices without content; one Telegram support link (amends 0006, 0019, 0023) | Accepted |
| [0027](0027-treasury-movements-reconciliation-and-reports.md) | Treasury movements between the store's money places and the outside, cost of goods signs corrected, nightly reconciliation (exact internal checks, external balances within $1 rechecked after 10 minutes, Sham Cash counted by hand, mismatches open until explained, Telegram on problems only), reports by delivery with an audited Excel export without phones (amends 0003, 0021, 0025) | Accepted |
| [0028](0028-content-publishing-and-live-activity.md) | Content: four fixed pages and an FAQ published as versions from drafts, limited Markdown with internal links only, at most 5 scheduled 2:1 banners, one dismissible announcement, refresh through the `content` cache tag; live activity from real deliveries 5 minutes to 24 hours old, hidden below 5, switchable; sign-up records the terms and privacy versions (amends 0015) | Accepted |
| [0029](0029-pwa-and-web-push.md) | PWA and web push: the service worker caches only the offline page; self-hosted VAPID push for every emailed customer event with per-event switches, minimal lock-screen text, subscriptions bound to sessions (10 per customer), push service hosts allow-listed | Accepted |
| [0030](0030-resend-refusals-admin-orders-and-supplier-catalog.md) | Any refusal of a re-sent attempt is unknown (Q18); admin orders (walk-in, on behalf, gift, compensation) at store prices, owner-funded ones booked as never-settled owner drawings under a $100 daily cap and reported apart; supplier categories mirrored and imported as paused games, images re-encoded from declared hosts, low-stock alerts (amends 0003, 0004, 0021, 0027) | Accepted |
| [0031](0031-drop-shop2topup.md) | SHOP2TOPUP dropped before its adapter: WDGZone is the only automatic supplier, manual the last resort; removed from code, docs and data, its enum values dropped one release later (supersedes the SHOP2TOPUP parts of 0004, 0005, 0021) | Accepted |
| [0032](0032-several-routes-per-supplier-and-route-price-basis.md) | Several live routes of one supplier per product; a per-route "counts for the price" flag (a cheaper route outside the basis is used first, its saving kept as margin, the price kept when only it is usable); per-route expected delivery time and hard limit copied onto the attempt; out-of-stock refusal marks a finite-stock offer out until the next sync (amends 0005, 0020, 0021, 0022) | Accepted |
| [0033](0033-supplier-health-hysteresis-and-charge-checks.md) | Supplier health hysteresis (degraded below 90%, healthy again at 95% held 5 minutes, at least 10 calls), alerts after a state holds 5 minutes, failure kinds on errored calls, a cost quote before each first send and a check of what the supplier charged (amends 0005, 0021) | Accepted |
| [0034](0034-fazercards-and-store-wide-player-check.md) | FazerCards as second automatic supplier; a per-game check provider checks every direct pack whatever supplier fulfils it; a region outside the allowed list blocks; checks excluded from routing health; equal costs ordered by measured delivery time, priority, then WDGZone first; a basis switch above the threshold goes to review (Q17) (amends 0005, 0020, 0023, 0031) | Accepted |
| [0035](0035-price-lists-and-merchant-accounts.md) | Price lists and merchant accounts: account types with approval only by the admin, retail, wholesale (5%, $0.05), cost (1%, $0.01) and up to 20 custom lists resolved list-first with fixed prices falling back to rules, never above retail, one review for every list, private prices outside the public cache, a merchant tier of $2,000 / $5,000 and 60 orders per 10 minutes (amends 0006, 0020, 0021, 0023, 0026) | Accepted |
| [0036](0036-merchant-tools-levels-and-order-verification.md) | Merchant tools: volume levels pick a list below the admin's assignment (monthly net purchases, immediate upgrade, downgrade on the 1st), selling prices as the merchant's own bookkeeping outside the ledger, a verification code and QR on every order with no price or personal data, documents printed by the browser (amends 0022, 0024, 0035) | Accepted |
| [0037](0037-passkeys-quick-links-and-product-alerts.md) | Customer passkeys (password to add, 10 per account, deleted by a password reset, never for the admin), permanent direct buy codes per product with a 90-day counting log, one-shot product alerts on the customer's own list by center and push, order tickets naming the problem with a 7-day window (amends 0007, 0024, 0026) | Accepted |

Template:

```markdown
# NNNN — Title
Status: Proposed | Accepted | Superseded by NNNN · Date: YYYY-MM-DD
## Context
## Decision
## Consequences
```
