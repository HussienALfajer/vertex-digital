# TASKS — V1 system test, feature 11 run and fixes

Branch `docs/v1-system-test-feature-11-run`. Record the owner's run of feature 11 and fix its findings. The owner first asked (2026-10-19) to open the PR only after the whole feature is tested, then asked the same evening to bring the branch into main now; day 2 continues on a new branch.

- [x] Record 11.1–11.17 (11.17 finished by the owner on a real phone) and correct the feature table (9 and 10 accepted).
- [x] Fix F11-4 to F11-10 (order select labels, buy box SYP, panel order page live, fulfil dialog errors, email isolates, "طلباتي" on a phone) with tests. F11-9 (WDG statement times and totals) shipped in S18 (#147); its version here was dropped in the merge with main.
- [x] Checks green (lint, typecheck, test, build, changed E2E); reviewer's finding fixed.
- [x] Merge main (S18, S19 spec, #148), keep S18's WDGZone adapter, checks again, PR with merge-commit auto-merge, deploy.
- Follow-up, not this PR (day 2, after 23:48 on 2026-10-19): 11.13 steps 2–3, 11.18 steps 2–4, the sign-off and the owner's acceptance of feature 11, on a new docs branch.

## Previous task — S18 WDGZone hardening and supplier panel overhaul

Spec `docs/specs/S18-wdg-hardening.md`, ADR 0033. Branch `feat/wdg-hardening`, one PR (the back end and the panel share the contract changes; owner prefers fewer PRs), two commits.

## Back end
- [x] Spec, ADR 0033, owner decisions (2026-10-19: 95% held 5 min and min 10; VIP badge; alert + pause on loss; quote before buying)
- [x] Contracts: failure kinds, operations `get_offer` / `test_connection`, policy recovery fields, health rules HE1–HE3, charge tolerance, `supplier_charges` check, statement and run fields
- [x] DB: migrations 0065–0067 (columns, enum values, the S18 policy row, the attempt guard), `recordObservedCost`, `supplierChargesCheck`, the charge kept by `applyOutcome`
- [x] Suppliers: failure kinds in SupplierHttp, page retries, statement shapes, UTC+4 times, discount, charged totals, `getOfferQuote`, `error_message`, answered unknowns, fixtures, fake parity
- [x] Worker: call records with kinds and codes + warn logs, health hysteresis + consecutive rule + alert hold, sync skip on an unchanged catalog, quote before the first send, charge check, nightly `supplier_charges`, Telegram text
- [x] API: failure kinds on the API's calls, run and statement fields, cards' cached status from the sync; OpenAPI and admin client
- [x] Admin (contract fallout): policy recovery fields, reconciliation charge findings, labels, mocks

## Panel
- [x] API: test connection, errored calls list, category node, offer link + suggestions, route-offer search, offer fields (discount, last seen) and `discounted` filter
- [x] Category page route, catalog navigation, remove `node`
- [x] Link-to-pack dialog with suggestions; add-route dialog improvements
- [x] Offers tab fields, filter, select-all, tooltips; cost chart
- [x] Statement (amount, times, delivery time, Arabic labels, wait on 429), runs (message, skipped read), health (errors table, paging), connection test
- [x] Narrow-screen tables; i18n; E2E mocks and RTL screenshots
- [x] Docs: wdgzone.md, architecture, folder CLAUDE.md files
- [x] Checks, reviewer (5 blocking findings fixed: charge by delivered units in one contracts rule, a day's charge mismatch always alerts, a truncated statement is skipped, an out-of-bounds quote sends as before, access tests), PR with auto-merge
- [x] Deploy and verify in production (c5d3180, with the acceptance round #148)
