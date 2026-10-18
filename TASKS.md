# TASKS — V1 system test, feature 10 SQL verification

Documentation only, branch `docs/feature-10-production-sql`. Follow up the successful SSH retry with read-only production SQL evidence and correct the fixture prerequisites; manual cases remain unrun.

- [x] Retry SSH and read the server conventions and deployed revision.
- [x] Verify catalog counts, worked prices, rate, switches, fixture records and eligible delivery samples in read-only production transactions.
- [x] Update the production evidence and fixture setup/cleanup in `docs/testing/v1-system-test.md`; record F10-3 without mutating production.
- [x] Review the documentation and pass the docs-only checker gate; all 18 manual results and owner acceptance remain blank.
- [x] Prepare the follow-up documentation commit and PR with merge-commit auto-merge; report publication with the task result.

## Previous task — Feature 10 cases

Documentation only, branch `docs/v1-system-test-feature-10`. Write the owner's production test cases for F12 and F15 without running them or accepting the feature.

- [x] Read the feature 8 and 9 case pattern, F12/F15 scope and relevant spec sections.
- [x] Record current worked numbers from read-only public production API queries; explicitly record the SSH/SQL access limitation.
- [x] Write 18 feature 10 cases, production precautions, deferred checks and the blank sign-off in `docs/testing/v1-system-test.md`.
- [x] Review coverage and figures; confirm the diff contains documentation only and no secrets. Reviewer and specification review found no remaining actionable issue.
- [x] Prepare the intended documentation commit and docs PR with merge-commit auto-merge; the published PR link is reported with the task result.

## Previous task — S17 WDGZone Web Purchase route

Spec: `docs/specs/S17-wdg-web-route.md` (Approved). One PR, branch `feat/s17-wdg-web-route`.

## PR 1 — contracts, db, api, worker, admin, store, E2E

- [x] contracts: route schemas gain `priceBasis`, `expectedDeliveryMinutes`, `hardLimitMinutes`; customer order gains `expectedWithinMinutes`; remove `ROUTE_EXISTS`, add `ROUTE_TIMING_INVALID` (Arabic text in the admin catalog); pure rules with unit tests: basis among `price_basis` routes (WR3), kept price (WR4), no review for a non-basis cost (WR5), `pastHardLimit` with an attempt's limit (WR9), stock-alert filter (WR11)
- [x] db (`/db-migration`): drop `product_routes_product_id_supplier_id_live_idx`; `product_routes.price_basis`, `expected_delivery_minutes`, `hard_limit_minutes` with checks; `fulfilment_attempts` timing copies; reprice write path applies WR3–WR5; WR8 out-of-stock marking in the failing transaction; tests (two live routes of one supplier, one per offer, timing check); migration drift
- [x] api: route create/update with the three fields and `ROUTE_TIMING_INVALID` (policy limit at save time), audit before/after; S16 link rows with `priceBasis`, no `ROUTE_EXISTS`; `GET /api/orders/:id` `expectedWithinMinutes` (not on share views); tests incl. 401/403 and other customers' orders
- [x] worker: fulfil copies the route timing onto the attempt; WR8 on a first-send `OUT_OF_STOCK` refusal (finite stock only, not on a re-send), reprice after it, fallback to the next route; sweep reads the attempt's hard limit; sync low-stock step WR11; tests with the fake supplier
- [x] bridge: `pnpm build`, OpenAPI export, admin client generation; adapt E2E mocks to the changed shapes
- [x] admin: route drawer and route form (switch, expected time, review limit), routes list chip and expected time, S16 link sheet per-row checkbox pre-set by WR7, price line "السعر محفوظ" (WR4); i18n keys; `errors.ROUTE_TIMING_INVALID`
- [x] store: order page hint (WR10) in place of the measured expected time; i18n key
- [x] e2e: route drawer settings, link sheet checkbox, store order page with the hint; RTL screenshots (admin light/dark, store phone dark/light)
- [x] wiring: error code in catalogs, OpenAPI drift, E2E mocks for changed responses, docs (`docs/suppliers/wdgzone.md` if needed, `docs/ROADMAP.md`)
- [x] checks, reviewer, acceptance, PR with auto-merge
