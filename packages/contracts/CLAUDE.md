# packages/contracts

The single source of shapes and pure rules shared by api, worker, store and admin: Zod schemas and their types, money math, state transition tables, error codes (ADR 0003, 0004, 0011).

## Layout
- `src/<module>.ts` per owning API module (`wallet.ts`, `orders.ts`, `admin.ts`, `audit.ts`: actions and their details, `customers.ts`, `notifications.ts`: email templates), re-exported from `src/index.ts`. Shared rules: `money.ts` (units, rates, conversion, rounding), `errors.ts` (error codes and the error response), `system.ts` (health), `auth.ts` (passwords, names, phones, account forms; the common-password list in `common-passwords.data.ts`, generated), `lists.ts` (cursor lists; paged lists `pageQuerySchema` and `pagedListSchema`, S06), `catalog.ts` (S06: catalog shapes, `contrastRatio`, `productAvailability`, `missingForActivation`), `pricing.ts` (S06, ADR 0020: margin rules and the price math `priceFromCost`, `isProfitable`, `resolveMarginRule`, `savings`), `jobs.ts` (queue names shared by the API and the worker), `user-agent.ts` (browser and system names).
- Tests next to the code (`*.test.ts`).

## Rules
- Pure code only: no I/O, no Node or framework imports. Dependencies: Zod, and `libphonenumber-js/min` for phone numbers.
- Naming: `<thing>Schema` and `type Thing = z.infer<typeof thingSchema>`; inputs `create<Thing>Schema` / `update<Thing>Schema`. Every schema the API exposes has `.meta({ id: '<Thing>' })`.
- Fixed value lists are `as const` arrays with a `z.enum` over them (`ORDER_STATUSES`); the database enums reuse the same arrays, so there is one list.
- Never define the same shape twice: derive with `.pick()`, `.omit()`, `.extend()`, `.partial()`.
- Error codes are added to `ERROR_CODES` with their first use; the front ends translate the code.
- Audit actions are added to `AUDIT_DETAILS` with the strict shape of their details; `audit.test.ts` refuses a key that looks like a secret (password, code, token, session id).

## Money (ADR 0003)
- Amounts are integer units: USD in micro-dollars (`CURRENCY_SCALE.USD`), SYP in hundredths. Customer-facing USD (prices, deposit credits) is whole cents: validate with `usdCentsSchema`.
- Rates are exact decimal strings (`exchangeRateSchema`, SYP per 1 USD). Convert only with `usdToSyp` / `sypToUsd`, which compute in BigInt and round in the direction the caller names. Never `*`, `/` or `Math.round` an amount anywhere else, and never a float.
- A new rounding rule (deposit credits, price endings) is a named function here with its spec reference and tests, not inline arithmetic in a service.

## Orders (ADR 0004, 0013)
- `ORDER_TRANSITIONS` is the only list of allowed status changes. Changing it needs an ADR and the table in `orders.test.ts` updated to match.

Tests run with 100% line and branch coverage thresholds: code that no test reaches fails `pnpm test`. Changing an exported schema changes every app: run `pnpm typecheck` at the root.

Run: `pnpm --filter @vertex-digital/contracts test`.
