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

Template:

```markdown
# NNNN — Title
Status: Proposed | Accepted | Superseded by NNNN · Date: YYYY-MM-DD
## Context
## Decision
## Consequences
```
