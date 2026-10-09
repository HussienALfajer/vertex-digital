# S09 — Storefront and purchase (F12, F13, F15)

Status: Approved · Date: 2026-10-09 · Scope: `docs/product/v1-scope.md` §F12, §F13, §F15 (A02, A08's store side, A15; with §F26 SW7 and §F27) · ADRs: 0002, 0003, 0004, 0005, 0008, 0011, 0012, 0013, 0015, 0019, 0020, 0021, 0022, 0023

## Summary
S08 can sell, but only from a developer's command line: the store has no catalog pages, no buy box and no search. S09 opens the shop window. The home page lists the games by category with a live service status. Each game page shows its packs with USD and SYP prices, savings, the measured delivery time, the ID guide and a "how many do I need" calculator. A buy box (a bottom sheet on phones) takes the game's fields, checks the player ID live (with a quota guard), and pays with slide-to-pay. The order page then follows the order live over the existing SSE stream. When the wallet is short, the customer can **reserve** the order (`awaiting_balance`, 24 hours, at most 3). It is paid automatically after a deposit (A02), at the lower of the saved and current price, or it expires (A15). `Ctrl+K` search finds games and packs by Arabic and English names, admin-entered search terms and tolerant matching. Banners and live activity stay with S14 (owner, 2026-10-09).

## In scope / out of scope
- In:
  - **F12 store pages:** home (`/`) and game pages (`/games/[slug]`), server-rendered and cached with Cache Components, refreshed when prices, availability, health, the rate or the catalog change. Public catalog read routes; responsive image widths; `sitemap.xml` and page metadata.
  - **Service status** (A08 store side): per game ("تعمل بشكل طبيعي" / "أبطأ من المعتاد" / "غير متوفرة حالياً") and one line on the home page, derived from supplier health and availability, never naming a supplier (owner, 2026-10-09).
  - **Measured delivery time** on packs and in the buy box (S08 rule T1).
  - **"كم أحتاج؟" calculator**: the cheapest combination of available packs reaching a target in-game amount; each pack is bought on its own (owner, 2026-10-09; S10 adds "add all to cart").
  - **F13 buy box:** pack, input fields with the ID guide, quantity, totals in USD and SYP, live player validation with its cache, limits and daily supplier quota, the "confirm the ID yourself" path, slide-to-pay, and idempotent submission through S08's `POST /api/orders`.
  - **Reservations** (`awaiting_balance`): created from the buy box when the balance is short. They are paid by A02 after a deposit credit and by a 5-minute sweep, cancelled by the customer, or expired by A15.
  - **Live order timeline:** the order page and "طلباتي" follow status changes over the S05 customer stream (a new `order` event).
  - **F15 search:** `Ctrl+K` / `⌘K` / the header button, over games and packs; Arabic normalization, fuzzy matching, admin search terms per game, recent searches on the device.
  - **Admin additions:** search terms on the game form; each supplier's daily validation quota with today's usage; reservation and player-check details on the order page; the `awaiting_balance` and `cancelled` statuses in the orders list.
  - **Notifications:** `order_paid` (center only) and `order_cancelled` (center and email) for reservations; the `validation_quota_reached` Telegram alert.
- Out (later or never):
  - Featured banners (F21) and live activity (F25): S14 adds them to the home page (owner, 2026-10-09). S09 shows no banners and no activity numbers. It never shows fake ones either.
  - Saved player IDs, one-tap recharge (F14), cart, gift top-up and shareable receipts (F16): S10. The calculator's "add all" waits for the cart.
  - Customer "pay now" for a reservation: none. The deposit hook and the 5-minute sweep pay it.
  - Category pages: the home page shows every category as a section with jump chips; a category route can come with S14's content work.
  - AVIF images: not in V1. WebP at four widths covers the browsers in use, and encoding AVIF costs CPU on the shared server.
  - JSON-LD structured data: not in V1, since the store never injects API data as script (ADR 0015).
  - English UI: Phase 4. English names are shown and searchable.

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the storefront, a game page, the search index, catalog images | Public, cached | Anyone |
| Check a player ID | Customer, rate limited | Signed-in customer with a verified email |
| Buy, or reserve when the balance is short | Customer, `Idempotency-Key`, rate limited (S08 O1) | The same |
| Cancel an own reservation | Customer | The same |
| Open the stream (now also order events) | Customer, SSE (S05 NT6) | The same |
| Edit a game's search terms | Admin (part of the game edit, S06) | The admin |
| Set a supplier's daily validation quota | Admin | The admin |
| Pay reservations (A02, sweep), expire them (A15), refresh store caches | Worker jobs | System |
| Refresh the store's cache | Internal: loopback only, shared secret | The worker |

Signed-out visitors see every public page and the buy box's fields. Validating, buying and reserving ask them to sign in (and to verify the email first), then return them to the same pack.

## Data
Money is USD units (micro-dollars, ADR 0003). SYP is display only and never stored, except S08's display total on an order.

### Contracts
- `catalog.ts`: `searchTermsSchema` (0–20 terms, each 1–40 characters after normalization, unique after normalization); `storefrontSchema`, `storeGameSchema`, `storeProductSchema`, `searchIndexSchema` (below); `GAME_SERVICE_STATUSES` (`normal`, `slow`, `unavailable`), `STORE_SERVICE_STATES` (`normal`, `slow`).
- Pure functions (100% coverage):
  - `normalizeSearchText(text)` (rule SR1) and `searchCatalog(index, query)` (SR2–SR4);
  - `cheapestPackCombination(packs, target)` (rule CL1–CL3);
  - `gameServiceStatus(products)` and `storeServiceState(games)` (rule SS1–SS2);
  - `reservationCharge(saved, current)` (rule RS6);
  - `orderTimeline(changes)` (rule LT1), which replaces `stageTimeline`;
  - `CATALOG_IMAGE_WIDTHS` = `[160, 320, 640, 1280]`.
- `orders.ts`:
  - `ORDER_STAGES` gains `awaiting_balance`, and `orderCustomerStage('awaiting_balance')` answers it (O13 completed);
  - `CANCEL_REASONS` (`expired`, `customer`, `price_rose`, `product_changed`);
  - `PLAYER_CHECK_STATES` on orders (`valid`, `invalid_confirmed`, `unchecked_confirmed`, `none`);
  - `createOrderSchema` gains `whenBalanceShort` (`refuse` default, or `reserve`) and `confirmPlayer` (boolean, default false);
  - `playerCheckRequestSchema` (`productId`, `fields`) and `playerCheckSchema` (below);
  - `ORDER_TIMELINE_STEPS` (`reserved`, `paid`, `sent`, `retrying`, `delayed`, `delivered`, `partially_refunded`, `refunded`, `cancelled`);
  - the reservation limits `RESERVATION_HOURS = 24` and `RESERVATIONS_MAX = 3`.
- `suppliers.ts`: `validationQuotaSchema` (0–1,000,000; 0 turns validation off for that supplier).
- `notifications.ts`: events `order_paid` (center only, no email template) and `order_cancelled` (email, can be turned off; params: order number, product name, reason). The stream's events gain `order` (`orderStreamItemSchema`: `{ orderId, status, stage }`; nothing else).
- `telegram.ts`: kind `validation_quota_reached`.
- Error codes: `PLAYER_NOT_CONFIRMED`, `RESERVATIONS_LIMIT_REACHED` (`details.limit`), `ORDER_NOT_CANCELLABLE` (`details.status`), each with its Arabic text. Existing codes: `RATE_LIMITED`, `VALIDATION_FAILED`, `NOT_FOUND`, `EMAIL_NOT_VERIFIED`, and S08's purchase codes.
- `audit.ts`: actions `order.reserved`, `order.cancelled`, `supplier.validation_quota_set`.
- Queues (`jobs.ts`): `orders.pay_waiting` (`{ customerId }`), `orders.waiting_sweep` (every 5 minutes), `store.revalidate` (`{}`).

### `orders` (changed)
- `purchase_journal_id` becomes nullable. A check requires it to be set unless the status is `awaiting_balance`, or `cancelled` with no `paid_at`.
- `expires_at` timestamptz, nullable: set when the order is created `awaiting_balance` (creation + 24 hours). Kept after payment as a record.
- `cancel_reason` enum `order_cancel_reason`, nullable. A check: set if and only if the status is `cancelled`.
- `reserved_at` timestamptz, nullable: when the order was created as a reservation.
- `player_check` enum `order_player_check`, not null (`none` for existing rows by the migration's default); `player_name` text nullable, at most 64 characters, set only with `valid`.
- Indexes: `(customer_id) where status = 'awaiting_balance'` (the limit and A02); `(expires_at) where status = 'awaiting_balance'` (A15).
- The guard trigger (S08) changes in one way only. On `awaiting_balance → paid`, the price columns (`price_id`, `unit_price_usd_units`, `total_usd_units`, `min_margin_usd_units`, `display_rate_id`, `total_syp_units`) may change, and `purchase_journal_id` and `paid_at` are set. Identity and field columns stay fixed. A `cancelled` order is terminal like the others.

### `player_checks` (new; owner `orders`; a cache, not a business record)
- `game_id` FK; `fields_hash` text (`^[0-9a-f]{64}$`: HMAC-SHA-256 under `PLAYER_CHECK_SECRET` of the game id and the canonical trimmed values of the game's unarchived fields, so the table holds no player IDs); `result` enum (`valid`, `invalid`); `player_name` text nullable ≤ 64 (printable characters only, trimmed); `supplier_id` FK; `customer_id` FK (whose request made the call); `created_at`; `expires_at` (`valid`: +24 hours; `invalid`: +1 hour; owner, 2026-10-09).
- Index `(game_id, fields_hash, created_at desc)`; index `(expires_at)`.
- The app role has `SELECT`, `INSERT` and `DELETE`. The sweep deletes rows expired for more than a day. The table has no audit and no trigger: it is a cache of a supplier's answer, and its lookups are recorded in `supplier_calls`.

### `suppliers` (changed)
- `validation_daily_quota` int 0–1,000,000, default 1,000 (owner, 2026-10-09, until SHOP2TOPUP's real quota is known: Q12). Changed from the supplier page and audited.
- Today's usage is counted from `supplier_calls` (`operation = 'validate_player'`) since 00:00 `Asia/Damascus`. A new index `(supplier_id, operation, created_at desc)` serves the count.

### `catalog_games` (changed)
- `search_terms` text[] not null default `'{}'`: at most 20, each 1–40 characters, stored normalized (SR1) and unique. Edited with the game (S06 `updateGameSchema`), audited in `catalog_game.updated`.

### Environment
- `PLAYER_CHECK_SECRET` (32 bytes base64, api) and `STORE_REVALIDATE_SECRET` (32 bytes base64, api, worker and store). Fake values go in `.env.example`; the apps refuse to start without them.

## States and rules

### Storefront and game pages (F12)
- SF1. The storefront shows active, unarchived games of unarchived categories, in category then game order. A paused game is not shown anywhere on the store: not on the home page, not in search, and its page answers not found. CT3 has new games paused until they are complete. Paused or unavailable **products** of an active game show greyed out in place, with "غير متوفرة حالياً", no price and no buy action (S06 CT9).
- SF2. A pack shows its Arabic name, in-game amount, USD price (large), SYP equivalent (`sypDisplayPrice`, muted, with "≈"), the savings badge when PR7 gives one ("وفّر 12%"), and its delivery-time chip. Prices come from the product's current price row (S07). Without a rate, SYP is hidden.
- SF3. **Delivery time** (S08 T1): with stats, the chip reads the median ("خلال 40 ثانية عادةً"). The buy box adds the p90 ("9 من كل 10 طلبات خلال دقيقتين"). Durations round up to whole seconds under a minute, to whole minutes under an hour, then to hours. Without stats (fewer than 5 orders): no chip on the pack; the buy box says "لا بيانات كافية بعد عن وقت التسليم".
- SF4. **Freshness:** store pages read the public routes inside `'use cache'` with the tag `catalog` and `cacheLife` revalidation of 5 minutes. A change that alters what those routes return queues `store.revalidate` in its own transaction: catalog edits, price rows, availability changes, supplier health changes, a supplier pause, and rate changes. The job, a singleton queued at most once per 10 seconds, calls the store's `POST /_internal/revalidate` (loopback, `STORE_REVALIDATE_SECRET`). That route calls `revalidateTag('catalog')`. Delivery stats refresh within the 5-minute life. The price a customer pays is always checked again at pay (S08 O4, `PRICE_CHANGED`).
- SF5. **Images:** `GET /api/catalog/images/:id?w=<160|320|640|1280>` serves the image fitted to that width (never upscaled) as WebP. `files` makes each variant once with the same decoder limits as CT10, stores it beside the original and serves it immutable. Any other `w` is `VALIDATION_FAILED`. The store uses `srcset` with these widths.
- SF6. **SEO:** each game page has a title ("شحن <name_ar> | VERTEX DIGITAL"), a description from its names and region notes, and its cover as the Open Graph image. `sitemap.xml` lists the home page and the shown games. `robots.txt` lets crawlers in except under `/wallet`, `/orders`, `/account`, `/notifications` and `/_internal`.

### Service status (A08 store side)
- SS1. A game's status, from its unarchived products' availability (S07 P6) and the health tier of each available product's basis route (S07 P1, RT5):
  - `normal` when at least one available product's basis route is a healthy automatic route;
  - `slow` when products are available but none has a healthy automatic basis route (degraded or manual only);
  - `unavailable` when no product is available.
  - Labels: "تعمل بشكل طبيعي", "أبطأ من المعتاد", "غير متوفرة حالياً". The chips are quiet, with an icon (`brand/identity.md` §6).
- SS2. The home page line is "كل الخدمات تعمل بشكل طبيعي" when no shown game is `slow`, otherwise "بعض الألعاب أبطأ من المعتاد". An `unavailable` game does not change the line, since a product can be out of stock with every supplier healthy. The S05 stop banner (SW9) is separate and stays as it is.
- SS3. No supplier name, health number or cost ever reaches a public route.

### Calculator (F12)
- CL1. Shown on a game page when at least two available `direct` packs have a `game_amount`. The customer types a target amount (whole number, 1–100,000), prefilled empty.
- CL2. `cheapestPackCombination` returns counts per pack so that the summed amount is at least the target and the summed USD price is the lowest. Ties go to fewer packs, then to the smaller overshoot. It uses integer dynamic programming over amounts up to `target + the largest pack amount`. A pack may repeat (each unit is a separate order of quantity 1, or one order up to its `max_quantity`).
- CL3. The result lists each pack × count, with the total amount, the total USD and SYP and, when the target is overshot, "ستحصل على X (أكثر بـ Y)". Each line has "اشترِ" to open the buy box on that pack. Nothing is bought together until S10's cart.

### Buy box (F13)
- BB1. Selecting an available pack opens the buy box: a bottom sheet at phone width, a sticky side panel from `lg`. The URL keeps `?pack=<id>` so a sign-in returns to it. It shows the pack, its price and delivery time, the game's unarchived input fields in order (labels, help text, `dir="ltr"` for digits and phone, `inputMode="numeric"` for digits, `select` as options), "أين أجد المعرّف؟" opening the guide image, a quantity stepper when `max_quantity > 1`, and the totals (unit × quantity, USD and "≈" SYP).
- BB2. Field values are checked in the browser with the same CT7 schema the server uses (`orderFieldValuesSchema`), and errors show under each field.
- BB3. Signed out: the fields can be filled, but the action reads "سجّل الدخول للشراء" and returns to the same pack after sign-in, with the fields kept in session storage, never in the URL. Not verified: "أكّد بريدك الإلكتروني للشراء" links to verification.
- BB4. Signed in, the buy box reads the wallet balance in the browser (S02) and shows "رصيدك بعد الشراء: $X". When the total is above the balance, it shows "رصيدك $X، ينقصك $Y" with two actions: "احجز الطلب واشحن رصيدك" (rule RS1) and "اشحن رصيدك" (the deposit wizard with the shortfall prefilled, BB8).
- BB5. **Slide-to-pay:** "متابعة" opens a confirmation step. It shows the pack, quantity, each field's label and value in large LTR text, the in-game name when validated, the total, and the balance after. The confirmation is a slider: the handle travels from the start edge (right in RTL) to the end edge, and releasing it past 85% of the track confirms. Releasing earlier springs it back. Keyboard and screen readers: the handle is a `role="slider"`, and pressing `End` or the arrow keys to the end confirms. Motion respects `prefers-reduced-motion`. A reservation uses the same slider with "اسحب لحجز الطلب".
- BB6. **Submission:** the confirmation step creates one `Idempotency-Key` per request body, and a retry (network error, timeout) resends the same key and body. On `201` or `200` the store goes to `/orders/<id>`. Errors:
  - `PRICE_CHANGED`: the step shows the new price and asks to slide again;
  - `PRODUCT_UNAVAILABLE`: "هذه الباقة لم تعد متوفرة", and the page data refreshes;
  - `INSUFFICIENT_BALANCE`: the shortfall view of BB4;
  - `PLAYER_NOT_CONFIRMED`: back to the fields with the confirmation box shown;
  - `PURCHASES_STOPPED`: the stop text;
  - `RESERVATIONS_LIMIT_REACHED`: "لديك 3 طلبات محجوزة. ألغِ أحدها أو اشحن رصيدك";
  - `RATE_LIMITED`: the standard text.
- BB7. Unavailable packs, paused games and the purchase stop (SW7, read from the S05 status route the banner already uses) disable the action with their text. The server decides in every case.
- BB8. The deposit wizard (S03, S04) accepts `?amount=<USD cents>` and prefills the USD amount with the larger of the shortfall and the chosen method's minimum. The customer can change it. The wizard links back to the reservation when it was opened from one (`?order=<id>`).

### Player validation (F13, owner 2026-10-09)
- PV1. **When:** only for a signed-in, verified customer, for a `direct` product whose game has a usable route (S07 RT4) on a supplier with the `validatePlayer` capability, a quota above 0 and today's usage below it. The store calls `POST /api/player-checks` when every required field passes BB2, after 800 ms without typing or when a field loses focus. Never per keystroke. The same values are not sent twice in one page visit.
- PV2. **Route choice:** the first usable route in RT5–RT6 order whose supplier can validate and is under quota. The fields are mapped by that route's `field_map`, as an order would be. A test customer uses only `fake` routes (as S08 R4), otherwise `not_supported`.
- PV3. **Cache:** the newest unexpired `player_checks` row for `(game, fields_hash)` answers without a supplier call, whichever customer created it. A `valid` result lasts 24 hours and an `invalid` one 1 hour (owner, 2026-10-09). A supplier `unknown` or error is not cached.
- PV4. **Limits** (owner, 2026-10-09, "medium"), counting only requests that call a supplier (cache hits and `not_supported` answers are free):
  - per customer 10 per hour and 30 per 24 hours (`customer_rate_limits`, as S01's counters);
  - per IP 30 per hour;
  - nginx zone `vdplayercheck` (POST only).
  - Over a limit: `429 RATE_LIMITED`, which the store treats as "unavailable" (PV6).
- PV5. **Daily quota:** before a supplier call, the API counts today's `validate_player` calls of that supplier (`Asia/Damascus`). At or above `validation_daily_quota`, it tries the next capable route, else answers `unavailable` with reason `quota`. The first refusal of the day queues `validation_quota_reached` to Telegram (dedupe `validation-quota:<supplier>:<date>`). The count is read without a lock, so a burst may pass the quota by a few calls; a supplier's own refusal then answers `unavailable`.
- PV6. **Answers:** `{ result: 'valid', playerName? }` · `{ result: 'invalid' }` · `{ result: 'unavailable', reason: 'quota' | 'supplier' }` · `{ result: 'not_supported' }`. The supplier call has a 5-second timeout, and a timeout or error is `unavailable` (`supplier`). Every call is recorded in `supplier_calls` (S07 H1 counts it for health).
- PV7. **What the customer sees:**
  - `valid`: a success chip "الاسم في اللعبة: <name>" (or "المعرّف صحيح" without a name);
  - `invalid`: a warning "لم يجد المورد هذا المعرّف. تأكّد منه قبل الدفع" and a required checkbox "أنا متأكد من المعرّف" (owner, 2026-10-09: a warning, not a block);
  - `unavailable` or `RATE_LIMITED`: "تعذّر التحقق من المعرّف الآن. تأكّد منه بنفسك" with the same checkbox;
  - `not_supported`: no message, and the confirmation step shows the values large.
  - Changing a field clears the result and the checkbox.
- PV8. **Server check at purchase:** for a `direct` product where PV1 makes validation possible for this customer, the purchase reads the cache (PV3) for the order's fields:
  - `valid`: the order stores `player_check = valid` and the name;
  - `invalid` or no row: `confirmPlayer: true` is required (else `409 PLAYER_NOT_CONFIRMED`), and the order stores `invalid_confirmed` or `unchecked_confirmed`;
  - validation not possible: `none`, and `confirmPlayer` is ignored.
  - The purchase never calls a supplier. An order refused by the supplier for the account still refunds at once (S08 F1 `inputRejected`).

### Reservations (`awaiting_balance`, A02, A15; owner 2026-10-09)
- RS1. **Create:** `POST /api/orders` with `whenBalanceShort: 'reserve'` runs S08's O1–O6 and PV8 in the same transaction. When the wallet balance (read under the wallet lock) covers the total, the order is paid as usual. When it does not, the order is inserted as `awaiting_balance` with the current price row, minimum margin and SYP display, `reserved_at = now`, `expires_at = now + 24 h`, no journal. It writes the `reserved` event, the audit entry `order.reserved` and the `order` stream event. With `refuse`, S08's `INSUFFICIENT_BALANCE` stands.
- RS2. **Limit:** at most 3 open reservations per customer, counted under the wallet lock, else `409 RESERVATIONS_LIMIT_REACHED`. Reservations count toward S08's purchase rate limits (same route). The purchase stop refuses reservations too (`PURCHASES_STOPPED`).
- RS3. **No money moves** while reserved. The balance is not held: the customer may spend it elsewhere, and the reservation then waits for the next credit.
- RS4. **Paying (A02):** `orders.pay_waiting` (`stately` per customer) runs at three points: queued in the transaction of every deposit credit (the Sham Cash approval in the panel and from Telegram, the USDT automatic credit and the USDT review approval, at the three existing A02 hook comments); for every customer with open reservations by `orders.waiting_sweep` every 5 minutes; and right after RS1 creates a reservation. It takes the customer's open reservations, oldest first. Each one runs in its own transaction:
  1. take the switches lock shared: with `purchases_stopped` on, stop the run (SW7: A02 waits while purchases are stopped);
  2. lock the order `FOR UPDATE`: skip it unless it is still `awaiting_balance` and `expires_at > now()`;
  3. lock the product `FOR SHARE`. Unavailable for this customer (S08 O3): skip it, so it stays reserved until it expires (owner, 2026-10-09);
  4. the input fields must still validate against the game's unarchived fields (O5); otherwise cancel it with `product_changed`;
  5. compute the charge (RS6). When the price rose and no usable route is profitable at the saved price, cancel it with `price_rose`;
  6. post the purchase journal (S08 M1). `INSUFFICIENT_BALANCE`: roll back this order only and **continue with the next** (owner, 2026-10-09: skip and pay what the balance covers);
  7. update the price columns, set `paid_at` and `purchase_journal_id`, move `awaiting_balance → paid`, write the event, the audit entry (`order.paid`, actor system), the `order_paid` notification (center only) and `orders.fulfil`.
- RS5. **Player check at pay:** the reservation's own `player_check` stands. The cache is not read again at pay.
- RS6. **Charge** (owner, 2026-10-09): `reservationCharge(saved, current)` is the lower unit price. When the current price is lower, the order takes the current price row and its minimum margin (available by step 3, so profitable). When the saved price is lower or equal, the order keeps its saved row, and the margin guard is checked against the current rule's minimum margin: some usable route must have `saved − cost ≥ minimum margin`. Otherwise the order is cancelled with `price_rose`. The SYP display is recomputed at today's rate.
- RS7. **Expiry (A15):** S08's `orders.sweep` (every minute) moves reservations with `expires_at ≤ now()` to `cancelled` (`expired`, actor system), in batches with `FOR UPDATE SKIP LOCKED`, and notifies `order_cancelled` (center and email). The order lock settles a race with RS4: whichever commits first wins, and the other sees the new status.
- RS8. **Customer cancel:** `POST /api/orders/:id/cancel` moves an own `awaiting_balance` order to `cancelled` (`customer`). It sends no notification, and any other status answers `ORDER_NOT_CANCELLABLE`. Paid orders cannot be cancelled (S08).
- RS9. **Cancellations by the system** (`price_rose`, `product_changed`, `expired`) notify `order_cancelled` with the reason in plain words: "انتهت مدة الحجز (24 ساعة)", "تغيّر سعر الباقة"، "تغيّرت بيانات الباقة". The email is on by default and can be turned off (NT8). `order_paid` is in the center only: the delivery notification follows within seconds (owner, 2026-10-09).

### Live order timeline (F13)
- LT1. `orderTimeline(changes)` turns the order's status changes into steps:
  - `→ awaiting_balance`: `reserved`;
  - `→ paid`: `paid`;
  - the first `→ sent_to_supplier`: `sent`;
  - a later `→ sent_to_supplier` (from `failed` or `needs_review`): `retrying`, with only the newest kept;
  - `→ needs_review`: `delayed`;
  - each terminal status: its own step;
  - `failed` alone adds nothing (short-lived).
  - Labels: "حُجز الطلب"، "تم الدفع"، "قيد الشحن"، "نجرّب مساراً آخر"، "تأخّر، نتحقق منه"، "تم التسليم"، "سُلّم جزئياً واسترد الباقي"، "مُسترد"، "ملغى".
  - The order response's `timeline` carries these steps and their times, replacing S08's stage list. Upcoming steps (paid → قيد الشحن → تم التسليم) show greyed while the order is open.
- LT2. **Live:** every order status change, plus reservation and cancellation, sends `pg_notify('customer_orders', '<customer id>:<order id>:<status>')` on commit. The API's LISTEN connection (S05 NT6) also listens on that channel and sends the customer's open streams an `order` event (`{ orderId, status, stage }`). The order page refetches when the event names its order. "طلباتي" refetches the cards on screen. On `resync` and on `visibilitychange` both refetch.
- LT3. The order page adds the following:
  - a reserved order shows "بانتظار رصيدك" with a countdown to `expires_at`, the shortfall from the browser's balance, "اشحن رصيدك" (BB8) and "إلغاء الطلب" (a confirmation dialog);
  - a cancelled order shows its reason (RS9);
  - a validated order shows "الاسم في اللعبة: <name>";
  - while open, the order shows the expected time from SF3;
  - on delivery, the brand's three-stroke success sequence plays once (`brand/identity.md` §6), with reduced motion respected.

### Search (F15, owner 2026-10-09)
- SR1. `normalizeSearchText`:
  - lower case; Unicode NFKC; Arabic diacritics and tatweel removed;
  - `أ إ آ ٱ` → `ا`, `ة` → `ه`, `ى` → `ي`, `ؤ` → `و`, `ئ` → `ي`;
  - Arabic-Indic and Persian digits → Latin;
  - punctuation → space, spaces collapsed, trimmed.
  - Search terms are stored normalized.
- SR2. **Index:** `GET /api/catalog/search-index` returns every shown game (SF1) and its unarchived products. Games carry the id, slug, Arabic and English names, search terms, cover, category name and status. Products carry the id, game slug, name, in-game amount, availability, USD price and SYP. Its cache tag and life are the storefront's.
- SR3. **Matching** over normalized text, by tokens:
  - a query token matches a name or term token when it is equal, a prefix (from 2 characters), or within edit distance 1 (tokens of 4–7 characters) or 2 (8 or more; Damerau–Levenshtein);
  - every query token must match;
  - a product also matches through its game's names and terms ("ببجي 60" finds "60 UC" of PUBG Mobile);
  - digits match only exactly or as a prefix.
- SR4. **Ranking:** exact over prefix over fuzzy; games before packs; available before unavailable; then the catalog order. At most 6 games and 8 packs.
- SR5. **Dialog:** opened by the header search button (every page), `Ctrl+K` / `⌘K`, or `/` when no field has focus. The code and the index load on first open, so neither weighs on the first load. Results update as the customer types, with arrow keys, `Enter` and `Esc`. A game opens its page; a pack opens its game page with `?pack=<id>` (the buy box opens on it). Empty query: the last 5 searches from `localStorage` on this device, with "مسح" (wrapped in try/catch; nothing reaches the server). No results: "لم نجد نتائج لـ «…»" with a link to the home page. Unavailable packs show greyed.
- SR6. The home page has a large search field that opens the same dialog.

### Admin
- AD1. Game form (S06): "كلمات البحث" as chips (add with `Enter`, remove with ×), at most 20. Duplicates after normalization are refused (`VALIDATION_FAILED` with `details.searchTerms`).
- AD2. Supplier page (S07), for suppliers with the `validatePlayer` capability: "حصة التحقق اليومية" with today's usage ("312 من 1000 اليوم"), editable (audited, `supplier.validation_quota_set`, before and after).
- AD3. Order page (S08): the reservation times (`reserved_at`, `expires_at`), the cancel reason, and the player check ("تم التحقق: <name>"، "أكّد العميل رغم عدم العثور عليه"، "أكّد العميل دون تحقق"، "بلا تحقق"). Orders list: `awaiting_balance` and `cancelled` in the status filter and under "الكل". A tab is not needed: reservations need no admin action.

## Money flows
- **Reserve:** none. No journal, no hold.
- **Pay a reservation (A02):** S08 M1 at the charge of RS6: journal `purchase`, key `order:<id>:purchase`; `customer_wallet:<customer>` **−total**, `sales_revenue:USD` **+total**. Posted once (the key, the order lock and the `awaiting_balance` status check). From then on, S08's M2 and M3 apply unchanged.
- **Cancel or expire a reservation:** none (nothing was taken).
- **Immediate purchase from the buy box:** S08 M1 unchanged.
- **Player validation:** none (supplier calls carry no charge for the store; a supplier fee, if any, is Q12).

## API
Customer responses `Cache-Control: no-store`. Public catalog responses `Cache-Control: public, max-age=30`, with no cookie read or set.

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/catalog/storefront` | Public | — | `storefrontSchema`: `{ service: 'normal' \| 'slow', categories: [{ slug, nameAr, games: [{ id, slug, nameAr, nameEn, cover, accentColor, status }] }] }` | — |
| `GET /api/catalog/games/:slug` | Public | — | `storeGameSchema`: game (names, cover, accent, guide image, region notes, status), fields (key, label, help, type, required, bounds, options), products (id, kind, name, game amount, max quantity, `available`, price USD and SYP or null, savings, `deliveryStats`, `playerCheck` boolean, region and redemption for codes), rate id | `NOT_FOUND` (unknown, archived or paused) |
| `GET /api/catalog/search-index` | Public | — | `searchIndexSchema` (SR2) | — |
| `GET /api/catalog/images/:id` | Public, immutable (S06) | `w?` (SF5) | `image/webp` | `NOT_FOUND`, `VALIDATION_FAILED` |
| `POST /api/player-checks` | Customer, PV4 limits | `playerCheckRequestSchema` (`productId`, `fields`) | `playerCheckSchema` (PV6) | `VALIDATION_FAILED`, `PRODUCT_UNAVAILABLE`, `RATE_LIMITED`, `NOT_FOUND`, `EMAIL_NOT_VERIFIED` |
| `POST /api/orders` (S08, extended) | Customer, `Idempotency-Key` | `createOrderSchema` + `whenBalanceShort`, `confirmPlayer` | `201` `orderSchema` (`paid` or `awaiting_balance`; `200` on a replay) | S08's codes + `PLAYER_NOT_CONFIRMED`, `RESERVATIONS_LIMIT_REACHED` |
| `POST /api/orders/:id/cancel` | Customer | — | `orderSchema` | `ORDER_NOT_CANCELLABLE`, `NOT_FOUND` |
| `GET /api/orders/:id` · `GET /api/orders` (S08, extended) | Customer | — | adds `expiresAt`, `cancelReason`, `playerName`, the stage `awaiting_balance` and the LT1 `timeline` | — |
| `GET /api/notifications/stream` (S05, extended) | Customer, SSE | — | adds the `order` event (LT2) | — |
| `PATCH /api/admin/catalog/games/:id` (S06, extended) | Admin | `searchTerms?` | `gameDetailSchema` with `searchTerms` | `VALIDATION_FAILED` |
| `PUT /api/admin/suppliers/:code/validation-quota` | Admin | `{ quota }` | `supplierSchema` with `validationQuota` and `validationsToday` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `GET /api/admin/orders/:id` · `GET /api/admin/orders` (S08, extended) | Admin | `status` accepts `awaiting_balance`, `cancelled` | adds the reservation, cancel and player-check fields | — |
| `POST /_internal/revalidate` (store, not the API) | Loopback only, `Authorization: Bearer <STORE_REVALIDATE_SECRET>` (timing-safe) | — | `204` | `401` |

Statuses: `409` for `PLAYER_NOT_CONFIRMED`, `RESERVATIONS_LIMIT_REACHED`, `ORDER_NOT_CANCELLABLE`. nginx denies `/_internal/` on the public host (`404`), and the store route also refuses a request that did not come from the loopback.

## Jobs and integrations
- `orders.pay_waiting` (`stately` per customer; `{ customerId }`): RS4. Safe to run twice: each order is paid under its lock, only from `awaiting_balance`, and the journal key is unique. Retries 3 with backoff.
- `orders.waiting_sweep` (every 5 minutes): queues `orders.pay_waiting` for each customer with an open, unexpired reservation (at most 500 per run, oldest first). Paying needs the stately job, so a queued one makes this a no-op.
- `orders.sweep` (S08, every minute) gains two steps: RS7 expiry (at most 100 per run) and deleting `player_checks` rows expired for more than a day.
- `store.revalidate` (singleton, at most once per 10 seconds): SF4. It calls the store on `127.0.0.1:<STORE_PORT>` with a 5-second timeout. A failure retries 3 times, then logs a warning; the 5-minute cache life is the fallback, and a failure raises no alert.
- Supplier calls: `validatePlayer` from the API (PV2–PV6) through `SupplierRegistry` with decrypted credentials, recorded in `supplier_calls` (operation `validate_player`; `ok` for valid or invalid, `error` for a timeout or unknown answer). Adapters map "player not found" to `valid: false`. The real adapters' mapping is Q12's adapter PRs. The fake adapter already answers `invalid…` players as invalid, and `supplier:fake --errors on` fails its validation calls for the "unavailable" path.
- Telegram: `validation_quota_reached` ("⚠️ بلغت حصة التحقق اليومية لدى SHOP2TOPUP (1000). العملاء يؤكدون المعرّف بأنفسهم حتى منتصف الليل"; dedupe `validation-quota:<supplier>:<date>`). The daily summary (AL3) adds the day's validations per supplier and the reservations paid and expired.
- Customer notifications (S05 `notifyCustomer`, in the transaction of the change): `order_paid` (center only), `order_cancelled` (center and email, reasons of RS9). Params: order number, product name, reason; never field values.
- `order:place` (api CLI) gains `--reserve` (`whenBalanceShort: 'reserve'`) and `--confirm-player`.

## Screens

### Store (phone width first, Arabic RTL, dark default; `brand/identity.md` §6)
- **Header (every page):** a search button (icon and, from `md`, "ابحث عن لعبة أو باقة" with the `Ctrl K` hint).
- **`/` home:**
  - a short hero with the large search field (SR6);
  - the service line (SS2) as a quiet chip;
  - category jump chips;
  - one section per category with its games as cards: 2 columns at 360 px, 3 from `sm`, 5 from `lg`. Each card has the cover in the brand frame, the Arabic name, the English name muted, the status chip, and the accent on the border on hover. An `unavailable` game is greyed with "غير متوفرة حالياً".
  - Empty catalog: "نجهّز المتجر، عُد قريباً".
  - Static and cached; customer parts (header balance, bell) load in the browser as today.
- **`/games/[slug]`:**
  - hero: the accent as a flat band, the cover, the names, the status chip and the region notes;
  - "أين أجد المعرّف؟" (the guide image, collapsible);
  - the packs as cards (SF2), with unavailable ones greyed;
  - the calculator (CL1–CL3), collapsible;
  - the buy box (BB1–BB8, PV7) as a bottom sheet on phones and a sticky panel on desktop;
  - for code products: the region and redemption text under the pack.
  - Not found for an unknown, archived or paused game.
  - Loading: the cached page renders at once. The buy box shows skeletons only for the balance and the check.
- **Search dialog** (SR5): a full-screen sheet on phones, a centred dialog on desktop.
- **`/orders/[id]`** (S08, extended): the LT1 steps, live (LT2), and the reservation, cancel and validated-name details (LT3). **`/orders`**: the "بانتظار رصيدك" stage chip, live.
- **Deposit wizard** (S03/S04): the `?amount` prefill and the link back to the reservation (BB8).
- Every error shows its code's translation through `errorText()`. Prices use tabular Latin digits, `ltr()` inside Arabic sentences.

### Admin (Arabic, RTL, light and dark)
- Game form: "كلمات البحث" (AD1). Supplier page: the quota and today's usage (AD2). Order page and list: AD3.

## Audit and notifications
- Audit: `order.reserved` (customer: product, quantity, price, expiry), `order.paid` (system, for a reservation paid by A02: the charge and whether the current price was lower), `order.cancelled` (customer or system: reason), `supplier.validation_quota_set` (admin: before and after). The game's search terms are inside `catalog_game.updated`. Not audited: player checks (they are in `supplier_calls`), cache refreshes, reads.
- Customer notifications: `order_paid` (center), `order_cancelled` (center and email). S08's delivery, refund and delay notifications are unchanged.
- Telegram: `validation_quota_reached`; daily summary lines.

## Abuse and fraud
| Threat | Control |
|---|---|
| The store used as a free player-name lookup | Verified accounts only (and registration closed until the pilot); 10 an hour and 30 a day per customer and 30 an hour per IP for calls that reach a supplier; nginx `vdplayercheck`; the supplier quota; names returned only for the fields sent; `no-store`. Cache hits are free (owner): they only reveal accounts someone already checked in the last 24 hours |
| Exhausting the supplier's daily quota to break validation for everyone | Per-customer and per-IP limits, the cache, the Telegram alert; customers then confirm the ID themselves, so purchases never stop |
| Wrong player ID burning money | Validation before paying with a required confirmation when it is not `valid`; the confirmation step shows the values large; an `inputRejected` order still refunds at once (S08) |
| Double tap or retried slide paying twice | One `Idempotency-Key` per body, reused on retry; S08's unique key and wallet lock |
| A script bypassing slide-to-pay | Slide is a UX guard only; the server rules are the same for every client (price expectation, `confirmPlayer`, limits) |
| Locking a low price with reservations, then paying after a cost rise | At most 3 reservations for 24 hours; the margin guard at pay against the current rule; cancelled `price_rose` when no route is profitable |
| Spamming reservations | They count toward the purchase rate limit; 3 open at most; they move no money |
| Paying a reservation twice (deposit hook, sweep and a second credit at once) | `stately` job per customer, the order lock, the `awaiting_balance` check and the journal key `order:<id>:purchase` |
| A reservation paid while purchases are stopped | The switches lock and SW7 check in each pay transaction |
| Cache poisoning or personal data in cached pages | Public routes read no cookie and hold no customer data; customer parts load in the browser; the revalidate route is loopback-only with a secret and denied by nginx |
| Script injection through catalog text, search terms or a supplier's player name | Rendered as text only, no `dangerouslySetInnerHTML` for data (ADR 0015); player names limited to printable characters, at most 64 |
| Player IDs leaking from the cache table | Only an HMAC of the fields is stored; names expire within 24 hours and rows are deleted a day later |
| Reading another customer's order events | The stream fans out by the session's customer; events carry ids and status only |
| Stale prices shown after a change | Tag revalidation on change, a 5-minute ceiling, and `PRICE_CHANGED` at pay |

## Edge cases
1. The price changes while the buy box is open: the slide answers `PRICE_CHANGED`, and the confirmation shows the new price.
2. The product becomes unavailable while the buy box is open: `PRODUCT_UNAVAILABLE`, and the page refreshes its data.
3. The customer deposits while a reservation waits: the credit transaction queues `orders.pay_waiting`; the order is paid within seconds, and the page updates live.
4. Two reservations, $10 and $5, with $7 after a deposit: the older $10 one is skipped and the $5 one is paid (RS4 step 6).
5. The customer spends the balance on something else first: the reservation waits for the next credit or expires.
6. Cancel and A02 at the same moment: the order lock settles it; the loser sees the new status (`ORDER_NOT_CANCELLABLE` for the customer, a skip for the job).
7. Expiry and A02 at the same moment: the same; A02 also checks `expires_at > now()`.
8. The price fell while reserved: the lower current price is charged, with its row and minimum margin.
9. The price rose while reserved and the saved price is no longer profitable: cancelled `price_rose`, and the customer is notified by email.
10. A required field was added to the game while reserved: cancelled `product_changed` at pay.
11. The product is out of stock when the deposit arrives: the reservation stays and is paid by the sweep if it comes back within 24 hours, else it expires.
12. Purchases stopped when the deposit arrives: reservations wait (SW7); they may expire during a long stop.
13. A test customer: public pages show public availability; the purchase decides with test routes (S08 R4); validation uses `fake` only (PV2).
14. The quota is reached mid-day: validation answers `unavailable` (`quota`), customers confirm manually, and the admin is alerted once.
15. The supplier says "invalid" for a real account (supplier error): the customer confirms and buys. If the supplier then refuses the order, it refunds at once.
16. The fields change between the check and the purchase: the purchase reads the cache for the submitted fields, so the old result does not apply and `confirmPlayer` is needed unless those values were checked.
17. A code product: no validation; `player_check = none`.
18. The rate changes: SYP prices refresh with the tag; a reservation's SYP is recomputed at pay.
19. The revalidate call fails (store restarting): retried, then the 5-minute life refreshes the page.
20. `localStorage` blocked (private mode): search works without recent searches.
21. An old link to a game that is now paused or archived: the store's not-found page with a link home.
22. The SSE stream is down: the order page refetches on focus and on `resync`, and the customer can refresh.
23. Search for "pubg" with no search terms entered: the English name matches; "ببجي" matches only once the admin adds it as a term.

## Open questions
- Q12 (part): SHOP2TOPUP's real validation quota, its reset time and any fee. Until known, the panel default of 1,000 a day counted from Damascus midnight is used. Each adapter PR maps its "player not found" answer to `valid: false`. This does not block S09, which is built and accepted with the fake supplier.

## Acceptance
The owner's browser check (local, `pnpm dev`, `SUPPLIER_FAKE_ENABLED=true`, `TELEGRAM_TRANSPORT=log`). The data is S06–S08's: PUBG Mobile active with "60 UC" (`game_amount` 60), "325 UC" and "660 UC" routed to fake offers, an iTunes code product, and a second game paused. The customer is a non-test one with $5 from a manual deposit adjustment.
1. Open `/` at phone width: the PUBG card with "تعمل بشكل طبيعي", the paused game absent, and the service line. Open the game page: packs with USD, "≈" SYP, a savings badge where an official price is set, and delivery chips once S08's step 10 has run.
2. Type 1000 in "كم أحتاج؟": the cheapest combination with its totals; "اشترِ" opens the buy box on that pack.
3. Signed out, choose "60 UC", fill the player ID and press the action: sign in, then back to the same pack with the ID kept.
4. Type `51234567`: after a pause, "الاسم في اللعبة: …" appears. Type `invalid-1`: the warning and the required checkbox appear. Run `supplier:fake --errors on` and type another ID (then `--errors off`): "تعذّر التحقق…" and the checkbox.
5. Slide to pay "60 UC": the order page shows paid → قيد الشحن → تم التسليم live, without refreshing, and the success sequence plays.
6. Choose "660 UC" (above $5): "ينقصك …"; "احجز الطلب واشحن رصيدك", then slide. The order shows "بانتظار رصيدك" with its countdown. The wizard opens with the shortfall prefilled.
7. Create and approve a Sham Cash deposit in the panel: the reservation is paid and delivered on its own; "تم دفع طلبك المحجوز" appears in the center.
8. Reserve two more, then a fourth: refused with the limit text. Cancel one: "ملغى — ألغيته أنت".
9. Raise the fake cost so the saved price is unprofitable, then credit funds: the reservation is cancelled "تغيّر سعر الباقة", with an email.
10. Reserve, then wait (or shorten `expires_at` in the dev database): "انتهت مدة الحجز", with an email.
11. Set the fake's validation quota to 1 in the panel, then check two new IDs: the second shows "تعذّر التحقق…", and a Telegram message is logged.
12. Press `Ctrl+K`: type "ببجي" (after adding it as a search term in the panel), "pubg", "بوبجي", "فري فاير" (with Free Fire seeded), "60": the matching games and packs. Recent searches show on reopening.
13. Change a product's price in the panel (a route cost): the game page shows the new price within seconds.

Tests:
- Contracts (100% coverage): `normalizeSearchText` (every mapping), `searchCatalog` (exact, prefix, fuzzy distances by length, digits, a product matched through its game, ranking, limits), `cheapestPackCombination` (exact hit, overshoot, ties by count then overshoot, a single pack, target 1 and 100,000), `gameServiceStatus` and `storeServiceState` (each tier), `reservationCharge`, `orderTimeline` (each step, retries collapsed, `failed` hidden), `orderCustomerStage` for `awaiting_balance`, the new schemas.
- Database: the changed checks and trigger (price columns change only on `awaiting_balance → paid`), `player_checks` grants (no `UPDATE`), the limit of 3 under the wallet lock.
- Concurrency and idempotency: two credits at once paying one reservation; A02 against a customer cancel and against expiry; reserve and pay against a concurrent repricing and a concurrent stop; the same `Idempotency-Key` with `reserve` in parallel; skip-and-continue with a balance covering only the newer order.
- API, every route: public routes read no cookie and send `public` cache headers; player checks (cache hit, valid, invalid, unavailable by quota, by timeout, not supported, a test customer, the limits counting only supplier calls, 401, unverified); purchase with `reserve` and `confirmPlayer` (every PV8 branch); cancel (own, another customer's 404, wrong status); the stream's `order` event to the right customer only; admin quota and search terms; image widths.
- Worker: `orders.pay_waiting` (each RS4 step and outcome), the sweep's expiry and cache cleanup, `orders.waiting_sweep`, `store.revalidate` (singleton, failure), the quota Telegram message with its dedupe key, notifications.
- Store unit: request functions, the slider's threshold and keyboard path, recent searches with a throwing `localStorage`.
- E2E with RTL screenshots (phone and desktop, dark and light): home (with games and empty), the game page (packs, unavailable pack, calculator result), the buy box (signed out; valid name; invalid with checkbox; unavailable; short balance), the slide confirmation, a reserved order, a cancelled order, the live timeline moving from paid to delivered over a mocked stream, the search dialog (results, recent, no results). Admin: the game form with search terms, the supplier quota. Performance: the first-load budget of `/` holds; the game page gets its own budget, measured in PR 3 and recorded in `apps/store/CLAUDE.md`.

## Implementation notes
- Suggested split, each leaving `main` green:
  1. Contracts, db (the order columns and trigger change, `player_checks`, the quota and search terms, the index on `supplier_calls`), api:
     - the public `catalog` store routes and image widths;
     - `player-checks` in the `orders` module;
     - the purchase changes (reserve, `confirmPlayer`), cancel, and `payWaitingOrders` in `packages/db/src/orders`;
     - the A02 queueing at the three credit points; the `order` stream event; the admin additions;
     - `store.revalidate` queueing at the change points; `order:place` options; OpenAPI and the admin client.
  2. Worker: `orders.pay_waiting`, `orders.waiting_sweep`, the sweep steps, `store.revalidate`, Telegram and summary lines, notifications.
  3. Store: home, game page, buy box, validation UI, slide-to-pay, reservation UI, live timeline, search dialog, the deposit prefill, the `/_internal/revalidate` route, sitemap and robots. Admin: search terms, quota, order fields. E2E and screenshots; nginx (`/_internal/` denied, `vdplayercheck`).
- Module layering: the public catalog routes live in `catalog` and read prices and availability through `PricingService` and `SuppliersService` (as the admin product responses do); `orders` owns player checks and reservations and reads `catalog`, `pricing`, `suppliers`, `wallet`, `settings`.
- Update `docs/architecture.md` (catalog public routes, the store's cache and revalidation, `player_checks`, worker jobs), `.env.example` and `docs/deployment.md` (`PLAYER_CHECK_SECRET`, `STORE_REVALIDATE_SECRET`, the nginx `/_internal/` rule and zone), the commands table (`order:place --reserve --confirm-player`), `apps/store/CLAUDE.md` (the catalog cache pattern, the buy box, the budgets), and S05's stream events.

## Settled in implementation
PR 1 (contracts, db, api, 2026-10-09):
- Queue names follow the `<area>.<action>` convention with dashes: `orders.pay-waiting` and `orders.waiting-sweep`; `store.revalidate` is a `singleton` queue, sent with `singletonSeconds: 10`.
- LT2's `pg_notify('customer_orders', …)` is sent by a trigger on `orders` (`orders_notify`, migration 0035) on every insert and status change, so no writer (the API, the worker, a CLI) can forget it.
- SF4's change points in the API: an interceptor on the admin controllers whose data the store shows (catalog, catalog items, pricing, product prices, suppliers, routes, rates) queues `store.revalidate` right after a change succeeds, in a transaction of its own; a supplier pause from the panel or Telegram queues it in the switch change's transaction. The worker's change points (syncs, health, stale costs) come with PR 2. The API never reads `STORE_REVALIDATE_SECRET`: only the worker and the store do.
- PV1's capability is `supplierChecksPlayers(code)` in the contracts (only `fake` until Q12's adapters), shared by the player checks, the store's `playerCheck` flag and the panel's `canValidatePlayer`.
- PV8 is read by the API (`PlayerChecksService.lookup`, which holds the HMAC key) and handed to `purchaseOrder` as a callback, inside the purchase transaction; the purchase never calls a supplier.
- A reservation paid at its saved price stores the current rule's minimum margin (the one RS6 checked) as the order's guard.
- A player check's refused fields answer `VALIDATION_FAILED` with `details.fields`, as the purchase does. A paused or unknown product is `NOT_FOUND`; an out-of-stock one `PRODUCT_UNAVAILABLE`.
- The order response also carries `deliveryStats` (LT3's expected time) and "طلباتي" carries `expiresAt` (the reserved chip's countdown), so the store needs no other read. The supplier responses carry `canValidatePlayer`, `validationQuota` and `validationsToday`.
- `order.paid` gains an optional `priceSource` (`saved` or `current`) for a reservation paid by the system.
- The API reads the fake supplier's state file (`FAKE_SUPPLIER_STATE_FILE`, relative to `apps/worker`) so `supplier:fake --errors on` fails player checks too.
- `POST /api/orders/:id/cancel` answers `200` with the order.

