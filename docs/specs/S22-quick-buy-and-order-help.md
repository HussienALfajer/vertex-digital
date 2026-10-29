# S22 — Quick buy and order help (F40, F41, F42)

Status: Approved · Date: 2026-10-21 · Scope: `docs/product/v1-scope.md` §F40, §F41, §F42 (Phase M) · ADRs: 0003, 0004, 0007, 0011, 0015, 0020, 0023, 0024, 0026, 0029, 0035, 0037 (new)

## Summary
A returning customer still opens a game, picks a pack and chooses an ID for every top-up, finds out the balance is short only at the slide, and reports a problem with an order through a blank ticket form. S22 makes retail buying quicker and help clearer. **Quick buy** (F40) adds a "top up again" row on the home page that pays in a sheet on the page, **direct buy links** with a QR and simple counts for ads, WhatsApp and shop posters, **"top up the gap"** that reserves the order and opens the deposit form with the missing amount, a **"best value"** badge with the price per 100 units, **passkey sign-in** (fingerprint or face), and **commands in search** ("660 ببجي لأخي"). **Order problem buttons** (F41) open a ticket linked to the order with the problem named, after showing what the customer can check first. **Availability and price-drop alerts** (F42) notify once, in the center and by push, when a pack comes back or gets cheaper. No new money flow.

## Owner decisions (interview, 2026-10-21)
1. **Top up the gap:** one button, "احجز واشحن الفرق", reserves the order (S09 `awaiting_balance`) and opens the deposit form filled with the missing amount in USD and SYP, raised to the method's minimum. The gap counts the customer's older open reservations, which A02 pays first. When the deposit is credited, A02 pays the reservation.
2. **Price-drop alert:** sent once, when the pack's price falls below its price when the alert was set, then the alert ends. "Notify me when available" is also sent once. Checked every 15 minutes, after the supplier syncs.
3. **Order problem buttons:** the buttons depend on the order's state and kind. Before a ticket opens, each problem shows what the customer can check first ("your order is still within the usual time"), with "open a ticket anyway". They are offered while the order is in progress and for 7 days after it finished (the refund policy's report window); after that, the general support page stays.
4. **Passkeys:** customers only (the admin keeps password and TOTP, ADR 0016). Adding one needs the account password; each addition sends an email; at most 10 per account, listed, renamed and removed on the account page; a password reset deletes every passkey.
5. **Direct buy links:** a short permanent code per pack (`/q/K7M2QX`), a QR to download in the panel, an optional campaign tag (`?c=whatsapp`), and per link and campaign the opens and paid orders over 30 days.
6. **Top up again:** up to 6 saved IDs, newest used first, each with its last pack at today's price; a tap opens the slide confirmation on the home page. An unavailable pack, a rejected or an incomplete saved ID opens the game page instead. Each card can be hidden.
7. **Best value:** for available direct packs with an in-game amount, when a game has at least 3 of them: the price per 100 units on each pack, and the badge on the cheapest per unit only when it is at least 2% cheaper than the next (none on a tie). A switch per game in the panel turns it off.
8. **Search commands:** an amount, an optional game name and an optional saved-ID label (with or without "لـ"). One clear match is shown first as "اشحن 660 شدة لـ أخي" and opens the slide step (never a purchase without the slide); several matches are listed. Signed out: amount and game only.

Defaults chosen in the spec (flag in review if wrong): at most 30 active product alerts per customer, an unsent alert ends after 90 days; F42 is open to every account, at the account's own price list; alerts send no email (the scope names push and the center); quick-link open and order rows are kept 90 days; one counted open per address, code and hour; removing a passkey needs no password; a password change (not a reset) keeps passkeys.

## In scope / out of scope
- In:
  - F40: the "top up again" row and its home sheet; direct buy links (`/q/<code>`), the panel's link card, QR and counts; "top up the gap" in the buy box, the home sheet and the cart; the best-value badge and the per-game switch; passkey sign-in and management; search commands.
  - F41: problem buttons on the order page, the hint sheets, tickets carrying the problem; the problem in the admin queue, thread and Telegram notice.
  - F42: alerts per pack (available, price drop), "تنبيهاتي" in the account, the 15-minute job, two notification events; the count of waiting customers on the panel's product list.
- Out (later or never):
  - Gap top-up for the cart: the cart refuses a short balance today and has no reservation (S10); it shows the gap and a plain deposit link only (BB-G5).
  - Passkeys for the admin, passkey as a second factor, usernameless sign-up: not in V1.
  - Alerts by email, alerts on whole games, alerts with a target price: not in V1. Merchants keep their own follows (S21 F37) besides F42.
  - Buying from search without the slide step, buying from a link without signing in: never.
  - Automatic refunds or redeliveries from a problem button: never; the admin decides through the ticket (S08 rules unchanged).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the quick-buy row, hide or show a card | Customer | Verified customer (frozen: read only, the slide is disabled as everywhere, CF5) |
| Open a direct link | Public, rate limit | Anyone |
| Read quick-link counts, a product's link and QR | Admin | The admin |
| Turn best value on or off for a game | Admin | The admin (game form, as the other game fields) |
| Authorize, add, rename, remove a passkey | Customer | Verified customer, not archived; adding needs the password (PK2) |
| Sign in with a passkey | Public, rate limit | Anyone holding a registered passkey |
| Open a ticket with an order problem | Customer, `Idempotency-Key` | Verified customer, own order, S12 TK1 limits |
| Set, list, cancel product alerts | Customer | Verified customer, not archived (frozen allowed: freezing blocks deposits and purchases only) |
| Check alerts, send notifications | Worker job | System |

Another customer's saved ID, alert or order answers `NOT_FOUND`.

## Data
Money is USD units (micro-dollars, ADR 0003); every price here is a whole-cent unit price from a price row (ADR 0020).

### Contracts (`quick-buy.ts`, `product-alerts.ts` new; `catalog.ts`, `orders.ts`, `wallet.ts`, `support.ts`, `notifications.ts`, `audit.ts`, `errors.ts`, `jobs.ts` extended)
- Constants: `QUICK_BUY_CARDS = 6`, `QUICK_CODE_LENGTH = 6` (order-number alphabet `[2-9A-HJKMNP-Z]`), `QUICK_CAMPAIGN_PATTERN = ^[a-z0-9_-]{1,32}$`, `QUICK_LINK_RETENTION_DAYS = 90`, `QUICK_LINK_STATS_DAYS = 30`, `BEST_VALUE_MIN_PACKS = 3`, `BEST_VALUE_MIN_LEAD_BPS = 200`, `PASSKEYS_MAX = 10`, `PASSKEY_GRANT_SECONDS = 300`, `PRODUCT_ALERTS_MAX = 30`, `PRODUCT_ALERT_DAYS = 90`, `ORDER_PROBLEM_WINDOW_DAYS = 7`.
- Pure functions, 100% coverage:
  - `depositGap({ totalUsdUnits, balanceUsdUnits, reservedUsdUnits })`: `max(0, total + reserved − balance)`, rounded up to whole cents (BG1).
  - `gapDepositAmount(gapUsdUnits, method, { minUnits, perDepositMaxUnits, remainingUnits, rate })`: the USD amount `max(gap, minimum)` and, for SYP, the pounds `ceil(usd × rate)` rounded up to the display step, checked so `floorToWholeCents(sypToUsd(syp, rate, 'down')) ≥ usd`; with the cap reached (per deposit or remaining today) the capped amount and `short: true` (BG3).
  - `bestValue(packs)`: per pack `perHundredUsdUnits` (`ceil(price × 100 / gameAmount)` to whole cents, display only) and the best pack's id or null (BV1–BV3), compared by cross-multiplying integers, never by the rounded figures.
  - `parseSearchCommand(query, index, savedPlayers)` (SC1–SC5).
  - `orderProblemsFor(order, now, slowAfterSeconds)`: the offered problems and each one's hint (OP2–OP4); `orderProblemAllowed(order, problem, now)` for the server.
  - `alertDue(alert, current)`: `available` or `price_dropped` or `rebase` or nothing (PA3–PA5).
- Schemas: `quickBuySchema` (`items[]`: `savedPlayer`, `game { slug, nameAr, cover }`, `product { id, nameAr, kind, gameAmount }`, `quantity`, `unitPriceUsdUnits`, `priceKind`, `state`: `ready` | `unavailable` | `rejected` | `incomplete`), `quickLinkResolveSchema`, `quickLinkStatsSchema`, `productAlertSchema`, `createProductAlertSchema` (`productId`, `kind`), `passkeySchema` (`id`, `name`, `createdAt`, `lastUsedAt`, `deviceType`, `backedUp`), `orderProblemSchema`.
- `createOrderSchema` gains `quickLink?: { code, campaign? }`. `createTicketSchema` gains `orderProblem?` (only with `category: order`). `walletSummarySchema` gains `reservedUsdUnits` (Σ `total_usd_units` of the customer's `awaiting_balance` orders). `savedPlayerSchema` gains `quickBuyHidden`. The admin game schema gains `bestValueEnabled`; the admin product row gains `quickCode` and `waitingAlerts`.
- Error codes, each with its Arabic text: `ORDER_PROBLEM_UNAVAILABLE` (409, `details.reason`: `state`, `window_closed`, `kind`), `PRODUCT_ALERTS_LIMIT_REACHED` (409, `details.limit`), `PRODUCT_ALERT_INVALID` (409, `details.reason`: `available` for an availability alert on an available pack, `unavailable` for a price-drop alert on a pack without a price, `hidden` for a paused game or archived pack), `PASSKEYS_LIMIT_REACHED` (409), `QUICK_LINK_NOT_FOUND` (404). Existing: `REAUTHENTICATION_REQUIRED`, `INVALID_EMAIL_OR_PASSWORD`, `RATE_LIMITED`, `NOT_FOUND`, `VALIDATION_FAILED`, the S12 ticket codes.
- Notification events: `product_available`, `product_price_dropped` (center and push, no email: S21's push-only precedent; params: game name and slug, pack name and id, and for a drop the old and new unit price; the push text names the pack, never an amount, S15). Security email template `customer_passkey_added` (always sent, no preference switch, as S01's security emails).
- Audit actions: `customer.passkey_added`, `customer.passkey_removed`, `customer.passkeys_cleared` (count; on a password reset), `catalog_game.updated` gains `bestValueEnabled` in its before and after.
- Queue: `catalog.product-alerts` (singleton).

### `catalog_products` (extended; owner `catalog`)
- `quick_code` text, not null after the backfill, unique, `^[2-9A-HJKMNP-Z]{6}$`: generated at creation (retry on a collision), backfilled for every existing product by the migration. It never changes, archived products keep it.

### `catalog_games` (extended)
- `best_value_enabled` boolean not null default true.

### `quick_link_events` (new; owner `catalog`; append-only, a marketing log)
- `id` uuid v7; `product_id` FK; `campaign` text nullable (`QUICK_CAMPAIGN_PATTERN`); `kind` enum `quick_link_event` (`open`, `order`); `order_id` uuid nullable FK `orders`, unique; check `kind = 'order'` ⇔ `order_id` set; `created_at`.
- Index `(product_id, created_at)`. `append_only_guard`; rows older than 90 days are deleted by `orders.sweep` (a counting log, not a business record; listed with that reason beside S21's alert events).
- Open counting uses the existing PostgreSQL rate counters (S01) keyed by address, code and hour; the address itself is never stored here.

### `saved_players` (extended; owner `orders`)
- `quick_buy_hidden` boolean not null default false.
- Index `orders (customer_id, game_id, paid_at)` for QB2's last-pack read, unless an existing index already serves it.

### `support_tickets` (extended; owner `support`)
- `order_problem` enum `order_problem` nullable: `not_arrived`, `wrong_player_id`, `wrong_amount`, `code_not_working`, `code_used`, `wrong_region`, `refund_missing`, `other`. Check: `order_problem is null or category = 'order'`. Set at opening only, never changed.

### `customer_passkeys` (new; owner `auth`; Better Auth passkey plugin's table)
- `id`; `customer_id` FK (the plugin's user id); `name` text 1–40 (printable, no bidi controls); `public_key` text; `credential_id` text unique; `counter` bigint; `device_type` text; `backed_up` boolean; `transports` text nullable; `aaguid` text nullable; `created_at`; `last_used_at` nullable.
- Credentials, not business records: removal and the reset delete the row (listed with that reason); the audit entry keeps the passkey id and name.
- The 5-minute registration grant per session (PK2) is a row of the customer auth verification table (`identifier` `passkey-grant:<session id>`), deleted when used or expired; no new table.

### `product_alerts` (new; owner `catalog`; customer preference data, not a business record)
- `id` uuid v7; `customer_id` FK; `product_id` FK; `kind` enum `product_alert_kind` (`available`, `price_drop`); `baseline_price_usd_units` bigint nullable (required for `price_drop`: the unit price the customer saw, whole cents); `price_list_id` FK nullable (the effective list of the baseline, S20); `status` enum `product_alert_status` (`active`, `sent`, `cancelled`, `expired`); `expires_at`; `sent_at`, `ended_at` nullable; `created_at`, `updated_at`.
- Partial unique `(customer_id, product_id, kind)` where `status = 'active'`; index `(status, product_id)`.
- Ended rows older than 90 days are deleted by `orders.sweep`.

## States and rules

### Top up again (F40)
- QB1. **Who:** a signed-in, verified customer with at least one saved ID (S10) not hidden from quick buy. Merchants too, at their own list (S20).
- QB2. **Cards** (`GET /api/quick-buy`): the customer's saved IDs, newest `last_used_at` first, at most 6, skipping hidden ones and those of paused or archived games. Each card's pack and quantity are those of the customer's latest paid order (not `awaiting_balance`, not `cancelled`) of that game whose `fields` equal the saved row's; a saved ID with no such order is skipped. The price is today's unit price on the customer's effective list.
- QB3. **State:** `ready` (pack available, saved ID neither rejected nor incomplete), `unavailable` (pack not available, S09 SF1), `rejected` (S10 SP6), `incomplete` (S10 SP7). Only `ready` cards open the home sheet; the others open `/games/<slug>?pack=<id>&player=<savedId>` where the buy box applies SP6, SP7 or the unavailable state (and offers F42).
- QB4. **Home sheet:** the game cover, the label, the main value large and the last checked name (SP3), the pack, quantity, total in USD and "≈" SYP, and slide-to-pay. The slide sends `POST /api/orders` with `confirmPlayer: true` (SP3), the saved fields, the quantity and `expectedUnitPriceUsdUnits`; a changed price answers `PRICE_CHANGED` and the sheet shows the new price to slide again. Success opens the order page (S09). A short balance shows the gap (BG2) instead of the slide.
- QB5. **Hide:** "إخفاء" on a card sets `quick_buy_hidden` (no confirmation, an undo toast). "معرّفاتي" shows a switch "إظهار في اشحن مجدداً" per saved ID.
- QB6. The row is never in the cached home page: it loads in the browser after the session is known, in a slot reserved by the signed-in hint (no layout shift), with `next/dynamic`, and is absent signed out or with no cards.

### Direct buy links (F40)
- DL1. **The link:** `https://digital.vertexmedia.pro/q/<quick_code>`, optionally `?c=<campaign>` (QUICK_CAMPAIGN_PATTERN; anything else is dropped silently).
- DL2. **Opening** (`/q/[code]`, a store route read per request with the visitor's `X-Forwarded-For`): the API resolves the code. An active product of an active game redirects (`307`) to `/games/<slug>?pack=<id>&via=q` and counts one `open` (at most one per address, code and hour; the redirect never waits on the count). An archived product redirects to its game page; a paused or archived game, or an unknown code, redirects to `/` with no count. The campaign travels to the store in session storage, never in the visible URL after the redirect.
- DL3. **On the game page:** the buy box opens on the pack. Signed in, it preselects the customer's newest-used saved ID of the game that is neither rejected nor incomplete, so the next step is the slide (SP3); none: the fields. Signed out: the S09 sign-in prompt, and the draft (pack, campaign) survives the sign-in (`draft.ts`). An unavailable pack opens the folded list (SF1) with "نبّهني عند التوفر" (F42).
- DL4. **Attribution:** an order of that pack paid from the same tab within 24 hours of the open carries `quickLink { code, campaign }`. The server checks the code is the order's product's (otherwise ignores it) and writes one `order` row in the purchase transaction (`order_id` unique: a replayed key writes nothing new). A reservation writes its row when it is created; the counts include an `order` row only once its order is paid (`paid_at` set), so a reservation counts when A02 pays it and never when it is cancelled. Checkouts and the cart carry none.
- DL5. **Panel:** the product editor and the product list show the link with "نسخ", a QR (PNG and SVG download, the store's QR library from S21), and a campaign field that builds the tagged link. The QR (owner, 2026-10-30) is error correction H, green-950 on white, with the game's cover in its middle: cropped square with rounded corners at 20% of the QR's width, inside a white ring, the modules under both excavated; a game without a cover keeps the plain QR. The cover is read from the panel's own image route (`/api/catalog/images/*`) and embedded as a `data:` URL, so the SVG download is self-contained and the PNG (1024 px, drawn from the same SVG) is never tainted. "تنزيل بطاقة الطباعة" downloads a print card (PNG, A6 at 300 dpi, 1240×1748; no SVG, whose text would depend on the viewer's fonts): the Vertex Digital logo, the pack and game names, the QR, "امسح واشترِ مباشرة", the price (`formatUsd`) only when "اطبع السعر على البطاقة" is ticked (off by default: the link is permanent and prices change; disabled without a price) and the link, in the panel's fonts and tokens. The E2E decodes every download (PNG, SVG drawn alone, card) with a QR decoder over busy covers and expects the exact link, campaign included. `/catalog/quick-links`: per product and campaign over the last 30 days, opens, paid orders and their total (net of refunds), sortable, with a date range within 90 days.

### Top up the gap (F40)
- BG1. **The gap:** `depositGap(total, balance, reserved)`, where `reserved` is the sum of the customer's open reservations (A02 pays oldest first, so they come before this one). Shown as "ينقصك $1.37 (≈ 20,000 ل.س)" (SYP at the current rate rounded up to the display step; hidden without a rate).
- BG2. **Where:** in the buy box (S09 BB) and the home sheet (QB4), in place of the slide when the balance is short. The primary button is "احجز واشحن الفرق": it places the reservation exactly as S09 RS1–RS4 (same checks, `confirmPlayer`, the 3-reservation limit, the price saved) and then opens `/wallet/deposit?gap=<usd units>&order=<order number>`. The gap sent is recomputed from the reservation's answer (the server's balance and reservations at that moment). Secondary: "اشحن فقط" opens the deposit form with the gap and no reservation.
- BG3. **Deposit form:** with `?gap=`, it opens on the method choice with a strip "المبلغ اللازم لطلبك VO-…: $1.37"; after a method is chosen, the amount field holds `gapDepositAmount` for that method (Sham Cash USD and USDT: USD; Sham Cash SYP: pounds), raised to the method's minimum with the line "الحد الأدنى للإيداع بهذه الطريقة $5". When the per-deposit maximum or what remains today is below the gap, the field holds that cap and the strip says the rest needs another deposit. The customer can change the amount; nothing is enforced against the gap.
- BG4. **After the deposit:** credited, A02 pays the reservation (unchanged); the deposit page's credited view links the order. Expired or rejected, the reservation follows S09 (expires after 24 hours, A15).
- BG5. **At the reservation limit** (3 open), or for a cart, only "اشحن فقط" is offered, with the gap; the cart's gap counts the cart's total and the open reservations.

### Best value (F40)
- BV1. Considered packs: available, `direct`, `game_amount > 1`, of a game with `best_value_enabled`. Fewer than 3: nothing is shown.
- BV2. Each considered pack shows "$0.98 لكل 100" (muted, under the price; whole cents rounded up). The best pack is the lowest price per unit; it gets the badge "أفضل قيمة" only when its price per unit is at least 2% below the next best (`best × 10000 ≤ next × 9800` per unit, cross-multiplied); otherwise no badge.
- BV3. It uses the prices the viewer sees: the cached page computes it from retail prices on the server; a private list (S20 AT4) recomputes it in the browser when its prices replace the cached ones. The calculator and the savings badge (PR7) are unchanged; the best-value badge sits beside the savings badge, after it.

### Passkeys (F40; ADR 0037)
- PK1. **Plugin:** Better Auth's passkey plugin on the customer auth instance only, relying party id the store's host, origin `STORE_URL`, user verification required, resident keys preferred. Its routes join the customer auth allowlist; the admin instance never gets it.
- PK2. **Adding** (account page "الدخول بالبصمة"): "أضف بصمة" asks the account password (`POST /api/account/passkeys/authorize`, the C11 current-password limit of 10 per 15 minutes), which grants this session 5 minutes to register; the plugin's registration routes refuse without a live grant (`REAUTHENTICATION_REQUIRED`). At 10 passkeys, `PASSKEYS_LIMIT_REACHED`. The name defaults to the browser and system ("iPhone · Safari"). In one transaction: the row, the audit entry, `customer_passkey_added` (time, name, browser, address) queued, the grant deleted.
- PK3. **Signing in:** "الدخول بالبصمة" on the sign-in page, and the browser's passkey autofill on the email field where supported. Success creates a session through the same hooks as a password sign-in: archived accounts get none (C15), the sign-in log (S12) and `customer_new_sign_in` (C10). No ALTCHA (the assertion is the proof); the sign-in rate limit per address (C8) applies; failed assertions do not count toward an email's ALTCHA threshold. A signature counter that goes backwards refuses the sign-in and alerts the admin (A13).
- PK4. **Managing:** the account page lists passkeys (name, added, last used, synced or not); rename (PK name rules); remove with a confirmation (no password; audited).
- PK5. **Reset:** a password reset by OTP (C7) deletes every passkey of the customer in the reset's transaction, with `customer.passkeys_cleared`. A password change (C11) and an email change (C12) keep them. Frozen customers sign in normally (freezing blocks money only).
- PK6. The admin's customer profile (S12, devices tab) shows the passkeys (name, added, last used), read only.

### Search commands (F40)
- SC1. **Parsing** (in the browser, `parseSearchCommand`): Arabic-Indic digits become Latin; one number token (1–1,000,000, separators allowed) is the amount; a saved-ID label is matched when the query contains it, with or without a leading "لـ"، "ل"، "الى"، "إلى" (normalized like S09 search: alef forms, taa marbuta, case, spaces; the longest label wins); the remaining words go to the existing game search.
- SC2. **Candidates:** packs with `game_amount` equal to the amount, else whose name contains it, of games matching the remaining words (all games when none), restricted to the games of the matched label's saved IDs when there is a label.
- SC3. **One match** (one pack, and one saved ID when a label was typed): a first result "اشحن 660 شدة لـ أخي" (or "اشحن 660 شدة" without a label) that opens `/games/<slug>?pack=<id>&player=<savedId>`, so the buy box is on the slide step (SP3, with SP6 and SP7 applying). **Several:** up to 5 command results with the game named, above the normal results. **None:** the normal results only.
- SC4. Signed in, the dialog reads the saved IDs (`GET /api/saved-players`, at most 50) once per open; signed out, labels are not parsed. Nothing is bought from the dialog; nothing new is sent to the server.
- SC5. A label alone ("لأخي") gives "اشحن لـ أخي · <game>" opening the game with that saved ID chosen.

### Order problem buttons (F41)
- OP1. **Where:** the order page (S08/S09), a card "مشكلة في الطلب؟" with the offered problems as buttons. An order with an open ticket shows "لديك تذكرة مفتوحة لهذا الطلب" linking it instead (TK1's one open ticket per order).
- OP2. **Offered problems** (`orderProblemsFor`):
  - `paid`, `sent_to_supplier`, `needs_review`: "تأخر الطلب" (`not_arrived`), "المعرّف خاطئ" (`wrong_player_id`), "مشكلة أخرى" (`other`).
  - `delivered` direct: "لم يصل الشحن" (`not_arrived`), "وصلت كمية أقل أو مختلفة" (`wrong_amount`), "المعرّف خاطئ" (`wrong_player_id`), `other`.
  - `delivered` code: "الكود لا يعمل" (`code_not_working`), "الكود مستخدم مسبقاً" (`code_used`), "الكود لا يناسب منطقة حسابي" (`wrong_region`), `other`.
  - `partially_refunded`: those of `delivered` for its kind, plus "لم أجد المبلغ المسترد" (`refund_missing`).
  - `refunded`, `failed`: `refund_missing`, `other`.
  - `awaiting_balance`, `cancelled`: none (no money taken; the general support link stays).
- OP3. **Window:** in-progress orders always; finished orders (`finished_at` set) while `now < finished_at + 7 days`. Later the card shows "مضى أكثر من 7 أيام على الطلب" with a link to `/support/new?order=` (a plain S12 order ticket, no problem). The server enforces OP2 and OP3 (`ORDER_PROBLEM_UNAVAILABLE`).
- OP4. **Hints before the ticket** (a sheet; "افتح تذكرة على أي حال" always present):
  - `not_arrived` in progress, while `now − paid_at < slowAfterSeconds(product p90)` (S11): "طلبك ضمن الوقت المعتاد: عادة خلال <n> دقائق. سنخبرك فور وصوله." with "حسناً، سأنتظر" as the primary button.
  - `not_arrived` delivered: "قد يتأخر ظهور الرصيد داخل اللعبة بضع دقائق؛ أعد تشغيل اللعبة وتحقق من المعرّف ••••1234".
  - `wrong_player_id` in progress: "لا يمكن تغيير المعرّف بعد إرسال الطلب. إذا رفض المورّد المعرّف يعود المبلغ إلى محفظتك تلقائياً."; delivered: "تم الشحن إلى المعرّف المكتوب في الطلب: ••••1234".
  - `code_not_working`, `code_used`, `wrong_region`: the pack's region and redemption steps when set (S06), and "أرفق صورة لرسالة الخطأ" (the image picker opens with the form).
  - `refund_missing`: "أُعيد $1.37 إلى محفظتك في <time>" with a link to the wallet entry.
  - `wrong_amount`, `other`: no hint, straight to the form.
- OP5. **The form** (in the sheet): the problem as a chip, an optional details field (0–2,000), up to 3 images (S12 TK11). Sent as an S12 ticket (`POST /api/support/tickets`): `category: order`, the order, `orderProblem`, subject "<problem label> · <order number>", body the problem's sentence followed by the details. S12 TK1 applies (limits, `TICKET_ALREADY_OPEN`, Telegram, audit `ticket.opened` with the problem). The ticket page opens after sending.
- OP6. **Admin:** the queue shows the problem chip and filters by it; the thread's side panel shows it above the linked order summary (which already shows state, fields, attempts and code reveals); the Telegram `ticket_opened` text adds the problem label (TK8's content rules unchanged).

### Availability and price-drop alerts (F42)
- PA1. **Setting:** on an unavailable pack (game page folded list, the buy box's unavailable state, a direct link), "نبّهني عند التوفر" sets an `available` alert. On an available pack with a price, the buy box's bell "نبّهني عند انخفاض السعر" sets a `price_drop` alert with the unit price the customer sees as the baseline and their effective list. Signed out: the button leads to sign-in and back. A second press on an active alert offers "إلغاء التنبيه". `PRODUCT_ALERT_INVALID` when the state no longer fits (the page refreshes the pack); `PRODUCT_ALERTS_LIMIT_REACHED` at 30 active.
- PA2. After setting, the page suggests turning on push when this device has none (the S15 permission card's rules); without push the alert still reaches the center.
- PA3. **Job** (`catalog.product-alerts`, every 15 minutes at minute 7, singleton): for active alerts grouped by product and effective list, reads the pack's current availability (S09 SF1) and unit price on that list. `available`: the pack is available. `price_drop`: the pack is available and its unit price on the alert's list is strictly below the baseline.
- PA4. **Sending:** per due alert, in one transaction with the alert `FOR UPDATE SKIP LOCKED` and still `active`: `status = 'sent'`, `sent_at`, and the notification (`product_available` or `product_price_dropped`, dedupe key `product-alert:<id>`) through the outbox (center, push by preference). Running twice sends nothing new.
- PA5. **List change:** when the customer's effective list differs from the alert's `price_list_id` (S20 assignment, S21 level), the job rebases the alert to the current price on the new list without sending.
- PA6. **Ending without sending:** `expires_at` passed → `expired`; the product archived or the customer archived → `cancelled`; the customer cancels → `cancelled`. None notifies. A paused game keeps its alerts until they expire.
- PA7. **"تنبيهاتي"** (`/account/alerts`, linked from the account menu and the notification center): active alerts with the pack, kind, baseline price and expiry, and "إلغاء"; the last 20 ended ones.
- PA8. **Panel:** the product list and editor show "بانتظار التوفر: N" (active `available` alerts), to help the admin prioritise routes.

## Money flows
None new. A quick-buy, link or command purchase is S08 M1 (`POST /api/orders`); "احجز واشحن الفرق" is an S09 reservation (no money) followed by an S03 or S04 deposit and A02's payment, each with its existing journal and idempotency key. Problem tickets, alerts, passkeys, links and the badge move no money; refunds or compensation after a ticket are the admin's existing actions (S08, S02).

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/quick-buy` | Customer | — | `quickBuySchema` | — |
| `PATCH /api/saved-players/:id` (S10, extended) | Customer | `{ label?, quickBuyHidden? }` | `savedPlayerSchema` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `GET /api/q/:code` | Public, per-address limit | `?c=` | `quickLinkResolveSchema` (`target`: `pack` \| `game` \| `home`, `gameSlug?`, `productId?`) | `QUICK_LINK_NOT_FOUND`, `RATE_LIMITED` |
| `POST /api/orders` (extended) | Customer, `Idempotency-Key` | `+ quickLink?` | as before | as before |
| `GET /api/wallet` (extended) | Customer | — | `+ reservedUsdUnits` | — |
| `POST /api/account/passkeys/authorize` | Customer | `{ password }` | `204` | `INVALID_EMAIL_OR_PASSWORD`, `RATE_LIMITED` |
| Passkey plugin routes (`/api/auth/passkey/*`: registration options and verification, authentication options and verification, list, update, delete) | Customer (registration: live grant) · Public (authentication) | the plugin's | the plugin's | `REAUTHENTICATION_REQUIRED`, `PASSKEYS_LIMIT_REACHED`, `RATE_LIMITED`, `VALIDATION_FAILED` |
| `POST /api/support/tickets` (S12, extended) | Customer, `Idempotency-Key` | `+ orderProblem?` | as before | `+ ORDER_PROBLEM_UNAVAILABLE` |
| `GET /api/product-alerts` | Customer | `?gameId=` \| `?status=active\|ended` | `{ items: productAlertSchema[] }` | — |
| `POST /api/product-alerts` | Customer | `createProductAlertSchema` | `201` `productAlertSchema` (an existing active alert of the same kind answers `200` with it) | `PRODUCT_ALERT_INVALID`, `PRODUCT_ALERTS_LIMIT_REACHED`, `NOT_FOUND`, `RATE_LIMITED` |
| `DELETE /api/product-alerts/:id` | Customer | — | `204` | `NOT_FOUND` |
| `GET /api/admin/quick-links` | Admin | `from`, `to` (≤ 90 days), `productId?` | `quickLinkStatsSchema` | `VALIDATION_FAILED` |
| `GET /api/admin/support/tickets` (S12, extended) | Admin | `+ problem?` | rows `+ orderProblem` | as before |
| Admin game and product routes (S06, extended) | Admin | game `+ bestValueEnabled` | product `+ quickCode`, `waitingAlerts` | as before |

The public catalog routes (S09) add `perHundredUsdUnits` and `bestValue` per game's packs (retail); the private prices route (S20 AT4) the same on the account's list. Product alert creation: 30 per hour per customer. The OpenAPI document and the admin client are regenerated.

## Jobs and integrations
- `catalog.product-alerts` (every 15 minutes at :07, singleton): PA3–PA6; batches of 500 alerts; each alert in its own short transaction; safe to run twice (status check under the row lock, notification dedupe key).
- `orders.sweep` (S08) gains: delete `quick_link_events` and ended `product_alerts` older than 90 days.
- Email template `customer_passkey_added`; push per S15 for `product_available` and `product_price_dropped`.
- No supplier, blockchain or Telegram integration is new; Telegram `ticket_opened` gains the problem label.

## Screens

### Store (phone width first)
- **Home:** "اشحن مجدداً" row under the banners for signed-in customers with cards (QB2): horizontal scroll-snap cards with the game cover, the label, the masked ID, the pack and today's price; a ready card opens the **quick-buy sheet** (QB4) with the slide, or the gap (BG2); "إخفاء" in each card's menu. Loading: a skeleton in the reserved slot; error: the row disappears quietly (the rest of the home page is unaffected).
- **Game page:** per-100 price and "أفضل قيمة" (BV2); the unavailable list's "نبّهني عند التوفر" (PA1).
- **Buy box:** the gap block (BG1, BG2) replacing the slide when short; the bell for price drops (PA1); the preselected saved ID from a link (DL3).
- **Deposit form:** the gap strip and filled amount (BG3).
- **Cart:** a short balance shows the gap and "اشحن الفرق" (BG5).
- **Search dialog:** command results first (SC3), styled as actions with the game cover.
- **Order page:** "مشكلة في الطلب؟" card (OP1–OP3), the hint sheet and form (OP4, OP5).
- **Account:** "الدخول بالبصمة" section (PK2, PK4) with "أضف بصمة" (hidden when the browser has no WebAuthn), the password dialog, the list; "تنبيهاتي" (PA7) with an empty state "لا تنبيهات. اضغط «نبّهني» على أي باقة."; "معرّفاتي" gains the quick-buy switch (QB5).
- **Sign-in:** "الدخول بالبصمة" under the password form, and autofill.
- Budgets: the home row, the sheet, the passkey code and the problem sheet load with `next/dynamic` only when used; the home and game page budgets hold or a raise is recorded with its reason.

### Admin
- **Product list and editor:** the quick link card (copy, QR, campaign builder) and "بانتظار التوفر: N".
- **Game form:** "شارة أفضل قيمة" switch.
- **`/catalog/quick-links`:** the counts table (DL5), empty state "لا فتحات بعد".
- **Support queue and thread:** the problem chip, filter and side-panel line (OP6).
- **Customer profile, devices tab:** passkeys (PK6); the summary counts gain active product alerts.

## Audit and notifications
- Audit: `customer.passkey_added`, `customer.passkey_removed` (customer actor), `customer.passkeys_cleared` (system, in the reset), `catalog_game.updated` with `bestValueEnabled`, `ticket.opened` details gain `orderProblem`. Hiding a card, alerts and link opens are not audited (preferences and counting logs).
- Customer: `product_available`, `product_price_dropped` (center, push; preference switches on by default); `customer_passkey_added` (security email, always).
- Admin: Telegram `ticket_opened` with the problem (TK8). A passkey counter regression raises the A13 alert.

## Abuse and fraud
| Abuse | Control |
|---|---|
| Inflating link opens | One counted open per address, code and hour (PostgreSQL counters); the per-address rate limit on `/api/q`; counts are marketing figures, never money |
| Open redirect through `/q` | The code resolves to an internal path only; the campaign is pattern-checked and never echoed in a redirect |
| Forged attribution | The server ignores a `quickLink` whose code is not the order's product; one row per order (unique `order_id`) |
| A stolen session adding an attacker's passkey | The password is required (PK2), an email goes to the owner on every addition, and a password reset deletes every passkey (PK5) |
| Phishing or replayed passkey assertions | WebAuthn binds to the store's origin; the plugin's challenge is single use; a counter regression refuses and alerts (PK3) |
| Password-guessing through the authorize route | C11's current-password limit (10 per 15 minutes per customer) and the per-address limit |
| One-tap purchases by accident (home sheet, search command, link) | Every purchase still needs the slide, `expectedUnitPriceUsdUnits` refuses a changed price, an `Idempotency-Key` per body |
| Problem buttons as a refund lever | Buttons only open tickets; refunds and make-goods stay the admin's decisions (S08, S02); S12 ticket limits; one open ticket per order |
| Alert flooding | 30 active alerts, 30 creations an hour, each sent once, dedupe keys |
| Reading another account's private price through alerts | An alert's baseline and notification carry the customer's own list price only; the public routes stay retail (S20) |
| Labels injecting script in command results | Labels render as text only (ADR 0015), as in S10 |

## Edge cases
1. The gap is below the method's minimum ($0.40 short with USDT): the form holds $5 with the minimum line (BG3).
2. The gap exceeds the per-deposit maximum or what remains today: the field holds the cap and the strip says another deposit is needed; the reservation waits up to 24 hours (S09).
3. The price falls between reserving and the deposit: A02 pays the lower price (S09 RS6); the gap was an upper bound.
4. The price rises between the deposit form and the credit beyond the margin rule: S09 RS6 cancels the reservation with `price_rose`; the deposit stays in the wallet.
5. "احجز واشحن الفرق" with 3 open reservations: only "اشحن فقط" is offered (BG5).
6. A quick-buy card whose last order's pack is now archived: the card is `unavailable` and opens the game page.
7. Two saved IDs whose last orders are the same pack: two cards (one per ID).
8. A direct link opened by a frozen customer: the game page opens; the buy box is disabled with the frozen banner (CF5).
9. A direct link to a pack priced on a merchant's list: the buy box shows the private price after it loads (S20 AT4); the link itself carries no price.
10. A best-value game where a private list makes another pack the cheapest per unit: the browser recomputes the badge (BV3).
11. Two packs with the same amount in a search command ("660" as a normal and an offer pack): both listed (several matches).
12. A label shared by saved IDs in two games and no game word: one command result per game.
13. A problem button pressed while the order turns delivered: the server checks the problem against the current state; a refused problem answers `ORDER_PROBLEM_UNAVAILABLE` and the card refreshes.
14. An order whose 7-day window ends while the form is open: refused with `window_closed`; the plain support link is offered.
15. An availability alert set and the pack becoming available within the same 15 minutes: sent at the next run.
16. A price-drop alert whose pack drops then rises before the run: no notification (the run compares the current price).
17. A pack available but its game paused at run time: not available (SF1); the alert stays.
18. A customer archived with active alerts: cancelled by the next run, no notification.
19. A password reset while a passkey registration is in progress: the grant belongs to the old session, which the reset signs out; the registration fails.
20. A passkey used on an archived account: no session (C15); the store shows the generic sign-in error.
21. A browser without WebAuthn: the passkey buttons are hidden; password sign-in unchanged.
22. A test customer: everything applies; their orders stay on test routes (S08), and link attributions from test customers are excluded from the counts.

## Implementation notes (PR 1)
Details the spec left open, settled while building PR 1:
- The deposit form's `?gap=` is whole cents as digits, as S09's `?amount=` was (which it replaces everywhere: buy box, home sheet, cart, reservation page, merchant bulk list); a reservation adds `order=<order id>` (the way back) and `number=<order number>` (the strip). Sham Cash opens on its first available currency; SYP holds the pounds of the gap rounded up to the display step, which the wallet answer now carries (`syp.displayStepSypUnits`).
- `/q/<code>` is a store route handler: `307` with a relative location, and the code and campaign in a 5-minute `vd-quick-link` cookie on `/games` that the game page moves into this tab's session storage; the URL after the redirect carries `?pack=<id>&via=q` only. A sign-in keeps `via=q` in its way back.
- Product codes are drawn by `catalog_quick_code()` (migration 0090): a sequence through an affine permutation modulo 31^6, so the backfill and later inserts never collide; the guard of migration 0092 keeps a code unchanged.
- The admin product row carries `quickLinkUrl` (from `STORE_URL`) beside `quickCode`, since the panel does not know the store's address.
- A saved ID with its pack in the URL (`?pack=&player=`, a search command, a quick-buy card that is not ready) opens the slide step when the ID is ready (SP3); "معرّفاتي"'s "اشحن" (no pack) keeps S10's behaviour.
- The quick-buy, gap, deposit strip and search-command strings live in `apps/store/src/features/quick-buy/messages.ar.json`; the home, content pages and cart budgets were raised by 2 KB (`e2e/store.spec.ts` gives the reason).

## Implementation notes (PR 2)
Details the spec left open, settled while building PR 2:
- PK1: Better Auth's passkey plugin (1.7.7) verifies with `requireUserVerification: false`, cannot tell a counter that went backwards from any other failure, writes the row outside our transaction and asks for a session made in the last day. The ceremonies are therefore the auth module's own Better Auth plugin (`apps/api/src/modules/auth/passkeys.plugin.ts`) on SimpleWebAuthn, the library that plugin is built on, with the same challenge mechanics (a random token in a signed cookie names a verification row, used once, for its own ceremony, 5 minutes): `POST /api/auth/passkey/register-options` and `/passkey/register` (session), `POST /api/auth/passkey/sign-in-options` and `/sign-in/passkey` (public, 30 and 10 a minute per address). User verification is required at both ceremonies.
- List, rename and remove are Nest routes (`GET`, `PATCH /:id`, `DELETE /:id` under `/api/account/passkeys`), like every other account change; a wrong password at `authorize` answers `INVALID_PASSWORD`, as C11 does.
- The name at registration is always the default one from the device (`defaultPasskeyName`: system and browser, a part the device does not name left out, "بصمة" when neither), so the security email never carries text someone typed; renaming is not audited and sends no email.
- PK3's counter: the signature is verified first (a forged assertion never raises the alert), then one guarded update takes a counter above the stored one, or zero over zero (synced passkeys keep 0); anything else refuses with the generic sign-in error and reports to Sentry (A13).
- The WebAuthn relying party is the host of `STORE_URL`. Browsers refuse an IP address there, so a local test of passkeys opens the store at `http://localhost:3001` with `STORE_URL` set to it; the E2E specs open `localhost` for the same reason.
- A reset with no passkey writes no `customer.passkeys_cleared` entry. The store's passkey strings live in `apps/store/src/features/passkeys/messages.ar.json` (`tp()`), loaded with the card and the sign-in button through `next/dynamic`.

## Implementation notes (PR 3)
Details the spec left open, settled while building PR 3:
- `product_alerts.price_list_id` is not null: every alert has the customer's effective list when it is set. The job rebases an alert of either kind whenever that list changed (PA5) and checks it at the next run; a price-drop alert keeps its old baseline when the pack has no price on the new list.
- PA4's "dedupe key" is the alert's own row: each alert is settled in its own transaction, locked `FOR UPDATE SKIP LOCKED` and still `active`, and marked `sent` with its notification, so a second run (or a parallel one) sends nothing (`notifyCustomer` has no dedupe key). The notification's params carry the alert id.
- A paused game or an archived pack is `hidden` for PA1 (`productAlertRefusal`); a paused pack takes an availability alert. A hidden pack is never due: a paused game keeps its alerts until they expire (PA6).
- The store composes OP5's subject ("<label> · <order number>", 120 characters at most) and body (the problem's sentence, then the details); the server checks the problem against the order as it is (`orderProblemAllowed`), stores it on the ticket (fixed by migration 0095's guard), and adds it to `ticket.opened` and the Telegram notice. The customer's order view gains `help` (status, paid and finished times, the open ticket) for the card.
- The order help strings live in `apps/store/src/features/order-help/messages.ar.json` and the alert strings in `apps/store/src/features/product-alerts/messages.ar.json`, both loaded with their parts through `next/dynamic`. The store's E2E mock answers a key with its query string before the bare path (the alerts page's active and ended lists).
- The admin profile's counts gain `activeAlerts` (the spec's devices-tab summary).
- OP2 lists `failed` with `refunded`, but `failed` is not a final state here (ADR 0004: it goes back to a supplier or on to a refund, the customer sees "processing"): a `failed` order offers the in-progress problems, and `refund_missing` stays for `refunded` and `partially_refunded`. The refund hint (OP4) shows only once an amount came back and the order finished; otherwise the problem goes straight to the form.
- An alert rebased while the new list has no price keeps the old list's baseline; if the new list later prices the pack below it, the notice compares the two (both the customer's own prices).

## Open questions
None. The defaults listed under the owner decisions are the spec's choices and may be changed at review.

## Acceptance
- The owner's browser check (local, `pnpm dev`, `SUPPLIER_FAKE_ENABLED=true`, `TELEGRAM_TRANSPORT=log`, the seeded catalog and customers):
  1. As a customer with two saved IDs and past orders, the home page shows two cards; tap one, slide: an order is placed and delivered; hide the other: it is gone and comes back from "معرّفاتي".
  2. In the panel, copy a pack's link with `?c=whatsapp`; open it signed out in a private window: sign in, the buy box opens on the slide with the saved ID; pay: `/catalog/quick-links` shows one open and one order for that campaign.
  3. With $1 in the wallet, choose a $3.50 pack: "ينقصك $2.50 (≈ … ل.س)"; press "احجز واشحن الفرق": the order is reserved and the deposit form opens; choose USDT: $5 (the minimum) is filled; send it with `usdt:fake-transfer`: the deposit is credited and the reservation paid and delivered.
  4. PUBG Mobile shows the per-100 price on its packs and "أفضل قيمة" on one; turn the game's switch off: both disappear after revalidation.
  5. On the account page add a passkey (Chrome's virtual authenticator in DevTools): the password is asked, the email log shows the notice; sign out and sign in with it: a session and a new sign-in email; reset the password: the passkey list is empty.
  6. In search type "660 ببجي لأخي": one command result opens the slide step with the pack and the ID.
  7. Place an order scripted `slow:300`; press "تأخر الطلب" within a minute: the "within the usual time" hint; open a ticket anyway: the ticket shows the problem, the Telegram log names it, the panel's queue filters it.
  8. Pause a pack's route (`supplier:fake --stock <offer> off` and a sync) and set "نبّهني عند التوفر"; set a price-drop alert on another pack; turn the stock on and lower the cost (`--cost`); run the job: two notifications in the center (and push when enabled); both alerts are in "تنبيهاتي" as sent.
- Tests:
  - contracts unit: `depositGap`, `gapDepositAmount` (minimums, caps, SYP rounding never crediting less than the gap), `bestValue` (fewer than 3, ties, the 2% lead, integer comparison), `parseSearchCommand` (digits, labels with and without "لـ", longest label, game words, signed out), `orderProblemsFor` and `orderProblemAllowed` (every state and kind, the window, the slow threshold), `alertDue` (drop, equal, rise, unavailable, rebase).
  - db: the migration backfill (a unique quick code for every product), the guards (append-only link events, the ticket problem check), the partial unique alert index, the attribution row's uniqueness on a replay.
  - API: every endpoint's success, 401, 403 across customer and admin, other customers' saved IDs, alerts and orders (`NOT_FOUND`); the quick-buy read (skips, states, private prices); `/api/q` counting once per address and hour and the redirect targets; the passkey grant (missing, expired, used), the 10 limit, the reset clearing passkeys, an archived account refused; the ticket problem refusals; the alert job twice, the rebase on a list change, expiry and cancellation.
  - E2E and RTL screenshots (phone and desktop, dark and light): the home row and sheet, the gap block in the buy box and on the deposit form, best value on the game page, the passkey section and sign-in button (virtual authenticator), search command results, the order problem card, a hint sheet and the form, "تنبيهاتي", the alert buttons; admin: the product's link card, quick-links table, the queue's problem chip and filter.
- PRs (one session each, `/feature-slice S22`):
  - PR 1 **Quick buy** (F40 without passkeys): the quick-buy row and sheet, direct links with counts and the panel, the gap in the buy box, sheet, cart and deposit form, best value, search commands.
  - PR 2 **Passkeys** (F40): the plugin, grant, management, sign-in, the reset rule, the email and the profile view.
  - PR 3 **Order help and alerts** (F41, F42): problem buttons, hints and the ticket problem in the store, panel and Telegram; product alerts, the job, the notifications, "تنبيهاتي" and the waiting count.
