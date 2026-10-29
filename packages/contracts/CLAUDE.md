# packages/contracts

The single source of shapes and pure rules shared by api, worker, store and admin: Zod schemas and their types, money math, state transition tables, error codes (ADR 0003, 0004, 0011). The apps validate with these schemas only; never redefine a shape in an app.

## Layout
- `src/<module>.ts` per owning API module (`orders.ts`, `wallet.ts`, `catalog.ts`, …), re-exported from `src/index.ts`. Tests next to the code (`*.test.ts`).
- Shared rules: `money.ts` (units, rates, conversion, rounding), `errors.ts` (`ERROR_CODES`, the error response), `lists.ts` (cursor and paged lists), `audit.ts` (`AUDIT_DETAILS`), `jobs.ts` (queue names shared by the API and the worker).
- Where the money-critical rules live: `pricing.ts` (`priceFromCost`, `isProfitable`, price lists and `listPrice`, ADR 0020, 0035), `suppliers.ts` (route order, `priceBasis`, supplier health, ADR 0021), `orders.ts` (`ORDER_TRANSITIONS`, the money of an order), `deposits.ts` (`DEPOSIT_TRANSITIONS`), `reconciliation.ts` (treasury postings).
- Search before adding a rule: it probably exists.
- `common-passwords.data.ts` is generated: do not edit by hand.
- Built to `dist/` (`exports` point there); `pnpm verify` builds it before the apps' checks.

## Rules
- Pure code only: no I/O, no Node or framework imports. Dependencies: Zod, `libphonenumber-js/min` (phones) and `@noble/hashes` (USDT address checksums).
- `"sideEffects": false`: nothing runs at import but schema construction, so a bundler drops the modules a page does not use. No global registration, no `z.config` at module level.
- Naming follows ADR 0011 (`<thing>Schema`, `create<Thing>Schema`, `.meta({ id })` on every schema the API exposes).
- Fixed value lists are `as const` arrays with a `z.enum` over them (`ORDER_STATUSES`); the database enums reuse the same arrays, so there is one list.
- Never define the same shape twice: derive with `.pick()`, `.omit()`, `.extend()`, `.partial()`.
- Error codes are added to `ERROR_CODES` with their first use; the front ends translate the code.
- Audit actions are added to `AUDIT_DETAILS` with the strict shape of their details; `audit.test.ts` refuses a key that looks like a secret (password, code, token, session id).

## Import boundaries (no cycles, small store bundles)
- `suppliers.ts` imports `catalog.ts`, and `pricing.ts` imports `suppliers.ts`: keep that order.
- `customer-status.ts` imports no other module, so deposits, orders and support can all use it.
- `merchants.ts` imports only `auth`, `lists`, `money`, `price-kinds`, `merchant-tiers` (which imports only `money` and `price-kinds`), and `product-alerts.ts` only `catalog`, `money`, so the store's forms stay light.
- `notifications.ts` imports `merchant-tools.ts`, never `merchant-documents.ts` (price list and statement schemas), so pages that ship notifications do not ship those or the wallet's.

## Money (ADR 0003)
- Amounts are integer units: USD in micro-dollars (`CURRENCY_SCALE.USD`), SYP in hundredths. Customer-facing USD (prices, deposit credits) is whole cents: validate with `usdCentsSchema`.
- Rates are exact decimal strings (`exchangeRateSchema`, SYP per 1 USD). Convert only with `usdToSyp` / `sypToUsd`, which compute in BigInt and round in the direction the caller names. Never `*`, `/` or `Math.round` an amount anywhere else, and never a float.
- A new rounding rule (deposit credits, price endings) is a named function here with its spec reference and tests, not inline arithmetic in a service.

## State transitions (ADR 0004, 0013)
- `ORDER_TRANSITIONS` is the only list of allowed order status changes. Changing it needs an ADR and the table in `orders.test.ts` updated to match.
- Other state machines (`DEPOSIT_TRANSITIONS`, `ticketTransition`, `applicationTransition`) are likewise the only source of their allowed changes.

## Checks
- `pnpm verify packages/contracts/src/<module>.test.ts` while working. The package has a 100% line and branch coverage threshold: code no test reaches fails the full `pnpm verify` (named files run without coverage).
- Changing an exported schema changes every app: run the full `pnpm verify` before the PR.
