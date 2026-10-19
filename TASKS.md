# TASKS — S18 WDGZone hardening and supplier panel overhaul

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
- [ ] API: test connection, errored calls list, category node, offer link + suggestions, route-offer search, offer fields (discount, last seen) and `discounted` filter
- [ ] Category page route, catalog navigation, remove `node`
- [ ] Link-to-pack dialog with suggestions; add-route dialog improvements
- [ ] Offers tab fields, filter, select-all, tooltips; cost chart
- [ ] Statement (amount, times, delivery time, Arabic labels, wait on 429), runs (message, skipped read), health (errors table, paging), connection test
- [ ] Narrow-screen tables; i18n; E2E mocks and RTL screenshots
- [ ] Docs: wdgzone.md, architecture, folder CLAUDE.md files
- [ ] Checks, reviewer, PR with auto-merge
- [ ] Deploy and verify in production
