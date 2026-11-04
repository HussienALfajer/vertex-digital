# TASKS — S25 PR 1: Syrian credit, bills and cash with the fake supplier

Spec: `docs/specs/S25-zddk-supplier-and-syrian-credit.md` (Approved 2026-11-04) · ADR 0039.
The spec's PR 1, split in two so the money code gets its own review (owner prefers the fewest safe PRs).
PR 2 (the zddk adapter) waits for Q31, Q32 and Q34.

## PR 1a — `feat/s25-credit-core`: contracts, db, api, worker
- [x] contracts: `jneedcontur` supplier code, `jneedcontur_paused` switch, credentials `apiToken`, RT14 precedence, `cost_precision` reason
- [x] contracts: product kind `amount` (`minQuantity`, `amountUnitAr`, `amountStep` 100, `MAX_AMOUNT_UNITS`), AM1 amount ↔ quantity rules, `ROUTE_KIND_MISMATCH`
- [x] contracts: `syriatel_number` / `mtn_number` field types with RN1 normalisation and prefixes (unit tests)
- [x] contracts: `service_class`, `creditPolicySchema`, cash hold states, cancel reason `limit_reached`, refund reason `cash_rejected`
- [x] contracts: error codes (`CREDIT_DAILY_LIMIT`, `RECIPIENT_DAILY_LIMIT`, `CASH_BALANCE_TOO_RECENT`, `CASH_DAILY_LIMIT`) with store/admin Arabic text; audit actions with labels; job `orders.cash-hold-expiry`
- [x] db (`/db-migration`): enums extended the safe way, seeded jneedcontur row (fixed UUID, S19 pattern), treasury place and account, `catalog_products` (`min_quantity`, `amount_unit_ar`, `amount_step`, checks), `catalog_games.service_class`, `orders` (`recipient`, `cash_hold`, decided at/by, index), `credit_policy` single row
- [x] db: limit counting (CL2, CL3, CS1, CS2) and the cash hold transitions (approve, reject/expire with the refund journal) in the shared write paths, with concurrency tests
- [x] api: order and checkout paths: amount products, recipient normalisation, CL5 locks, CL2/CL3/CS1/CS2 checks, CS3 hold, reservations refused for cash and rechecked on payment (CL6)
- [x] api: `GET /api/credit-limits`, `GET/PUT /api/admin/credit-policy`, `PUT /api/admin/catalog/games/:id/service-class`, `POST /api/admin/orders/:id/cash-approval`, product create/update with `amount`; access tests
- [x] api: jneedcontur credential and switch in the suppliers module (not in `ADAPTERS_READY`: "not available")
- [x] worker: fulfilment skips held orders; `orders.cash-hold-expiry` job; Telegram cash card (outbox message with buttons, the API's bot decides) and the CL4 recipient alert
- [x] worker: fake supplier `@100` and value-list offers; `quantity_unsupported` / `quantity_below_offer` routing for amount offers (`quantity × 100` is the zddk adapter's, PR 2)
- [x] bridge: OpenAPI export and admin client; admin/store translations of the new codes and mocks
- [x] checks, reviewer (3 blocking findings fixed), PR and merge

## PR 1b — `feat/s25-credit-screens`: admin, store, E2E
- [ ] admin: product form kind `amount` ("لكل 100 ل.س" in the price matrix), game service-class select, settings "حدود الرصيد والكاش", jneedcontur in the suppliers list, live room "بانتظار الموافقة" and the order's recipient, amount and hold actions
- [ ] store: section category and SYP-first prices (SC2), amount input, twice-typed recipient and confirmation (RN2), limit messages, held state on the order page, cart line, quick buy, sale mode (merchants)
- [ ] seed: the section's six games with service classes and an amount product on the fake supplier (`pnpm db:seed-local`)
- [ ] e2e: section flows and RTL screenshots (store phone dark/light, admin light/dark)
- [ ] browser check of the spec's PR 1 acceptance
- [ ] checks, reviewer, PR and merge; ROADMAP
