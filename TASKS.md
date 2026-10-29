# TASKS — Wallets page in the owner's words (owner, 2026-10-29)

- [x] One pure function places every system account kind in a group (held, owed, result, owner money, conversion pair) with its shown amount; unit tests
- [x] Plain names with the supplier's name, the code only in the row's explanation; compensations and corrections apart
- [x] Gross profit and net in the result, the balance badge per currency with the difference when not zero
- [x] `GET /api/admin/wallets/highlights`: largest balances and the last wallets to move (contract, db read, API test), shown below the search
- [x] E2E and RTL screenshots in light and dark
- [x] Reviewer (five findings fixed), `pnpm verify`, browser check on the local stack

## Carried over (Close V1)

- [ ] After the owner funds WDGZone and FazerCards: run "activate all" on every game once
- [ ] Steam top-up (paused): confirm with WDGZone what its `player_id` expects before activating
