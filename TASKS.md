# TASKS — Flaky E2E tests in CI (branch `fix/flaky-e2e`)

CI fails a test that only passes on its retry (`failOnFlakyTests`). Failed CI runs since 2026-10-17, each checked against the current code.

- [x] Already fixed before this branch: admin deposits reject reason (`c808f66`), wallet entry pages (`88d85ae`), store frozen account buy box (`82f690a`), admin wrong TOTP code (`5f13f01`); the reconciliation reversal flow that failed was rewritten in audit A09
- [x] Admin `accounts.spec.ts` idle session: waits for the code step before typing the code (the code went into the password form)
- [x] Store sign-in races (`convenience.spec.ts` direct link, `accounts.spec.ts` email change, `purchase.spec.ts` id kept through sign-in): wait for the sign-in page's own session read (`sessionReadsFromSignIn` in `e2e/test.ts`) before signing in, or its redirect aborts the next `goto`
- [x] Admin `suppliers.spec.ts` step 4: a four-screen tour ran out of the default 30 seconds; `test.setTimeout(90_000)` as `docs/testing.md` asks
- [x] The fixed tests, three runs in a row
- [x] `pnpm verify`, PR, merge
