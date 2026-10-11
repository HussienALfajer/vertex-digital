# TASKS — S15 PWA and web push

Spec: `docs/specs/S15-pwa-and-web-push.md` (F24; ADRs 0002, 0007, 0008, 0009, 0011, 0012, 0014, 0015, 0029). Two PRs; each leaves `main` green. The cloud session pushes to its designated branch (`ccr-43564ce9-yq0vn9`) instead of `feat/s15-*`.

## PR 1 — Contracts, db, api, worker
- [x] Contracts `push.ts` (new, re-exported): `PUSH_NOTIFICATION_EVENTS`, `PUSH_SERVICE_HOSTS` and the endpoint check (PS2), `pushSubscriptionSchema` (key lengths), `pushConfigSchema`, `removePushSubscriptionSchema`; preferences `push` and the `{ event, email } | { event, push }` union; job `push.send`; error codes `PUSH_NOT_CONFIGURED`, `PUSH_ENDPOINT_REFUSED` with Arabic text; audit action `customer.push_preference_changed` with its label; `adminCustomerSchema.counts.pushDevices`; unit tests
- [x] Db (`/db-migration`): `push_subscriptions` (session FK on delete cascade, unique endpoint, indexes, grants), `notification_preferences.push`; conventions test entry; `notifyCustomer` queues `push.send` (PD1) with tests; the session cascade, the 10-device cap and the endpoint upsert
- [x] Api (the rate counter moved to `packages/db/src/rate-limits.ts` so `notifications` can count below `auth`): `GET /api/push/config` (public, rate-limited, cache header), `PUT`/`DELETE /api/push/subscription` (20 an hour per customer, PS1–PS3, PS8), preferences `push` with audit (PP1), admin profile `pushDevices`; `VAPID_PUBLIC_KEY` env; `test/push.test.ts`
- [x] Worker: `push.send` job (`jobs/push/`: PD2–PD7, `web-push`, host re-check, retries with only failed ids, Sentry once), `push-texts.ts` (PT1–PT3), `PUSH_TRANSPORT=log`, VAPID env (both or none); tests with the log transport and a mock push service
- [x] `pnpm db:setup-local` generates the VAPID pair; `.env.example` fake values and `PUSH_TRANSPORT`/`PUSH_LOG_DIR`; no new nginx zone (the general `/api/` zone covers `/api/push/`, the API limits per customer)
- [x] Bridge: build, OpenAPI export, admin client; mocks follow the changed shapes (preferences, admin customer counts)
- [x] Wiring checklist, docs (`docs/architecture.md`, folder `CLAUDE.md` files, commands table, spec "Settled in implementation")
- [x] Checks (lint, typecheck, test, build, e2e, drift recorded on aa47df82cc67), reviewer (two blocking findings, fixed: keys off the curve, the stale rate-counter path), owner acceptance (2026-10-11), PR with auto-merge

## PR 2 — Store PWA and push UI, admin count, E2E
- [x] Brand: maskable 512 icon and monochrome badge in `brand/logo/png/`
- [x] Store: `manifest.ts` (PW1), layout meta (PW2), `/sw.js` route (SW1, SW3, SW6, SW7) with the build id, inline registration (SW2), `/offline` (SW5)
- [x] Store: install item in the account menu and footer, iOS steps sheet (IN1–IN2)
- [x] Store: push client (`features/push/`): config read, subscribe, refresh and key change (PS6, PS7), sign-out unsubscribe (PS5); permission card on order and deposit pages (PC1–PC3, `next/dynamic`); device switch on `/account` and `/notifications` (PC4); preferences "الهاتف" column (PP1–PP2); i18n keys
- [x] Store unit tests (PC1 conditions, SW7 URL check, PS6/PS7 refresh rule)
- [x] Admin customer profile push devices line; i18n
- [x] E2E: manifest and `/sw.js` headers, offline page, card flows (granted, denied, iOS), preferences push column and switch, first-load budgets, admin count; RTL screenshots (store phone and desktop, dark and light; admin light and dark)
- [x] Wiring checklist, docs (`docs/ROADMAP.md` S15 done, `wiring.md` patterns, spec "Settled in implementation")
- [ ] Checks (lint, typecheck, test, build, e2e), reviewer, owner acceptance, PR with auto-merge
