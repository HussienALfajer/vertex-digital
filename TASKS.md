# TASKS — S25 PR 2: the zddk adapter for jneedcontur

Spec: `docs/specs/S25-zddk-supplier-and-syrian-credit.md` (Approved 2026-11-04) · ADR 0039 · doc `docs/suppliers/jneedcontur.md`.
Q31, Q32 and Q34 are still open in `docs/open-questions.md`: the owner chose (2026-11-05) to build on the spec's safe fallbacks now (one-field offers sent as `playerId`, every reply outside the success shape `unknown`, an unknown key `unknown`). After the merge: the production deploy (it carries PR 1 too) and the owner's live pilot.

## PR 2 — `feat/supplier-jneedcontur`
- [x] `packages/suppliers/src/zddk/`: schemas from the public docs, exact decimal costs (`decimal.ts`), offers per `qty_values` (`<id>`, `<id>:<value>`, `<id>@100`), `cost_precision`, `fields_unsupported` for zero or several params
- [x] orders: derived v4 `order_uuid`, `qty` per offer shape, only `playerId`, `accept`/`wait`/`reject`, everything else `unknown`; poll by key; balance; quote by `products_id`; categories from the products' own fields (`content/<id>` undocumented)
- [x] ZD8: the delivery text as the attempt's reference (`result.reference`), shown to the admin as "رقم العملية"
- [x] registries (worker, API), `ADAPTERS_READY`, the panel's `apiToken` label and description
- [x] tests: adapter against the fake server, decimals, db reference, registry, API supplier list, admin E2E
- [x] docs: `docs/suppliers/jneedcontur.md`, ROADMAP, architecture, `packages/suppliers/CLAUDE.md`
- [x] checks, reviewer (2 blocking findings fixed: amount ranges with no whole unit, one-unit bounds on packages and value lists), PR and merge
- [ ] deploy `main` (S25 PR 1 + PR 2), health checks, the deploy log
- [ ] live pilot steps for the owner (token, IP allowlist, 2FA, test, sync, funding, one MTN 1,000 SYP order, one Jawaker pack)
