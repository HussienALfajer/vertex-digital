# TASKS — S23 Merchant tiers, PR 3 "Operations and reports" (`docs/specs/S23-merchant-tiers.md`)

PR 1a (#230), PR 1b (#231) and PR 2 (#232) are merged. Spec PR 3 (decisions 11, 12, 15: OP1–OP8, PX5, AD4, the Diamond contact of decision 12) ships as one PR, server and screens together, on `feat/s23-operations`. The deploy and the setup command (PX1) follow the merge.

## PR 3 — operations and reports

### Contracts
- [x] `merchant_settings` Diamond contact fields (`directContactWhatsapp` E.164, `directContactTelegram` `^[A-Za-z0-9_]{5,32}$`) in the admin settings schemas; the deposit and check fields leave the admin input
- [x] `GET /api/merchant/tier` adds `contact` (only with `direct_contact`); the reply promise is the privileges' `supportReplyMinutes` already there
- [x] early access: `earlyAccessUntil` on admin game and product schemas, `earlyAccess` chip flag on the store's private reads, `{ on: boolean }` input; audit actions `catalog.early_access_set`, `catalog.early_access_ended`
- [x] notification event `merchant_early_access` (center, push) and its preference; Telegram event `ticket_overdue`; jobs `support.overdue-tickets` (every 15 minutes), `catalog.early-access-end` (every 5 minutes); `merchants.watch-alerts` every 15 minutes
- [x] queue items carry the tier (deposit and ticket admin lists); best-sellers (PX5) and report by tier (AD4) schemas with `.meta({ id })`; unit tests

### db (`/db-migration`)
- [x] `merchant_settings.direct_contact_whatsapp`, `direct_contact_telegram`; `catalog_games.early_access_until`, `catalog_products.early_access_until` with partial indexes; enum values `merchant_early_access`, `ticket_overdue` (migration 0107); early access in `productRoutingStates` (hidden unless the context says the viewer's tier has it), `lockActiveCustomer.earlyAccess` through every purchase path, quick links, the tier table, merchant-tools reads, `merchantTiers`, `merchantsWith`, `earlyAccessAudience`; db test of the purchase paths

### api
- [x] OP1 deposit queue: Sham Cash deposits of tiers with `deposit_priority` first, then submission time, with the tier; the Telegram deposit card names the tier
- [x] OP2 ticket queue: open tickets of tiers with `support_priority` first, then `last_customer_message_at`, with the tier
- [x] OP3, OP4: the reply promise (privileges) and the Diamond contact on `GET /api/merchant/tier`; `PUT /api/admin/merchant-settings` with the contact (re-auth, audited)
- [x] OP5 early access (`GET /api/catalog/games/:slug/early-access` serves an early game to eligible merchants; the private prices answer carries `earlyProducts`): `PUT /api/admin/catalog/games/:id/early-access` and `products/:id/early-access` (re-auth, audited, outbox revalidation); hidden for non-eligible accounts and the public cache on every path (public catalog, private prices, order, checkout, reservation, quick link, cart, admin walk-in and owner-funded; admin on behalf follows the merchant); `merchant_early_access` sent once to eligible followers and 30-day buyers (dedupe `early-access:<game or product>:<customer>`)
- [x] PX5 `GET /api/admin/merchant-tiers/best-sellers` (20 packs, 30 days delivered units, each tier's price and margin)
- [x] AD4 `GET /api/admin/reports/merchant-tiers` and `/export` (audited `report.merchant_tiers_exported`) (per tier: holders, net purchases, sales, profit by the tier held at order time, rises and falls; test merchants excluded)
- [x] tests per endpoint (success, 401, 403 across kinds, re-auth, other merchants), early access per path, contact only for Diamond, queue orders, report and best-sellers

### worker
- [x] `support.overdue-tickets` (Telegram `ticket_overdue`, dedupe `ticket-overdue:<ticket>:<last_customer_message_at>`)
- [x] `catalog.early-access-end` (revalidates the store's catalog cache when a window ended in the last 15 minutes; idempotent)
- [x] OP8 faster alerts: watch-alerts every 15 minutes, `fast_alerts` tiers every run (dedupe per quarter hour), the rest only at :05
- [x] `merchant_early_access` push text; tests run twice

### Bridge
- [x] `pnpm build`, OpenAPI export, admin client regenerated

### Admin
- [x] deposit and ticket queues: tier badge and priority order
- [x] catalog game and product pages: "وصول مبكر 24 ساعة" on activation, the window's end with "إنهاء الآن"
- [x] tiers page: best-sellers helper (opens S20's fixed price dialog on Diamond's list); settings → merchants: the Diamond contact, the deposit and check fields removed
- [x] reports: "حسب فئة التاجر" at `/reports/merchant-tiers` (month in the URL, linked from the reports page) with its Excel export
- [x] i18n keys (errors, audit labels), loading, empty and error states

### Store
- [x] reply promise on the new-ticket and ticket pages (OP3); Diamond contact buttons on the tier card, tier page and support pages (OP4)
- [x] "وصول مبكر" chip on packs, early packs from `earlyProducts`, an early game opened from its not-found view (OP5)
- [x] i18n keys, states

### E2E and close
- [x] e2e: admin (queues, early access, best-sellers, report, contact settings; light and dark) and store `e2e/merchant-operations.spec.ts` (promise, contact, chip, early game); the game page renders its missing view directly instead of `notFound()`, so an early game opens outside Next's error boundary
- [x] browser check on the local stack (acceptance 6-8 parts this PR covers; the overdue Telegram alert not seen live, servers stopped first at the owner's request, covered by the worker's test)
- [x] checks, reviewer, PR and merge
- [ ] deploy S23 and `merchants:setup-tiers` in production
