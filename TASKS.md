# TASKS — Post-launch hardening (owner, 2026-10-31)

Branch: `fix/post-launch-hardening`. One PR, then the deploy.

- [x] Sync runs cut by a worker restart close at the next boot (S07 SY1), with a regression test
- [x] Production dependencies flagged by `pnpm audit` updated
- [x] Storefront read skips the paused packs' routes; measure on production after the deploy
- [x] Deferred audit tests: A04-17, A04-18, A05-44
- [x] Stale docs: `docs/ROADMAP.md` merchant tools line; Q22 checked (built)
- [x] `pnpm verify`, `reviewer` and its findings
- [x] pg-boss pools capped by `DATABASE_POOL_MAX`: the worker suite no longer exhausts PostgreSQL
- [x] PR #247, merge, deploy, deploy log

## The owner, in the panel
- [ ] The six category images ("إدارة الفئات")
- [ ] The signed-in merchant screens on production, without real money
