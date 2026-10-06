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
| [0007](0007-auth-customers-and-staff.md) | Customers by email OTP with required phone; staff separate with mandatory TOTP | Accepted |
| [0008](0008-security-without-cloudflare.md) | Security and speed without Cloudflare: nginx, ALTCHA, rate limits, fail2ban, Brotli, caching | Accepted |
| [0009](0009-deployment-existing-vps.md) | Deploy to the existing VPS with PM2 and nginx | Accepted |
| [0010](0010-ai-assisted-development.md) | Claude Code (Opus 5.5) as the primary developer; AGENTS.md shared with Codex | Accepted |
| [0011](0011-engineering-conventions.md) | Engineering conventions: layout, module anatomy, data, errors, tests | Accepted |
| [0012](0012-brand.md) | Brand: Vertex colors, dark store, per-game accent, Madani Arabic, Arabic-only UI in V1 | Accepted |
| [0013](0013-refund-paid-order-without-route.md) | A paid order with no profitable route left is refunded (`paid → refunded`, amends 0004) | Accepted |
| [0014](0014-database-owner-and-app-roles.md) | Database roles: an owner role runs migrations, a restricted app role serves the apps (amends 0009) | Accepted |

Template:

```markdown
# NNNN — Title
Status: Proposed | Accepted | Superseded by NNNN · Date: YYYY-MM-DD
## Context
## Decision
## Consequences
```
