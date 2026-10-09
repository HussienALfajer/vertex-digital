# TASKS — S08 Orders and fulfilment engine

Spec: `docs/specs/S08-orders-and-fulfilment.md` (F11 with F26 SW7, F27 and F13's pay step; ADRs 0003, 0004, 0005, 0011, 0013, 0014, 0016, 0019, 0020, 0021, 0022). Three PRs, as the spec's implementation notes suggest; each leaves `main` green and runs in its own session. Real adapters' order calls follow in their own `/supplier-adapter` PRs (Q12).

## PR 1 — Contracts, db, order write path, `orders` API module, webhook intake, `order:place`, bridge · Opus 5.5 `high`
- [ ] Contracts `orders.ts`: attempt statuses and resolvers, event kinds and actors, refund reasons, route skip reasons; `orderCustomerStage` (O13); schemas (create, summary, order, admin list query and page, admin order, resolve, refund, reveal, policy); pure `orderTotal`, `refundAmount`, `costOfGoods`, `routeProfitable`, `orderCandidates` (R1–R4), `nextPollAt`, `pastHardLimit` (F7), `deliveryStats` (T1), `orderNumberSchema`, `maskCode`; unit tests (100%)
- [ ] Contracts: error codes with Arabic store and admin text; audit entity types and actions with admin labels; queues `orders.fulfil`, `orders.poll`, `orders.sweep`, `suppliers.webhook`; notification kinds (`order_delivered`, `order_partially_refunded`, `order_refunded`, `order_delayed`); Telegram kinds (`manual_order`, `manual_order_reminder`, `order_needs_review`, `order_conflict`); ledger account kinds and journal kinds
- [ ] Suppliers interface: `delivered.quantity`, `failed_definitive.inputRejected`; the fake adapter answers by the new shape (scripting stays in PR 2)
- [ ] Db (`/db-migration`): `orders`, `order_events`, `fulfilment_attempts`, `order_codes`, `order_code_reveals`, `supplier_webhook_events`, `order_policy` (seeded); enums, checks, partial unique indexes, triggers, grants; `TABLE_OWNERS`; tests
- [ ] Db: codes and webhook body encryption (AES-256-GCM, row id as associated data, key version, `ORDER_CODES_SECRET`); tests
- [ ] Db: order write path `packages/db/src/orders` (`purchase`, `transitionOrder`, `applyOutcome`, `refundRemaining`, cost of goods; M1–M3); tests on real PostgreSQL (lost race, one refund, parallel purchases, one key in parallel, purchase against repricing and stop)
- [ ] Api `orders` module: customer routes (buy, list, read, reveal), admin routes (list, counts, read, poll, resolve, refund, reveal, policy), delivery stats on the admin game page, wallet entries with order number and product; `test/orders.test.ts`
- [ ] Api `suppliers` webhook intake (`POST /api/webhooks/suppliers/:code`: raw body cap, HMAC and timestamp, stored once, job queued); tests
- [ ] Rate limits (API and nginx zones in `deploy/`): purchase, reveal, webhook
- [ ] Env: `ORDER_CODES_SECRET` (api and worker, required in production, derived locally); `.env.example`, `provision.sh`, `docs/deployment.md`
- [ ] Dev CLI `order:place`; commands table in `AGENTS.md`
- [ ] Bridge: build, OpenAPI export, admin client; admin E2E mocks follow changed shapes
- [ ] Wiring checklist, docs (`docs/architecture.md`, folder `CLAUDE.md` files, `wiring.md` "Order transition" pattern, spec "Settled in implementation")
- [ ] Checks (lint, typecheck, test, build, e2e, drift), reviewer, owner acceptance (endpoints at `/api/docs`), PR with auto-merge

## PR 2 — Worker: routing, sending, polling, webhooks, sweep, manual, notifications · Opus 5.5 `high`
- [ ] Jobs `orders.fulfil` (R1–R6), `orders.poll` (F3), `suppliers.webhook` (F5), `orders.sweep` (F6, F7, MN2); supplier calls recorded in `supplier_calls`
- [ ] Telegram kinds and cards (`manual_order`, reminder, `order_needs_review`, `order_conflict`) with dedupe keys; daily summary lines
- [ ] Customer notifications in the change's transaction; codes never logged (log redaction covers `codes`)
- [ ] Fake supplier order scripting (`--order`, `--resolve … --via poll|webhook`); commands table
- [ ] Worker env `ORDER_CODES_SECRET`
- [ ] Tests (each tier, guard, balance, already tried, test customers, every outcome, partial, input rejection, schedule and hard limit, review polling, sweep, webhooks applied / same result / unknown key / conflict, manual cards and reminder, dedupe keys, log capture)
- [ ] Wiring checklist, docs
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge

## PR 3 — Store and admin screens, E2E · Opus 5.5 `high`
- [ ] Store `features/orders/`: `/orders` and `/orders/[id]` (stages, fields, code reveal, refetch on notification); account menu and wallet entry links; i18n
- [ ] Admin `features/orders/`: `/orders` (tabs, filters, search), `/orders/$id` (decision panel, attempts with candidates, events, journals, codes and reveals, webhook events), `/orders/policy`; navigation with the badge; "وقت التسليم" column on the game page; i18n
- [ ] E2E flows and RTL screenshots (store phone width dark and light; admin light and dark)
- [ ] Wiring checklist, docs (`docs/ROADMAP.md` S08 done, `wiring.md` patterns, folder `CLAUDE.md` files)
- [ ] Checks, reviewer, owner acceptance (the spec's ten browser steps), PR with auto-merge
