# A05 Suppliers and pricing

Status: in progress
Branch: fix/audit-a05-suppliers · Started: 2026-10-27 · Specs: S06 (pricing), S07, S16, S17, S18, S19, S20 (price lists) · ADRs: 0005, 0020, 0021, 0030–0035

## Scope
Mapped from the code.

## Summary

## Findings
| ID | Level | Dimension | Where | Finding | Fix | Test | Status |
|---|---|---|---|---|---|---|---|
| A05-1 | P1 | Spec, money | `packages/db/src/pricing/reprice.ts:375-392`; `apps/api/src/modules/pricing/pricing.service.ts:483-487` | Accepting a review, or adjusting its margin, to a price equal to the held one writes no retail row: the stored row keeps the old cost, rule id and minimum margin (Q21). Adjust margin to absorb a cost rise: availability reads the new rule's minimum, the purchase stores the row's old one, routing then refuses every route and each order is refunded; the next sync opens the same review again. | | | open |
| A05-2 | P1 | Spec SC13, data (known lead) | `apps/api/src/modules/suppliers/supplier-catalog.service.ts:315-342`; `packages/contracts/src/suppliers.ts:1186-1191` | The import and link drafts suggest every pack's first number as its game amount, which the sheet presets: a re-import gives subscriptions, passes, offers and a second currency an amount again (A03-1 in the data; the owner's A03-1 rule: packs in another unit leave it empty). | | | open |
| A05-3 | P1 | Spec, wrong goods | `apps/api/src/modules/suppliers/supplier-catalog.service.ts:318-325`, `:192,204` | The link draft and the link candidates match a pack to an existing product by the same number whatever its unit: "660 WOW coins" is preselected for the "660 UC" pack, so one save adds a route that delivers another currency to that product. | | | open |
| A05-4 | P1 | UI, money (known lead) | `apps/admin/src/features/suppliers/routes-drawer.tsx:371-377,414-419` | Archiving a route or switching it off runs on one click and reprices the product in the same transaction: on the basis route the price moves to the next route's cost or the pack goes unavailable, with no question (live: the basis route's "أرشفة"). | | | open |
| A05-5 | P1 | UI, destructive (known lead) | `apps/admin/src/features/suppliers/catalog-tab.tsx:468-471`; `category-page.tsx:191-195` | "فك الربط" on a category runs at once (the game page asks first): new packs stop being tracked and the link must be rebuilt. | | | open |
| A05-6 | P1 | UI, money (known lead) | `apps/admin/src/features/pricing/reviews-page.tsx:209-211` | "قبول المحدد" publishes up to 50 new store prices in one click with no count, pack or price stated first. | | | open |
| A05-7 | P1 | Frontend (known lead) | `apps/admin/src/features/pricing/reviews-page.tsx:403-405,454-457` | "تعديل الهامش": the dialog renders nothing while its preview loads and, on a failed preview, a `FormAlert` outside `DialogContent` in the page flow, with no close, focus or retry. | | | open |
| A05-8 | P1 | Money, worker | `apps/worker/src/jobs/suppliers/sync.job.ts:276-327,935-950`; `packages/db/src/suppliers/observed-cost.ts` | The sync reads the offer list outside its transaction, then writes the listed cost over any cost observed meanwhile (a charge, CH3, or a quote, PQ3) and confirms it at the run's start: a FazerCards pack paused after an overcharge is unpaused by a sync that read before the charge. | | | open |
| A05-9 | P2 | Frontend (known lead) | `apps/admin/src/features/pricing/matrix-page.tsx:234-236` | A matrix cell's dialog returns a bare skeleton outside `DialogContent` while the chain's rules load, and keeps it forever when a read fails: the click looks dead. | | | open |
| A05-10 | P2 | Money | `packages/db/src/pricing/routing.ts:522-524`; `purchase.ts:170,344` | Retail availability guards a held price with the live rule's minimum margin, while the order stores the row's minimum and routing guards with it: a minimum lowered during a hold shows the pack available, charges, then refunds every order. | | | open |
| A05-11 | P2 | Database, latent | `packages/db/src/pricing/reprice.ts:314` | `repriceListsAfterRetail` inserts every changed row in one statement (14 parameters a row): past about 4,681 rows (608 routed products and 8 non-retail lists) the supplier pause, a health change or a sync fails and rolls back. | | | open |
| A05-12 | P2 | Money | `apps/api/src/modules/suppliers/routes.service.ts:215-262,331-341` | A product can hold two live manual routes (add after archiving, then restore; or a double submit): the cheaper, older manual cost stays the basis while the real one rises. | | | open |
| A05-13 | P2 | Observability (known lead) | `apps/worker/src/jobs/suppliers/sync.job.ts:657-691`; `apps/worker/src/jobs/telegram/daily-summary.job.ts` | A failing sync sends one Telegram message per streak and nothing after; the daily summary has no failing-sync or inactive-plan line. Production: 267 FazerCards runs failed `subscription_inactive` since 2026-10-24, one `supplier_sync_failing` (2026-10-25) and one `supplier_subscription` inactive (2026-10-24, after the "expiring" one on 2026-10-22). | | | open |
| A05-14 | P2 | Worker (known lead) | `apps/worker/src/jobs/suppliers/sync-schedule.job.ts:37-49`; `sync.job.ts:434-441,465-472` | A supplier with an inactive plan is synced every 15 minutes with no backoff (the category list too, since `categoriesDue` never moves after a failure), and a sync refused with `subscription_inactive` never marks the plan inactive. | | | open |
| A05-15 | P2 | Worker, observability | `apps/worker/src/suppliers/supplier-calls.ts:32-33`; `health.job.ts:175-190` | While a plan is inactive its 403 refusals count as health errors: the supplier turns `down` and the alert reads as an outage. | | | open |
| A05-16 | P2 | Worker | `apps/worker/src/jobs/suppliers/sync.job.ts:70-71,616-633` | A run older than 10 minutes is closed `ABANDONED` by the next job while it may still be reading; the first run's write then fails with an alert. (Unconfirmed in production.) | | | open |
| A05-17 | P2 | Performance | `apps/worker/src/jobs/suppliers/health.job.ts:284-323` | `repriceStale` takes every product whose price follows a stale cost every minute, locking the same unavailable products again when nothing changes. | | | open |
| A05-18 | P2 | Adapter, money | `packages/suppliers/src/wdgzone/adapter.ts:531-538` | Any HTTP 410 on the delivery read becomes `failed_definitive`, even without WDG's body: a proxy's 410 on a delivered order refunds it. | | | open |
| A05-19 | P2 | Adapter | `packages/suppliers/src/fazercards/adapter.ts:214-216` | Any 404 on a category's offers counts as an empty category: a gateway 404 marks every offer in it missing. | | | open |
| A05-20 | P2 | Adapter | `packages/suppliers/src/core/http.ts:154-160` | `x-ratelimit-reset` is read before `retry-after` as a Unix time, while FazerCards sends seconds left: the wait collapses to 600 ms and the category is dropped. (Header presence unconfirmed.) | | | open |
| A05-21 | P2 | Adapter | `packages/suppliers/src/fazercards/adapter.ts:647,713` | A gift card order is recognised only by an optional `kind`/`type`: without it a completed gift is read as a top-up with no codes and waits for the admin. | | | open |
| A05-22 | P2 | Frontend | `apps/admin/src/features/suppliers/routes-drawer.tsx:383-389` | The priority select is not locked while saving: two quick changes race and decide the basis. | | | open |
| A05-23 | P2 | UI (known lead) | `apps/admin/src/features/suppliers/catalog-tab.tsx:463`; `category-page.tsx:186` | Ignoring a category hides its subtree at once with no question. | | | open |
| A05-24 | P2 | Frontend (live) | `apps/admin/src/features/suppliers/connection-tab.tsx:68,501-502` | The low-balance threshold card is keyed by the saved value: a save remounts it and "saved" never shows (live: $60 saved, no notice). | | | open |
| A05-25 | P2 | Frontend, stale data | `apps/admin/src/features/suppliers/add-route-dialog.tsx:108-118,228-264` | After the supplier changes, the previous supplier's offers stay listed and clickable while the new ones load: a click creates the route to the other supplier's offer. | | | open |
| A05-26 | P2 | Frontend | `apps/admin/src/features/suppliers/offers-tab.tsx:181-194`; `catalog-tab.tsx:324-326` | A page past the end shows the empty state with no pagination (importing a whole last page leaves no way back; `?page=9` says "no offers yet"). | | | open |
| A05-27 | P2 | Frontend states | `add-route-dialog.tsx:184-227`; `import-dialog.tsx:193-262`; `link-category-sheet.tsx:106-121`; `link-offer-dialog.tsx:83-98`; `routes-drawer.tsx:665` | Failed reads in the supplier dialogs show an empty select or field map, or an error with no retry. | | | open |
| A05-28 | P2 | UI (known lead) | `apps/admin/src/features/suppliers/connection-tab.tsx:513`; `routes-drawer.tsx:234` | USD amounts inside Arabic sentences without `ltr()`. | | | open |
| A05-29 | P2 | Code hygiene (known lead) | `apps/admin/src/features/suppliers/category-page.tsx:91` | A literal NUL byte: git treats the file as binary, diffs cannot show it. | | | open |
| A05-30 | P2 | Frontend (known lead) | `apps/admin/src/features/pricing/pricing.queries.ts:60,72,180`; `suppliers/suppliers.queries.ts:450,468,517,528` | `as never` casts on request bodies and the matrix query. | | | open |
| A05-31 | P2 | UI, money (known lead) | `apps/admin/src/features/pricing/reviews-page.tsx:361-364` | A single review accept publishes the new price with no confirmation stating the price now and the proposed one. | | | open |
| A05-32 | P2 | Performance (known lead) | `apps/admin/src/features/pricing/pricing.queries.ts:57-63` | The price preview posts on every keystroke and keeps the previous answer on screen with no stale cue: "$X" for "1" while "15" is typed. | | | open |
| A05-33 | P2 | Frontend (live) | `apps/admin/src/features/pricing/matrix-page.tsx:73-76`; `matrix-search.ts:32` | Unticking the last list falls back to wholesale and cost: retail alone cannot be shown (live: `lists=[]`, the cost box ticked again). | | | open |
| A05-34 | P2 | UI, money | `apps/admin/src/features/pricing/fixed-price-dialog.tsx:92-104,157-189` | A fixed price below the floor (cost plus the minimum) shows only a "احتياطي" badge: no warning sentence, no question on save. | | | open |
| A05-35 | P2 | Frontend states | `apps/admin/src/features/pricing/fixed-price-dialog.tsx:165-168` | A failed matrix read in the fixed-price dialog says "no cost now, no valid route" with no retry. | | | open |
| A05-36 | P2 | Frontend states | `pricing-page.tsx:48-50`; `list-rules.tsx:370-371`; `fixed-price-dialog.tsx:66-67`; `matrix-page.tsx:62-63,201` | Pickers' game and category reads fail silently; a failed lists read makes every matrix cell click a no-op. | | | open |
| A05-37 | P2 | Frontend states | `apps/admin/src/features/pricing/matrix-page.tsx:64,146`; `reviews-page.tsx:76,228` | `keepPreviousData` with no stale cue: switching game keeps the other game's rows clickable until the answer. | | | open |
| A05-38 | P2 | Performance | `apps/admin/src/features/pricing/matrix-page.tsx:65,110,158-197`; contracts `pricing.ts:771-789` | Each keystroke in the matrix search re-renders the whole table (up to 1,600 cells); a search past 200 packs is cut with no notice. | | | open |
| A05-39 | P2 | Accessibility | `apps/admin/src/features/pricing/matrix-page.tsx:183-187` | A matrix cell's `aria-label` replaces its content: a screen reader never hears the price, margin or warnings. | | | open |
| A05-40 | P2 | Refusals | `apps/admin/src/features/pricing/price-lists-page.tsx:185-189`; `ar.json` `pricing.lists.inUse` | `PRICE_LIST_IN_USE` for a list a merchant level holds reads "0 حساب مُسند و0 قائمة فرعية". | | | open |
| A05-41 | P2 | Refusals | `apps/admin/src/features/pricing/price-lists-page.tsx:166,215-229` | The parent picker offers lists at the depth limit (generic refusal); a taken name lands above the form, not on the field. | | | open |
| A05-42 | P2 | Frontend pattern | `price-lists-page.tsx:215-229`; `fixed-price-dialog.tsx:92-97`; `price-list-page.tsx:284-289` | Hand-rolled forms without `useFocusInvalid`: a refused submit does not focus the field. | | | open |
| A05-43 | P2 | Spec S20 | `apps/admin/src/features/pricing/fixed-price-dialog.tsx:115-143`; `matrix-page.tsx` | S20: fixed prices with a product search, and a matrix cell opening the fixed price or the rule; built: a game select then a pack select, the fixed price only. | | | open |
| A05-44 | P2 | Tests | api `suppliers`, `supplier-catalog`, `pricing`; worker `suppliers`; admin E2E `suppliers`, `supplier-catalog`, `pricing`, `price-lists` | Missing: the findings above; a real concurrent sync; a refused `subscription_inactive` sync; a streak past its first alert; route archive, restore and priority; threshold save; runs tab; the category page's actions and errors; bulk accept; matrix search, warnings, cells; list rename, archive refusals; 375 px screenshots. | | | open |
| A05-45 | P3 | Live updates | `apps/admin/src/features/suppliers/runs-tab.tsx:33` | The runs list never refreshes while a run is running. | | | open |
| A05-46 | P3 | Performance | `apps/admin/src/features/suppliers/suppliers.queries.ts:347-366` | Every supplier write invalidates `suppliers`, `catalog` and `pricing`, so live supplier reads run again against the supplier. | | | open |
| A05-47 | P3 | i18n | `routes-drawer.tsx:302,326,336,349`; `connection-tab.tsx:276,347`; `' › '` in five files; `%` in `health-tab.tsx`; pricing `price-preview.tsx:46`, `reviews-page.tsx:317,414`, `matrix-page.tsx:263`, `price-list-page.tsx:82,332` | Hard-coded punctuation and separators in JSX (A03-18 class). | | | open |
| A05-48 | P3 | Accessibility | `apps/admin/src/features/suppliers/offers-tab.tsx:423-431,536-544` | Chip clear buttons are 24 px icon buttons with no tooltip. | | | open |
| A05-49 | P3 | UI | `apps/admin/src/features/suppliers/catalog-tab.tsx:117` | A failed row action deep in the tree shows its error at the top of the tab, with no focus move. | | | open |
| A05-50 | P3 | Frontend | `apps/admin/src/features/suppliers/route-settings.tsx:62-64` | The timing check uses the default limit while the policy loads. | | | open |
| A05-51 | P3 | Frontend | `catalog-tab.tsx:492`; `offers-tab.tsx:452` | The search box's text does not follow the URL on back and forward. | | | open |
| A05-52 | P3 | Frontend (unconfirmed) | `apps/admin/src/features/suppliers/link-offer-dialog.tsx:52-57` | A suggested pack missing from the game's list does nothing when clicked. | | | open |
| A05-53 | P3 | Adapter | `wdgzone/adapter.ts:463`; `fazercards/adapter.ts:622` | A caller's shorter `timeoutMs` would replace the 30 s purchase timeout (nobody sets it today). | | | open |
| A05-54 | P3 | Adapter (unconfirmed) | `packages/suppliers/src/core/hmac.ts:280-289` | A hex signature is compared case-sensitively. | | | open |
| A05-55 | P3 | API | `apps/api/src/modules/orders/player-checks.service.ts:441` | The 5 s player-check race leaves the adapter's request open up to 15 s. | | | open |
| A05-56 | P3 | Adapter | `packages/suppliers/src/core/image.ts:417-426` | An image's `content-type` is never checked. | | | open |
| A05-57 | P3 | Tests | `packages/suppliers/src/fake/adapter.ts:431-432,713-718` | The fake ignores `placed` in `getOrder` and cannot script an inactive plan. | | | open |
| A05-58 | P3 | Adapter (unconfirmed) | `packages/suppliers/src/wdgzone/schemas.ts:143` | `order.failed`/`order.refunded` webhooks must carry `quantity`. | | | open |
| A05-59 | P3 | Worker | `apps/worker/src/jobs/suppliers/health.job.ts:92-103` | One supplier's error stops the health run for every supplier and `repriceStale`. | | | open |
| A05-60 | P3 | Performance | `health.job.ts:240-250`; `balances.job.ts:254-271` | Per-minute reads of `telegram_messages` by kind and supplier have no index. | | | open |
| A05-61 | P3 | Observability | `apps/worker/src/jobs/suppliers/sync.job.ts:421-428,843` | An empty FazerCards window after a failed category read fails as `CATALOG_SUSPICIOUS`, hiding the refusal; partly failed windows say nothing. | | | open |
| A05-62 | P3 | Spec | `docs/specs/S07-suppliers.md:179`; `sync.job.ts:609` | S07 says `stately` and no retries; the queue is plain and the credentials' test sync takes default retries. | | | open |
| A05-63 | P3 | Observability | `apps/worker/src/jobs/pricing/fallback-notices.job.ts:46-53` | One Telegram message per list and pack a day: a cost spike may send hundreds. | | | open |
| A05-64 | P3 | Performance | `price-lists.service.ts:174`; `pricing.service.ts:561-571` | List creation and global rule changes reprice the catalog in one transaction (accepted by S20 edge case 12). | | | open |
| A05-65 | P3 | Spec RP3 | `apps/api/src/modules/pricing/price-lists.service.ts:174-176` | A route added while a list is created may leave that product without a row on the new list until its next repricing. | | | open |
| A05-66 | P3 | Database | `packages/db/src/schema/pricing.ts` (`margin_rules`) | No guard on `margin_rules`; the app role keeps `DELETE`. | | | open |
| A05-67 | P3 | Observability | `apps/api/src/cli/reprice-lists.ts` | `pricing:reprice-lists` adds rules with no audit entry and queues no store refresh. | | | open |
| A05-68 | P3 | Backend | `apps/api/src/modules/pricing/pricing.service.ts:381-382` | A deadlock in a bulk decide answers 500 and loses the per-review results already committed. | | | open |
| A05-69 | P3 | Spec | `packages/db/src/pricing/matrix.ts:30-33` | The matrix can show 9 columns (8 lists plus retail); the contract says 8 with retail. | | | open |
| A05-70 | P3 | Performance | `packages/db/src/pricing/matrix.ts:82-85` | The matrix runs `productRoutingStates` once per extra list. | | | open |
| A05-71 | P3 | Spec SC6 | `apps/api/src/modules/suppliers/routes.service.ts:331-341` | Restoring a route does not refuse an ignored offer. | | | open |
| A05-72 | P3 | Performance | `suppliers.service.ts:780-806`; `packages/db/src/suppliers/catalog.ts:73-169` | `GET /api/admin/suppliers` (every 60 s per tab) reloads every category tree and offer. | | | open |
| A05-73 | P3 | Performance | `apps/api/src/modules/suppliers/supplier-live.service.ts:129-161` | A failed thumbnail is fetched again on every view and recorded each time. | | | open |
| A05-74 | P3 | Database hygiene | `apps/api/src/modules/suppliers/supplier-catalog.service.ts:413-416` | A refused import leaves its stored cover behind. | | | open |
| A05-75 | P3 | UI | `apps/admin/src/features/pricing/pricing-page.tsx:60-64,133`; `rule-dialog.tsx:161-171` | The calculator's sample cost is not checked against 0 or $10,000; no field error; the preview error has no retry. | | | open |
| A05-76 | P3 | Money rule | `apps/admin/src/features/pricing/pricing-format.ts:51` | `ruleTexts` divides an amount by 1e6 (the contracts forbid `/` on amounts). | | | open |
| A05-77 | P3 | UI | `apps/admin/src/features/pricing/list-rules.tsx:413-421` | Once a pack is chosen in the target dialog there is no way back to the whole game. | | | open |
| A05-78 | P3 | UI | `list-rules.tsx`, `game-pricing.tsx`, `rule-dialog.tsx`, `fixed-price-dialog.tsx` | Dialogs close on Escape with no question when something was typed (A03-24). | | | open |
| A05-79 | P3 | UI | `apps/admin/src/features/pricing/price-list-page.tsx:278-281` | The account search reads on every keystroke with no loading, empty or error state. | | | open |
| A05-80 | P3 | Accessibility | `list-rules.tsx:234-251,327-345`; `game-pricing.tsx:124-145`; `price-lists-page.tsx:145-151`; `price-list-page.tsx:154-164`; the catalog's "المسارات" (live) | Row buttons ("تعديل", "أرشفة", "المسارات") share one name with no target. | | | open |

## Owner decisions

## Deferred

## Live test evidence

## Checks
