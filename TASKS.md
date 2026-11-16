# TASKS — Owner tweaks (2026-11-16)

Branch `feat/owner-tweaks`: seven commits built and deployed straight from the branch on 2026-11-16 (tip `b17202c`), then finished here with checks, tests, docs, the reviewer and one PR.

## PR — `feat/owner-tweaks`
- [x] `pnpm verify` on the whole branch; failures read from the summary
- [x] Tests moved to the new rules: no per-deposit or daily deposit limit (contracts, api deposits, USDT options, customers, merchant tiers), no `new_account_large` or `velocity` flag (flagged cases now through `shared_phone`), no owner daily cap (api, db, worker texts), no Telegram amount cap (contracts, api decisions, worker card), `@` in usernames (contracts, store form)
- [x] New tests: USDT transfer set aside (access 401, refusals 400/404/409, audit, state `dismissed`, counts, still creditable by S02, bound refused, racing dismissals write one row)
- [x] E2E: the panel's hidden fields (customer limits, tier settings, deposit settings, order policy), the owner cap no longer refusing in the mock, the set-aside dialog with RTL screenshots light and dark, the matrix's default columns
- [x] OpenAPI export and admin client regenerated
- [x] Docs: S03, S04 (U13a), S05, S11, S12, S16, S20, S23, S27 amendments; architecture; ROADMAP line with the follow-up to drop the retired columns
- [x] Reviewer (money and security focus): ADR 0042 records the owner's decisions and the new threat model (amends 0006, 0017, 0018, 0019, 0030); the dismiss route in the S04 API table; a technical deposit ceiling (`DEPOSIT_MAX_USD_UNITS`) so a huge USDT amount is a 422, not a 500, with regression tests; the Telegram approval stays uncapped as the owner decided
- [x] Final `pnpm verify` (local db test database rebuilt after bloat; MA8 test pages through the queue)
- [x] Commit, PR with auto-merge, Auto-fix, merge
- [ ] Production deploy of `main`, health checks, the changed panel screens, deploy log PR
