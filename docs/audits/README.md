# Comprehensive audit (A01–A10)

A full audit of the whole product before the pilot, one group of screens at a time. Each group is audited end to end, from the screen down to the database and the jobs behind it, every defect found is fixed in the same session, and the group ends with a merged PR and a production deploy. Then the next group starts.

Planned with the owner on 2026-10-26. Production was on `26cac0b` (all of `main`) when the audit began.

## How to start a group

In a new session (Opus, effort `high`), the owner writes one line, for example "ابدأ المجموعة A02" or `/audit-group A02`. The `audit-group` skill (`.claude/skills/audit-group/SKILL.md`) runs the whole cycle below from this file. With no group named, it takes the first group in the status table that is not `deployed`.

## Status

| Group | Name | Status | Report | PR | Deployed |
|---|---|---|---|---|---|
| A01 | Identity and access | deployed | [A01-identity.md](A01-identity.md) | [#177](https://github.com/HussienALfajer/vertex-digital/pull/177) | `097b869` (2026-10-27) |
| A02 | Wallet, ledger and deposits | deployed | [A02-wallet.md](A02-wallet.md) | [#178](https://github.com/HussienALfajer/vertex-digital/pull/178) | `610a388` (2026-10-27) |
| A03 | Catalog and storefront | deployed | [A03-catalog.md](A03-catalog.md) | [#180](https://github.com/HussienALfajer/vertex-digital/pull/180) | `788f309` (2026-10-27) |
| A04 | Purchase, orders and fulfilment | deployed | [A04-orders.md](A04-orders.md) | [#182](https://github.com/HussienALfajer/vertex-digital/pull/182) | `7914ca2` (2026-10-27) |
| A05 | Suppliers and pricing | not started | | | |
| A06 | Merchants | not started | | | |
| A07 | Customers, support and notifications | not started | | | |
| A08 | Content | not started | | | |
| A09 | Control, reconciliation and reports | not started | | | |
| A10 | Platform, performance and operations | not started | | | |

Statuses: `not started` → `in progress` → `merged` → `deployed`. The group's PR sets `merged` with its link; the deploy step sets `deployed` with the commit, in a follow-up commit on the next group's branch or a small docs PR.

## Why this order

Security first (everything depends on who is signed in), then money coming in, then what is sold, then money going out, then the cost side, then the merchant layer that sits on all of these, then service, content and oversight. The platform group comes last because it collects the cross-cutting findings the other groups record for it.

## The groups

Each group owns its screens and everything behind them: API modules, worker jobs, database tables, contracts, emails and notifications, and E2E specs. A shared file touched by several groups (the shell, `packages/ui`, the auth guard) is audited where the group's screens use it; cross-cutting problems are recorded for A10 unless they are a defect in the group's own flow.

### A01 Identity and access
- **Store:** `/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password`, `/account` (profile, password, passkeys, sessions, notification preferences), `/account/email`; the header's account menu and sign-out.
- **Admin:** `/login`, `/change-password`, `/setup-two-factor`, `/account`, `/test-customers`; the `_app` guard and re-authentication dialog.
- **Backend:** `auth`, `admin` API modules (Better Auth, ALTCHA, rate limits, passkeys); the admin CLI commands; worker `email` jobs for verification, reset and passkey emails.
- **DB:** `auth.ts`, `admin.ts`, `customers.ts` (account fields).
- **Specs and ADRs:** S01, S22 (passkeys); ADR 0007, 0008, 0016, 0037.
- **E2E:** store `accounts`, `passkeys`; admin `admin`, `accounts`.
- **Known leads (verify, do not assume):** the sessions card's sign-out skips the push unsubscribe and the signed-in hint (`sessions-card.tsx:53-65`); auth pages do not redirect a signed-in customer; `/account/email` has no session check on load; `/forgot-password` has no "resend code"; `password-card.tsx:39` skips the "password equals email" check; `preferences-card.tsx:68` hides the card with no retry when its read fails; `two-factor-setup-page.tsx:46-50` signs out without `leaveSession()`; `/sign-up` shows the terms agreement while registration is closed.

### A02 Wallet, ledger and deposits (money in)
- **Store:** `/wallet`, `/wallet/deposit`, `/wallet/deposits`, `/wallet/deposits/[id]`; the balance chip.
- **Admin:** `/deposits`, `/deposits/$id`, `/deposits/transfers`, `/settings/deposits`, `/wallets`, `/wallets/$customerId`, `/rates`; the stale-rate banner.
- **Backend:** `wallet`, `deposits`, `rates`, `files` API modules; worker `deposits` jobs (USDT scanners, expiry, receipt handling); `packages/db/src/ledger`.
- **DB:** `wallet.ts`, `deposits.ts`, `rates.ts`, `files.ts`.
- **Specs and ADRs:** S02, S03, S04; ADR 0003, 0006, 0017, 0018.
- **E2E:** store `wallet`, `deposits`, `usdt-deposits`; admin `deposits`, `usdt-deposits`, `wallets`.
- **Known leads:** the store wallet reloads the whole page on almost every live event and drops the "load more" pages (`wallet-page.tsx:97-99`); the deposits list never updates live; the admin deposit approvals are one inline submit with the amount only on the button (`approve-form.tsx:300-306`, `usdt-panels.tsx:336-340`); `useRequestReceipt` and `useRecheckDeposit` send no idempotency key and skip re-authentication (`deposits.queries.ts:138-172`); the transfers customer search fires per keystroke (`transfers-page.tsx:344-385`); the prefilled manual-deposit amount and TXID stay editable (`adjust-dialog.tsx:189,342`); back arrows point forward in RTL (`deposit-page.tsx:60`, `transfers-page.tsx:87`, `wallet-page.tsx:50`: `rtl:-scale-x-100` where the rest use `ltr:`); a Sham Cash method with no available currency may open an empty form (`deposit-form.tsx:234`).

### A03 Catalog and storefront
- **Store:** `/` (hero, banners slot, quick-buy row, sections), the search dialog, `/games/[slug]` (display: packs, ID guide, calculator, unavailable packs), `/q/[code]`, `/_internal/revalidate`.
- **Admin:** `/catalog`, `/catalog/games/new`, `/catalog/games/$id` (data, fields, products, pricing tabs, player check), `/catalog/quick-links`.
- **Backend:** `catalog` API module; worker `catalog` and `store` jobs (cache revalidation); images through `files`.
- **DB:** `catalog.ts`, `quick-links.ts`.
- **Specs and ADRs:** S06 (catalog), S09, S22 (quick links, search commands); ADR 0020, 0034, 0037.
- **E2E:** store `catalog`, `store`, `convenience` (quick buy and links); admin `catalog`, `game-player-check`, `quick-links`.
- **Known leads:** no unsaved-changes guard on the game form; category separators hard-coded (`catalog-parts.tsx:88,96`).

### A04 Purchase, orders and fulfilment (money out)
- **Store:** the buy box and slide-to-pay, `/cart`, `/orders`, `/orders/[id]`, `/orders/[id]/print`, `/g/[token]`, `/r/[token]`, `/v/[code]`, `/account/players`, `/account/alerts`, the order problem sheet.
- **Admin:** `/orders`, `/orders/$id`, `/orders/live`, `/orders/new`, `/orders/policy`.
- **Backend:** `orders` API module (orders, checkouts, reservations, player checks, shares, codes, order help, product alerts); worker `orders` jobs (fulfilment, polling, webhooks, reservations, alerts); `packages/db/src/orders`.
- **DB:** `orders.ts`, `product-alerts.ts`, `customers.ts` (saved players).
- **Specs and ADRs:** S08, S10, S11, S16 (admin orders), S22 (order help, alerts); ADR 0004, 0013, 0022, 0023, 0024, 0025, 0030.
- **E2E:** store `purchase`, `orders`, `convenience`, `order-help`; admin `orders`, `admin-orders`, `live`.
- **Known leads:** the refund dialog never shows the amount refunded (`decision-dialogs.tsx:113-160`); `/orders/new` places a money order with no confirmation step and no leave guard; the admin order's customer link goes to the wallet, not the profile (`order-page.tsx:160-166`); event reasons render with `dir="ltr"` (`order-page.tsx:639`); `body as never` casts in `orders.queries.ts`; the cart removes a line with no undo (`cart-page.tsx:323`); after accepting the merchant terms the customer must slide again (`cart-page.tsx:382`, `buy-box.tsx:685`); the print page's sign-in redirect drops `?paper` and `?content` (`print-page.tsx:79`); `/v/[code]` hard-codes the brand name (`verify-page.tsx:72`); `({count})` hard-coded in the live room (`live-page.tsx:139`).

### A05 Suppliers and pricing
- **Admin:** `/suppliers`, `/suppliers/$code` (connection, catalog, offers, statement, runs, health), `/suppliers/$code/categories/$categoryId`, `/suppliers/policy`, the routes drawer, `/pricing`, `/pricing/lists`, `/pricing/lists/$id`, `/pricing/matrix`, `/pricing/reviews`.
- **Backend:** `suppliers`, `pricing` API modules; worker `suppliers` and `pricing` jobs (sync, health, balance, repricing); `packages/suppliers` (WDGZone, FazerCards, the fake supplier).
- **DB:** `suppliers.ts`, `pricing.ts`, `price-lists.ts`.
- **Specs and ADRs:** S06 (pricing), S07, S16, S17, S18, S19, S20 (price lists); ADR 0005, 0020, 0021, 0030–0035.
- **E2E:** admin `suppliers`, `supplier-catalog`, `supplier-fields`, `pricing`, `price-lists`.
- **Known leads:** FazerCards' sync fails with HTTP 403 `subscription_inactive` on `list_categories` and `list_offers` every 15 minutes in production (worker log, 2026-10-27, A04 deploy): the account's subscription or the stored key needs the owner, and the failed syncs raise no visible alert; a literal NUL byte in `suppliers/category-page.tsx:91` (git treats the file as binary); category unlink and ignore, route archive, enable and priority, and review accept (single and bulk) run with no confirmation (`catalog-tab.tsx:469`, `category-page.tsx:198`, `routes-drawer.tsx:375-418`, `reviews-page.tsx:209,364`); content rendered outside `DialogContent` (`matrix-page.tsx:234`, `reviews-page.tsx:454-457`); the price preview posts on every keystroke (`pricing.queries.ts:57-63`); `as never` casts in the pricing and supplier queries; USD amounts without `ltr()` (`connection-tab.tsx:513`, `routes-drawer.tsx:234`); from A03: the supplier import sets `catalog_products.game_amount` from pack names, which gave PUBG Mobile's subscriptions, passes, offers and WOW coins an amount the calculator read as UC (A03-1, fixed in the data).

### A06 Merchants
- **Store:** `/merchant` and its tabs (dashboard, `pos`, `bulk`, `prices`, `price-list`, `statements`, `statements/[month]`, `alerts`, `receipt`), the two print pages, `/merchant-terms`, `/account/merchant`.
- **Admin:** `/merchants/applications`, `/merchants/applications/$id`, `/merchants`, `/merchants/levels`, `/settings/merchants`.
- **Backend:** `merchants`, `merchant-tools` API modules; worker `merchants` jobs (levels, alerts, statement email).
- **DB:** `merchants.ts`, `merchant-tools.ts`.
- **Specs and ADRs:** S20 (merchants), S21; ADR 0035, 0036.
- **E2E:** store `merchant`, `merchant-tools`, `merchant-counter`, `merchant-documents`, `private-prices`; admin `merchants`, `merchant-levels`.
- **Known leads:** POS and bulk ignore `MERCHANT_TERMS_REQUIRED` (no terms sheet, S20 MT2) and never check a frozen account (`common.frozen` unused); the price-list print button stays clickable when the list is empty because `Button` with `render` drops `disabled` (`price-list-page.tsx:175-181`, `packages/ui/src/components/button.tsx:51`); sequential reads on every tools page and no stale-response guard in `useMerchantRead`; the POS order strip hangs as a skeleton when its read fails; a failed `setOrderSale` loses the typed price silently (`pos-page.tsx:565`); bulk "pay all" stays enabled with a shortfall; back arrow points forward on the application page (`application-page.tsx:65`); unused catalog keys that mark unbuilt spec items (dashboard shortcuts, POS codes print, the bulk table): owner decision.

### A07 Customers, support and notifications
- **Store:** `/notifications`, `/support`, `/support/new`, `/support/[id]`; the notification bell, push opt-in.
- **Admin:** `/customers`, `/customers/$id`, `/support`, `/support/$id`, `/support/new`, `/settings/support`, `/settings/telegram`.
- **Backend:** `customers`, `support`, `notifications`, `telegram` API modules; worker `support`, `telegram`, `email`, `push` jobs; the live stream.
- **DB:** `customers.ts`, `support.ts`, `notifications.ts`, `telegram.ts`.
- **Specs and ADRs:** S05 (bot, notifications), S12, S15 (web push); ADR 0019, 0026, 0029.
- **E2E:** store `notifications`, `push`, `support`; admin `customers`, `support`, `telegram`.
- **Known leads:** the buy box subscribes to the notification stream for a signed-out visitor too (`purchase/customer.ts:31`, `notifications/live.ts:34`): the stream answers 401 and is opened again every 5 s, doubling up to a minute, for as long as a game page is open (A04 production smoke test); ticket picker errors are plain `<p>` instead of `FieldError` (`new-ticket-page.tsx:208,223`); no merchant-applications badge in the sidebar although the dashboard raises it.

### A08 Content
- **Store:** `/about`, `/faq`, `/terms`, `/privacy`, `/refund`, the announcement bar, home banners, live activity.
- **Admin:** `/content/pages`, `/content/pages/$page`, `/content/faq`, `/content/banners`, `/content/announcements`, `/content/activity`.
- **Backend:** `content` API module; worker `store` revalidation for content.
- **DB:** `content.ts`.
- **Specs and ADRs:** S14; ADR 0028.
- **E2E:** store `content`; admin `content`.
- **Known leads:** archiving FAQ items, banners and announcements runs with no confirmation (`banners-page.tsx:214`, `announcements-page.tsx:189`); no E2E opens `/about`, and `/privacy` only as a link.

### A09 Control, reconciliation and reports
- **Store:** the stop banner and frozen banner.
- **Admin:** `/` (dashboard), `/reconciliation`, `/reconciliation/runs/$id`, `/reports`, `/audit`, `/settings/switches`.
- **Backend:** `dashboard`, `reconciliation`, `treasury`, `reports`, `audit`, `settings` API modules; worker `reconciliation` jobs.
- **DB:** `reconciliation.ts`, `treasury.ts`, `audit.ts`, `settings.ts`.
- **Specs and ADRs:** S05 (switches), S11 (dashboard), S13; ADR 0019, 0025, 0027.
- **E2E:** store `switches`; admin `dashboard`, `reconciliation`, `reports`, `switches`.
- **Known leads:** `useStartRun`, `useExplainResult` and `useShamCashCount` skip re-authentication (`reconciliation.queries.ts:104-140`); the supplier correction dialog has no E2E; report presets go stale past midnight (`reports-page.tsx:65`); the export link is revoked at once (`reports.queries.ts:70-75`); the audit filter accepts from-after-to.

### A10 Platform, performance and operations
- **Store:** the root layout, header, footer, `error`, `not-found`, `/offline`, `/sw.js`, the install prompt, `robots`, `sitemap`, fonts.
- **Admin:** `__root`, the app shell, sidebar, badges, `SwitchesBanner`.
- **Backend:** `health`, global guards, error filter, rate limits, logging and Sentry; worker `system` jobs.
- **Ops:** `deploy/` (nginx, CSP, limits, fail2ban, systemd, backups, health check), CI, `docs/deployment.md`.
- **Specs and ADRs:** S15 (PWA), Phase 0; ADR 0001, 0002, 0008, 0009, 0011, 0012, 0014, 0015.
- **E2E:** store `pwa`, `store`; admin `forms`.
- **Known leads:** Next.js warns that `cacheComponents` is on without a `partialPrefetching` choice (production store log, 2026-10-26); header account links prefetch against the store rule (`balance-chip.tsx:55`, `notification-bell.tsx:106`, `account-menu.tsx:87-108`); `robots.ts` relies on per-page `noindex` for `/support/`, `/v/`, `/q/`; no E2E reaches the admin root error and not-found pages; backups still live on the production server (Launch checklist); the panel's switches banner is titled "طريقة إيداع موقوفة مؤقتاً" when a supplier is paused (`switches-banner.tsx:28`, `ar.json` `switches.banner.pausedTitle`; A02 live test); from A02: the USDT scanner stuck on one transfer has no alert naming it (A02-28), no database guard ties a credited USDT deposit to its transfer (A02-29), TXID lookups have no index (A02-30), `updated_at` comes from the app's clock while some reads compare it with `now()` (`columns.ts`); from A03: hard-coded punctuation and list separators in JSX across both apps (`'، '` in seven panel files, `× {count}`, `·` in the store; A03-18, A03-28); the add/edit dialogs close on Escape or a click outside with no question when something was typed (A03-24); the OpenAPI export marks request fields with defaults as required, so the panel casts create bodies `as never` (A03-22); the store caches an unknown game slug as `null` for the catalog's life (A03-34); the catalog tables keep `DELETE` for the app role and slugs are immutable only in code, since the tests and the seed delete catalog rows as the app role (A03-36); the quick-buy slot reserves its height for a signed-in customer with no cards (A03-39); `nest start --watch` for the API restarted in a loop on this machine while the worker's watcher ran (A03 live test; the API was run from its build); the health timer can fire during a deploy's PM2 reload and restart the API it finds answering 000 (A03 deploy, 08:12 UTC); from A04: the every-minute deletion of ended product alerts has no index on `ended_at` (A04-28: a partial index needs a migration; small at V1 volumes); hard-coded punctuation in the order screens of both apps (A04-34, with A03-18 and A03-28); the orders module's `as never` request casts (A04-47, A03-22's cause; the proof upload's `FormData` cast is right).

## The audit dimensions

Every group goes through every dimension. A dimension with nothing to report says so in the report, with what was checked.

1. **Spec conformance:** every rule, screen and acceptance item of the group's specs is built as written; deviations are listed (fix, or owner decision).
2. **Backend:** each endpoint declares its access; customer endpoints filter by owner (no IDOR); input through the contracts' Zod schemas; coded errors; idempotency keys on money and supplier writes; rate limits (app and nginx); audit entry in the same transaction for money and admin actions; re-authentication on sensitive admin actions; no secret or personal data in logs or Sentry.
3. **Database:** constraints, foreign keys, unique and check constraints match the rules; indexes for every list and lookup; transactions and lock order; ledger invariants (append-only, double entry, balances as sums); archive instead of delete; migrations backward compatible; grants for the app role.
4. **Worker:** jobs safe to run twice; retries with backoff and classified errors; stuck states have an exit; supplier calls only through `packages/suppliers`; time zones and schedules.
5. **Frontend code:** the folder's `CLAUDE.md` pattern; typed API client (no `as never`); loading, empty, error-with-retry and stale-data states; live updates and visibility re-reads; race-free reloads; no sequential reads that can run together.
6. **UI and UX:** `brand/identity.md`; RTL with logical CSS, icons and arrows in the right direction; Latin digits; all text through i18n; phone width and desktop; dark and light; 44 px touch targets; keyboard and screen reader (labels, focus, `aria-*`); confirmations on destructive and money actions, with the amount stated; clear refusal messages.
7. **Security and fraud:** authentication and session handling; authorization on every path; enumeration and brute force; abuse paths (repeated refunds, double credit, price tampering, cart or quantity tricks, gift and share links); file uploads; CSP and headers; data exposure in responses.
8. **Performance:** query counts and N+1; payload size; caching and tags; bundle and first-load budget; re-render storms; debounced searches.
9. **Tests:** unit and integration coverage of the rules and money paths (concurrency and idempotency); E2E coverage of every screen, its states and refusals; every fix gets a regression test that fails before it.
10. **Observability and audit:** logs useful without personal data; Sentry; audit entries readable in `/audit`; alerts to Telegram where the spec asks.
11. **Live browser test:** see below.

## Severity and finding IDs

| Level | Meaning | Handling |
|---|---|---|
| P0 | Money lost or duplicated, a security hole, data of one customer visible to another | Fix at once, before anything else; tell the owner in the next message |
| P1 | A broken flow, a wrong result, a missing guard or confirmation on a money or destructive action | Fix in the group |
| P2 | Inconsistency, missing state, accessibility, performance, test gap | Fix in the group |
| P3 | Polish | Fix in the group when it is cheap; otherwise list as deferred with the reason |

Finding IDs are `A<group>-<n>` (A02-7), numbered in the order found, never reused. Commits and tests name the ID they fix.

## The cycle of a group

1. **Start:** pull `main`, branch `fix/audit-a<nn>-<slug>`, set the group's status to `in progress`, create `docs/audits/A<nn>-<slug>.md` from the template below and `TASKS.md` with the phases.
2. **Map:** list every screen, dialog, endpoint, job, table, email and E2E spec of the group from the code (subagents for wide reads). Read the specs and ADRs named above.
3. **Audit:** go through the eleven dimensions. Record every finding in the report as it is found, with `file:line`, before fixing anything. Verify each known lead above; drop it if the code proves it wrong, and say so.
4. **Live test:** run the stack and test every screen of the group in the browser pane.
5. **Show the owner** the findings table in Arabic (counts by level, the P0/P1 list, and every item that needs a decision), then continue with the fixes without waiting unless an item needs a decision.
6. **Fix:** P0 first, then P1, P2, P3. Each fix with its regression test; run only the tests touched (`pnpm verify <files>`). Business-rule or scope changes go to `docs/open-questions.md` and wait for the owner; never guess them.
7. **Re-test live:** the changed screens again in the browser, with screenshots.
8. **Close:** `pnpm verify` through the `checker` and the `reviewer` at the same time; fix, verify again; the report complete; `docs/ROADMAP.md` audit line updated; PR with auto-merge ("Finishing a task" in `AGENTS.md`).
9. **Deploy:** once the PR is merged and CI is green, deploy `main` to production (`docs/deployment.md`), re-run `provision.sh` when `deploy/` changed, smoke-test the group's screens on production without real money, and set the status to `deployed`.
10. **Report** in the `AGENTS.md` format, with the next group's first line under "Next step".

A group too large for one reviewable PR is split into at most two (backend and data, then screens), each closed as above.

## Live browser test

- Local stack: `bash scripts/pull-catalog-snapshot.sh` (read-only copy of the production catalog), `pnpm db:reset-local --yes` (after stopping `pnpm dev`; ask the owner the first time), `pnpm dev`, then `pnpm db:seed-local` (customers, wallets, deposits, orders in every state, merchants, tickets, content). Store `http://127.0.0.1:3001`, admin `http://127.0.0.1:5173`.
- Drive states with the local tools in the `AGENTS.md` commands table: the fake supplier (`supplier:fake`), fake USDT transfers and balance, fake Telegram updates, `order:place`, `checkout:place`. Never a live supplier, chain or real money.
- For every screen of the group: desktop and phone width (375 px), dark and light, each state (loading, empty, error, refusals, live updates), keyboard only, and the browser console and network panel free of errors. Screenshots of each screen go to the report's evidence list (kept under `.verify/` or the session's scratchpad, never committed with customer data).
- Requests stay gentle: the production fail2ban rules do not apply locally, but the same habits keep the tests realistic.

## Report template (`docs/audits/A<nn>-<slug>.md`)

```markdown
# A<nn> <name>

Status: in progress | merged (PR link) | deployed (commit)
Branch: fix/audit-a<nn>-<slug> · Started: <date> · Specs: … · ADRs: …

## Scope
Screens, dialogs, endpoints, jobs, tables, emails and E2E specs, as mapped from the code.

## Summary
Counts by level and dimension; what changed for the customer and the admin.

## Findings
| ID | Level | Dimension | Where | Finding | Fix | Test | Status |
|---|---|---|---|---|---|---|---|

## Owner decisions
Items moved to `docs/open-questions.md`, with the answer once given.

## Deferred
Items not fixed in this group, with the reason and where they go (a later group, a follow-up).

## Live test evidence
Each screen with the states tested, widths and themes, and the screenshot names.

## Checks
The final `pnpm verify` summary, the reviewer's result, CI, the deploy and the production smoke test.
```
