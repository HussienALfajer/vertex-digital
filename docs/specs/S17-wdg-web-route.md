# S17 — WDGZone Web Purchase route

Status: Approved · Date: 2026-10-18 · Scope: `docs/product/v1-scope.md` §F09 (extends S07 and S16, owner 2026-10-18) · ADRs: 0004, 0005, 0020, 0021, 0022, 0030, 0032

## Summary
WDGZone sells the six PUBG Mobile UC packs through two routes: **Auto** (ids 235203–235208, delivered in seconds) and **Web Purchase** (ids 286552–286557, `WEB 60 UC` … `WEB 8100 UC`, 0.7–7% cheaper, finite stock of about 1,000 per pack refreshed daily at 00:00 UTC, delivered in 5–30 minutes). Today a store product can have only one route per supplier, so the cheaper offer cannot be used. S17 lets one product carry both WDG offers: the router sends to Web Purchase first (lowest cost, ADR 0005) and falls back to Auto when it is out of stock or fails definitively. The store price stays on the Auto cost, so the Web Purchase saving is kept as margin (ADR 0032). A Web Purchase route has its own expected delivery time, shown to the customer while the order waits, and its own hard limit before the order is held for the owner.

## Precondition (WDG's claims, checked 2026-10-18)
WDG support wrote to the owner on 2026-10-18 that ids 286552–286557 are now `type=topup` with `player_id` required, stock 1,000 per pack refreshed at 00:00 UTC, failures refunded automatically (status `refunded`), delivery 5–30 minutes, and that the account is Tier-2 VIP (`discount_percent` 2.00 on eligible items). **Checked on 2026-10-18** in the admin supplier catalog after a sync (read-only, `docs/suppliers/wdgzone.md`, "WDG's answer and the catalog check"): the six packs are listed as supported direct top-ups with the single `player_id` field, stock 1,000 (999 for 660 UC), costs 0.7–6.7% below Auto. So no adapter change is needed. The VIP discount seen is about 1.2% on three Auto packs, not 2.00%; it does not affect S17 (edge case 7). Delivery time, refunds and the daily refresh can only be seen live (Acceptance).

## In scope / out of scope
- In:
  - Several live routes of one supplier on one product (one route per offer stays).
  - A per-route "counts for the price" switch (`price_basis`), with the price rules of ADR 0032.
  - Per-route expected delivery time (customer hint) and hard limit (held for review), snapshotted on the attempt.
  - An out-of-stock refusal marks a finite-stock offer out of stock until the next sync.
  - No low-stock alert for routes that do not count for the price.
  - The admin route drawer, the S07 route form and the S16 link sheet showing these settings.
  - The first live Web Purchase order before customers are routed to it (Acceptance).
- Out:
  - Health per route (owner, 2026-10-18: health stays per supplier; a WDG refusal is an answer, so a Web Purchase refusal or refund does not lower WDG's score, and a delivery failure moves to the next route by A04).
  - Any change to the measured delivery time on packs (owner, 2026-10-18: it stays the real measure over every route, so it rises with Web Purchase orders).
  - Any adapter change, any other supplier's offers, products other than the six UC packs (the rules are generic; only these routes are configured now).
  - Reading WDG's stock between syncs.

## Access
| Action | Route kind | Who |
|---|---|---|
| Add a route, or link a category's packs, to a product that already has a route of the same supplier | Admin (S07 RT1, S16 link) | The admin |
| Change a route's `price_basis`, expected delivery time or hard limit | Admin, same access as the route's other settings (S07) | The admin |
| See the expected delivery hint on an order | Customer (own order; not on share links) | The order's owner |

## Data
- `product_routes` (S07):
  - **Drop** the unique index `product_routes_product_id_supplier_id_live_idx`. `product_routes_offer_id_live_idx` (one live route per offer) stays and already makes `(product_id, offer_id)` unique among live rows. Migration through `/db-migration`; dropping a unique index is backward compatible.
  - `price_basis` boolean, not null, default `true` (every existing route keeps counting).
  - `expected_delivery_minutes` integer, null (none), 1–240.
  - `hard_limit_minutes` integer, null (the policy's `hard_limit_minutes`), 5–240 (the policy's own bounds).
  - Check: when both are set, `expected_delivery_minutes < hard_limit_minutes`; when only the expected time is set, it is below the policy's limit at the time of saving (checked by the API, `ROUTE_TIMING_INVALID`).
- `fulfilment_attempts` (S08): `expected_delivery_minutes` and `hard_limit_minutes`, integers, null, copied from the route when the attempt is created (an admin-chosen or manual attempt copies its route's too). A later route change does not move an open attempt's limit.
- Contracts: the route schemas gain `priceBasis`, `expectedDeliveryMinutes`, `hardLimitMinutes`; the customer order response gains `expectedWithinMinutes` (int or null). Error codes: `ROUTE_EXISTS` is removed (nothing raises it once the index is gone); `ROUTE_TIMING_INVALID` is added with its Arabic text.
- No new table. Prices, price rows and reviews are unchanged in shape.

## States and rules
Routes (amends S07 RT1, P1, P3; S16 SF2; S08 F7):
- WR1. A product may have several unarchived routes of one supplier, each to a different offer. An offer still serves at most one product (`OFFER_ALREADY_MAPPED`). RT2–RT8 apply to each route as before.
- WR2. **Router order** is unchanged (RT5–RT6: tier, then cost, then priority, then supplier code; skip routes unprofitable for the price paid, PR5; a definitive failure tries the next candidate, a route already tried is skipped). So Web Purchase is tried first while it is cheaper, and Auto after a definitive failure (`OUT_OF_STOCK` refusal, WDG `refunded`/`410`). An unknown outcome is never followed by another route (ADR 0004).
- WR3. **Price basis** (ADR 0032): the basis route is the first usable route by RT5–RT6 **among routes with `price_basis`**. The price follows it by P1–P3 as today.
- WR4. When no `price_basis` route is usable but another route is: a product that has a price keeps it unchanged (no price row, no review), and sells at it while the margin guard allows (the guard reads the real cost of the usable routes, PR5). A product that never had a price takes the first usable route as its basis (P1 over all routes).
- WR5. A cost change of a route without `price_basis` never moves the price and never opens a review (P3). It still reprices the guard's view (a route whose cost rises above the price minus the minimum margin is skipped by PR5).
- WR6. Turning `price_basis` on or off reprices the product at once, like any route change (ADR 0021, no review), and is audited.
- WR7. **New routes:** the S07 route form and the S16 link sheet send `priceBasis`; the panel pre-sets it **on** when the product has no other unarchived route and **off** when it has one, and the admin may change it. The API default stays `true` for a request that omits it.
- WR8. **Out of stock on refusal:** when a first send of an attempt is refused with the adapter's out-of-stock code (WDG `OUT_OF_STOCK`) and the offer reports a finite stock (`stock` not null), the same transaction that fails the attempt sets the offer `in_stock = false` and `stock = 0` and reprices the products it serves; the next sync writes WDG's real values back. A refused re-send stays unknown (S16 RS1) and marks nothing. An offer with unlimited stock (Auto) is never marked this way.
- WR9. **Hard limit:** an automatic attempt still open `hard_limit_minutes` (its own, else the policy's) after sending is held exactly as F7 (needs review, Telegram alert, customer told it is delayed, polling every 30 minutes for 24 hours). The poll schedule is the policy's for every attempt.
- WR10. **Expected delivery hint:** while an order's open attempt has `expected_delivery_minutes`, the customer's order page replaces the measured expected time (S09 LT3) with "قيد التسليم، قد يستغرق حتى {n} دقيقة". The customer never sees the route, the supplier or "Web". When the attempt is held (WR9), the delayed copy of F7 applies as today.
- WR11. **Stock alerts** (S16 SF2) count only offers mapped by an enabled route with `price_basis`. The panel still shows "مخزون منخفض" or "نفد" on every offer and route.
- WR12. Health stays per supplier (H1–H5, unchanged).

Configuration for the six UC packs (done by the admin, not seeded): link WDG category 928542 "Web Purchase" to the PUBG Mobile game, each `WEB <n> UC` pack to the existing `<n> UC` product, with `price_basis` off, expected delivery 30 minutes, hard limit 45 minutes (owner, 2026-10-18), enabled only after the live test (Acceptance).

## Money flows
None new. Payment, the wallet debit, the attempt cost entry, refunds and the margin guard are S08's. With the price on the Auto cost, a Web Purchase delivery books the Web Purchase cost and the difference is margin; a fallback to Auto books Auto's cost, which is the price basis and therefore profitable. A refund after both routes fail is S08's refund.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/admin/catalog/products/:id/routes` (S07) | Admin | + `priceBasis?`, `expectedDeliveryMinutes?`, `hardLimitMinutes?` | route | `OFFER_ALREADY_MAPPED`, `ROUTE_KIND_MISMATCH`, `ROUTE_FIELDS_UNMAPPED`, `ROUTE_TIMING_INVALID` (no longer `ROUTE_EXISTS`) |
| `PATCH /api/admin/routes/:id` (S07) | Admin | + the same three fields | route | `ROUTE_TIMING_INVALID` |
| `POST /api/admin/suppliers/:code/categories/:categoryId/link` (S16) | Admin | rows gain `priceBasis?` | as today | row codes as today, without `ROUTE_EXISTS` |
| `GET /api/orders/:id` (S09); the share view does not carry it | Customer | — | + `expectedWithinMinutes` | — |

Paths are the existing ones (S07, S16, S09); only their bodies change. The OpenAPI document and the admin client are regenerated.

## Jobs and integrations
- `orders.fulfil` / send (S08): copies the route's timing onto the attempt; on a first-send out-of-stock refusal applies WR8 in the failing transaction.
- `orders.sweep` (S08): `pastHardLimit` reads the attempt's `hard_limit_minutes` before the policy's.
- `suppliers.sync` (S07, S16): unchanged reading; repricing applies WR3–WR5; the low-stock step applies WR11.
- No new supplier call. The first live order is the owner's (Acceptance).

## Screens
- **Admin, route drawer and route form (S07):** "يدخل في حساب السعر" switch with the help text "السعر يتبع المسارات المفعّل فيها هذا الخيار؛ المسار غير المحسوب يُستخدم أولاً إن كان أرخص ويبقى الفرق ربحاً"; "وقت التسليم المتوقع (دقيقة)" and "مهلة المراجعة (دقيقة، الافتراضي {policy})". A product's routes list shows a chip "لا يدخل في السعر" and the expected time.
- **Admin, S16 link sheet:** a per-row "يدخل في حساب السعر" checkbox pre-set by WR7; the row no longer refuses a product that already has a WDG route.
- **Admin, product page price line:** names the basis route as today; when WR4 holds the price, it reads "السعر محفوظ: لا مسار محسوب متاح".
- **Store, order page (S09):** WR10's line in place of the expected time; nothing else changes. RTL screenshots at phone width for both copies.

## Audit and notifications
- Route created, updated (including the three new fields) and archived: the existing S07 route audit entries, with before and after values.
- WR8 writes no audit entry (a system stock read, like a sync); the attempt's failure reason and supplier code are kept as today.
- Telegram: WR9 is F7's alert; WR11 suppresses stock messages for non-basis routes; no new message.

## Abuse and fraud
- A customer cannot choose or see the route; prices never drop with the cheaper route, so there is no price to race.
- Price manipulation by mis-configuration: WR7 pre-sets the switch off for an added route, and turning it on is audited and reprices at once (visible on the product page).
- A forged or replayed WDG webhook: unchanged S08 verification.
- Out-of-stock spoofing is not possible from outside: WR8 reads only the adapter's answer to our own send.

## Edge cases
1. Web Purchase runs out between syncs: the next order's send is refused, WR8 marks it out, the order goes to Auto in seconds; later orders skip Web until the sync after 00:00 UTC shows stock again.
2. Web Purchase accepts, then WDG refunds (`410` / `order.refunded`) after 20 minutes: definitive failure, Auto is tried; the customer waited for both. If Auto also fails, the order is refunded (S08).
3. Web Purchase still open at 45 minutes: held for review (WR9); Auto is not tried while the outcome is unknown.
4. Auto is down or out of stock and Web Purchase is usable: WR4 keeps the price; orders go to Web Purchase with its delivery hint.
5. Both routes unusable: the product is out of stock (ADR 0020), as today.
6. Web Purchase becomes dearer than Auto (a promotion ends): the router takes Auto first by cost; nothing else changes.
7. The 2% VIP discount lowers WDG's `price` on eligible items: a cost change under 10% reprices at once (P3) for basis routes; it changes nothing on the price for Web routes (WR5).
8. The admin turns `price_basis` on for Web Purchase: the price follows its cost at once (WR6) and back to Auto's when it runs out (ADR 0021): the daily flapping the owner chose to avoid; the panel help text says so.
9. A route's timing is changed while an attempt is open: the open attempt keeps its copy.
10. A product with only non-basis routes and no price (new product): WR4's second sentence gives it a basis.
11. An order of quantity above Web Purchase's remaining stock: WDG refuses (`OUT_OF_STOCK` or `INSUFFICIENT_STOCK` mapped to definitive by the adapter); WR8 applies only to the out-of-stock code; the order moves to Auto either way.
12. The sync runs while WR8 marks an offer: both lock the offer row; the later write wins; the next sync corrects any stale value within 15 minutes.

## Open questions
- None for the owner. WDG's 2.00% discount was not seen (about 1.2%); it changes nothing here and is tracked in `docs/suppliers/wdgzone.md`.

## Acceptance
- **Owner, after deploy (production, real money, ~$0.88):**
  1. In the supplier catalog after a sync, the six `WEB` packs show as supported, `player_id`, stock 1,000 (999), category "Web Purchase".
  2. Link category 928542 to PUBG Mobile, each pack to its UC product, "يدخل في حساب السعر" off, expected 30, limit 45, routes **disabled**. The UC prices do not change.
  3. Live test on 60 UC at a quiet hour: disable the Auto route of 60 UC and enable its Web route (the price stays: WR4), place one walk-in admin purchase (S16) of 60 UC for the owner's own player id, then at once re-enable Auto. Record send time, WDG states seen, delivery time, cost booked, and the UC received in the game, in `docs/suppliers/wdgzone.md`.
  4. If delivered: enable the six Web routes. If refunded or held: leave them disabled and report.
- **Fake supplier, locally:** two fake offers on one product (cheap with finite stock, `price_basis` off; dear, on): the price follows the dear one; an order goes to the cheap one; `supplier:fake --order <cheap> failed` moves it to the dear one; `--stock-count <cheap> 0` then an order skips it; `slow:<seconds>` shows the hint on the order page; a pending past the route's limit is held.
- **Tests:**
  - db: two live routes of one supplier allowed, one live route per offer still enforced; the timing check; migration drift.
  - Unit (contracts/db): the basis among `price_basis` routes (WR3), the kept price (WR4), no review for a non-basis cost (WR5), `pastHardLimit` with an attempt's limit (WR9), the stock-alert filter (WR11).
  - API: route create and update with the new fields, `ROUTE_TIMING_INVALID`, a second route of one supplier accepted, the link row with `priceBasis`; 401 and 403 per endpoint; the customer order carries `expectedWithinMinutes` only for its own order.
  - Worker: WR8 on a first send (finite stock only), not on a re-send, not on unlimited stock; reprice after it; fallback to the next route.
  - E2E and RTL screenshots: the route drawer's three settings, the link sheet's checkbox, the store order page with the hint.

## Delivery
One PR (contracts, db migration, api, worker, admin, store, E2E), following `/feature-slice S17`.
