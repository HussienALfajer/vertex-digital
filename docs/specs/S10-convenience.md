# S10 — Convenience (F14, F16)

Status: Draft · Date: 2026-10-09 · Scope: `docs/product/v1-scope.md` §F14, §F16 (with §F13's buy box, §F12's calculator, §F27) · ADRs: 0003, 0004, 0011, 0015, 0019, 0022, 0023, 0024

## Summary
S09 sells one pack at a time, and a returning customer types the same player ID every time. S10 makes repeat buying fast and social. A customer **saves player IDs** per game with a label from the buy box ("حسابي", "أخي"), with the validated in-game name, and buys for one again in one step (**one-tap recharge**, still slide-to-pay, at today's price). The same one step **repeats a delivered order**. A **cart** on the device holds up to 10 packs for one or more player IDs and pays them **all or nothing in one wallet debit**, with one wallet entry. Each line is its own order, and one summary email arrives when every line has finished. A **gift top-up** is a direct top-up for someone else's ID with a sender name and a short message, shared as a public gift page and image. Any paid order can have a **shareable receipt**: a public, non-guessable link and image that shows only what the customer chose, never a code. The customer or the admin can revoke a link (owner, 2026-10-09).

## In scope / out of scope
- In:
  - **F14 saved player IDs:** saved from the buy box ("احفظ هذا المعرّف" with a label) when paying or reserving, at most 10 per game and 50 per account. The validated name is stored and refreshed. "معرّفاتي" (`/account/players`) lists them, renames and deletes them, and opens the game with one preselected.
  - **One-tap recharge:** saved-ID chips in the buy box fill the fields and go straight to the slide step. "اشترِ مجدداً" on a delivered order goes to the slide step with the same pack, quantity and fields. A saved ID or a delivered order's ID counts as confirmed by the customer (owner, 2026-10-09).
  - **F16 cart:** on the device (`localStorage`), signed out too, cleared at sign-out. At most 10 lines. "أضف إلى السلة" in the buy box, and "أضف الكل إلى السلة" in S09's calculator. `/cart` with live prices, then one slide pays every line, or the whole cart is refused with a reason per line. No reservations for a cart: the customer deposits first (owner, 2026-10-09).
  - **Checkout:** one transaction, one `purchase` journal, one wallet entry "شراء سلة: N طلبات". Each line is its own paid order in S08's write path. Refunds stay per order.
  - **Gift top-up:** direct products only. A sender name and a message, text only, with no links, handles or phone numbers. The gift page `/g/<token>` and its image show the sender, the message, the game and pack, the masked ID and the delivery state, with no price and no buyer data (owner, 2026-10-09).
  - **Shareable receipt:** `/r/<token>` and its image show the order number, game, pack, quantity, state and time. Two choices: the price (on by default) and the player ID (masked by default, or full). No expiry; revocable (owner, 2026-10-09).
  - **Notifications:** a checkout's orders notify in the center one by one. One `checkout_finished` email arrives when all have finished (owner, 2026-10-09).
  - **Admin:** the order page shows the checkout, the gift texts and the share links, and can revoke a link with a reason (audited).
- Out (later or never):
  - A cart synced across devices, saved on the server: not in V1 (owner, 2026-10-09).
  - Reserving a cart, or paying only the lines the balance covers: not in V1 (owner, 2026-10-09). Single-pack reservations stay as in S09.
  - Gifting code products from the store: never through a public page, since codes never leave the order page (ADR 0004). The buyer reveals the code and sends it themselves (owner, 2026-10-09).
  - Adding a saved ID by hand in "معرّفاتي" (with no purchase): not in V1. IDs are saved from the buy box (owner, 2026-10-09).
  - Scheduled or recurring top-ups: not in V1.
  - Gift delivery to the recipient by email, SMS or WhatsApp from the store: not in V1. The buyer shares the link or image.
  - The admin's view of a customer's saved IDs: S12 (F19), if needed.
  - Coupons: out of V1 (scope §6).

## Access
| Action | Route kind | Who |
|---|---|---|
| List, rename, delete own saved IDs | Customer | Signed-in customer with a verified email |
| Save an ID (inside a purchase, a reservation or a checkout) | Customer, `Idempotency-Key` (S08 O1) | The same |
| Pay a cart (checkout) | Customer, `Idempotency-Key`, the S08 purchase rate limit (counts as one) | The same |
| Create a receipt link, change its choices, make a new gift link, revoke an own link | Customer, 20 per hour | The same, for their own paid orders |
| Read a gift or receipt page and its image | Public, rate limited per IP | Anyone with the link |
| Read an order's checkout, gift and links; revoke a link | Admin; revocation with a reason | The admin |
| Send the checkout summary when its last order finishes | The order write path (api and worker) | System |

The cart itself lives in the browser and needs no access. Its checkout is decided by the server like any purchase.

## Data
Money is USD units (micro-dollars, ADR 0003). SYP is display only, as in S08 and S09.

### Contracts
- `orders.ts`:
  - `SAVED_PLAYERS_PER_GAME = 10`, `SAVED_PLAYERS_MAX = 50`, `CART_LINES_MAX = 10`;
  - `savedPlayerLabelSchema`: 1–30 characters, trimmed, printable, no bidi controls;
  - `savedPlayerSchema`: `{ id, gameId, gameSlug, gameNameAr, cover, label, fields, fieldLabels, playerName, rejected, complete, lastUsedAt }`. `complete` is false when the game's unarchived fields no longer validate the saved values (rule SP7);
  - `giftSchema`: `{ senderName?: 0–30, message?: 0–140 }`, both through `giftTextAllowed` (rule GF3);
  - `createOrderSchema` gains `savePlayer?: { label }` and `gift?: giftSchema`;
  - `checkoutLineSchema` is `createOrderSchema` without `whenBalanceShort`. `checkoutRequestSchema` is `{ lines: 1–CART_LINES_MAX }`. `checkoutSchema` is `{ id, totalUsdUnits, totalSypUnits, orders: orderSummarySchema[] }`;
  - `RECEIPT_PLAYER_DISPLAYS` (`masked`, `full`); `receiptOptionsSchema`: `{ showPrice: boolean (true), playerDisplay ('masked') }`;
  - `SHARE_KINDS` (`gift`, `receipt`); `shareTokenSchema` (22 base64url characters); `shareLinkSchema`: `{ id, kind, url, showPrice, playerDisplay, createdAt }`;
  - `publicShareSchema`: `{ kind, orderNumber (receipt only), game { nameAr, nameEn, cover, accentColor }, product { nameAr, kind, gameAmount }, quantity, stage (SH4), finishedAt, paidAt, price? { totalUsdUnits, refundedUsdUnits }, fields: [{ label, value }], gift? { senderName, message } }`;
  - `orderSummarySchema` and `orderSchema` gain `checkoutId`, `isGift`, `repeatable` (rule OT3). `orderSchema` also gains `gift` and `shareLinks`.
- Pure functions (100% coverage):
  - `giftTextAllowed(text)` (GF3);
  - `maskFieldValue(value)` (SH3);
  - `canonicalFields(fields)` (the trimmed values in key order, as PV3 hashes them);
  - `shareStage(status, deliveredQuantity, quantity)` (SH4);
  - `cartLineKey(line)` (CT2);
  - `checkoutTotal(lines)` (the sum of `orderTotal`).
- `notifications.ts`: event `checkout_finished` (center and email, can be turned off; params `{ checkoutId, orderCount, delivered, partiallyRefunded, refunded, refundedUsdUnits }`), email template `customer_checkout_finished`.
- `wallet.ts`: the `purchase` entry extras (S02 W5) gain `checkout?: { id, orderCount, orders: [{ id, number, productNameAr }] }`. The single `order` stays for a one-order purchase.
- Error codes: `CHECKOUT_REFUSED` (`409`; `details.lines: [{ index, code, details }]`, where `code` is one of `PRODUCT_UNAVAILABLE`, `PRICE_CHANGED`, `VALIDATION_FAILED`, `PLAYER_NOT_CONFIRMED`) and `ORDER_NOT_SHAREABLE` (`409`; `details.reason`: `status`, `not_gift`, `link_exists`). Existing: `INSUFFICIENT_BALANCE`, `PURCHASES_STOPPED`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMITED`, `NOT_FOUND`, `VALIDATION_FAILED` (`details.gift`, `details.label`). Each has its Arabic text.
- `audit.ts`: `order.share_revoked` (admin: `{ linkId, kind, reason }`). `order.paid` gains `checkoutId?` and `gift?: boolean`.

### `checkouts` (new; owner `orders`; business table, never deleted)
- `id` UUIDv7; `customer_id` FK; `is_test` boolean (the customer's flag); `idempotency_key` uuid, `request_hash` text (SHA-256 of the canonical body); unique `(customer_id, idempotency_key)`.
- `line_count` int 1–10; `total_usd_units` bigint > 0 (whole cents); `total_syp_units` bigint nullable, `display_rate_id` nullable (display only); `purchase_journal_id` FK unique not null.
- `finished_at` timestamptz nullable: set once, when the last order reaches a terminal state (rule CK7).
- A trigger refuses `DELETE` and any `UPDATE` but `finished_at` from null to a time. The app role has `SELECT`, `INSERT`, `UPDATE`.
- Index `(customer_id, created_at desc)`.

### `orders` (changed)
- `checkout_id` uuid FK nullable and `checkout_line` int 1–10 nullable, both set or both null; unique `(checkout_id, checkout_line)`.
- `purchase_journal_id`: the unique constraint becomes a partial unique index `where checkout_id is null`. On insert, the guard trigger checks that a checkout order's journal is its checkout's journal.
- A check: `checkout_id is null or reserved_at is null` (a cart line is never a reservation).
- `is_gift` boolean not null default false; `gift_sender_name` text nullable ≤ 30; `gift_message` text nullable ≤ 140. Checks: gift texts only when `is_gift`; `is_gift` only when `kind = 'direct'`. These are identity columns: the guard trigger refuses changing them.
- Index `(checkout_id) where checkout_id is not null`.

### `saved_players` (new; owner `orders`; customer data, not a business record)
- `id`; `customer_id` FK; `game_id` FK; `label` text 1–30; `fields` jsonb (`{ key: value }`, as `orders.fields`, at most 10 entries); `fields_hash` text (`^[0-9a-f]{64}$`: SHA-256 of the game id and `canonicalFields`); `player_name` text nullable ≤ 64 (printable, from a `valid` order); `name_checked_at` nullable; `rejected_at` nullable (rule SP6); `last_used_at` nullable; `created_at`, `updated_at`.
- Unique `(customer_id, game_id, fields_hash)`; index `(customer_id, game_id, last_used_at desc)`.
- The app role has `SELECT`, `INSERT`, `UPDATE`, `DELETE`. A customer deletes their own rows for real. Orders keep their own copy of the fields, and nothing references this table.

### `order_share_links` (new; owner `orders`; business table, never deleted)
- `id`; `order_id` FK; `kind` enum `share_kind`; `token` text unique (22 base64url characters from 16 CSPRNG bytes); `show_price` boolean (receipt; false for a gift); `player_display` enum (`masked`, `full`; always `masked` for a gift); `revoked_at` nullable, `revoked_by` enum (`customer`, `admin`) nullable, `revoke_reason` text nullable 5–500 (admin only); `created_at`, `updated_at`.
- Partial unique `(order_id, kind) where revoked_at is null`: one live link of each kind per order.
- A trigger refuses `DELETE`, any change to `order_id`, `kind` or `token`, and any change once revoked. The app role has `SELECT`, `INSERT`, `UPDATE`.

## States and rules

### Saved player IDs (F14)
- SP1. **Saving:** the buy box shows "احفظ هذا المعرّف" with a label field (default "حسابي") for a `direct` product whose game has input fields, when the customer is under both limits for that game. Ticked, the purchase, reservation or checkout line carries `savePlayer: { label }`. The server saves it in the same transaction: it inserts `(customer, game, fields_hash)`, or, when it exists, sets `last_used_at` and keeps the old label. At a limit (10 for the game or 50 in all, counted in the transaction), saving is skipped and the purchase goes on; the order response's `savedPlayer` is `null`. The store hides the box at a limit.
- SP2. **Name:** when the order stores `player_check = valid` with a name (S09 PV8), the saved row takes that name and `name_checked_at`. A later `valid` order with the same fields refreshes them. A row is never given a name from anything but a `valid` order.
- SP3. **Using:** the buy box lists the customer's saved IDs for the game as chips (label, the masked main value, and the name), newest used first. Choosing one fills the fields and opens the slide step at once (one tap). The store sends `confirmPlayer: true`, since the customer confirmed the ID when saving it (owner, 2026-10-09). The server still applies PV8: a `valid` cached check stores `valid`; otherwise `unchecked_confirmed` or `invalid_confirmed`. The slide step shows the label, the values large and the stored name ("آخر اسم تحققنا منه: <name>").
- SP4. **Last used:** every order whose fields hash matches a saved row of the same customer and game sets that row's `last_used_at`, in the purchase transaction.
- SP5. **Managing** (`/account/players`): grouped by game, newest used first. Rename (SP label rules) and delete (with a confirmation dialog). "اشحن" opens `/games/<slug>?player=<id>`, and the buy box opens with the ID chosen when a pack is picked.
- SP6. **Rejected:** when an order is refunded with `input_rejected` (S08 F1), the matching saved rows of that customer get `rejected_at`. A rejected chip shows a warning, "رفض المورد هذا المعرّف في طلب سابق". It does not skip to the slide step, and the customer goes through S09's normal check and confirmation. A later delivered order with the same fields clears `rejected_at`.
- SP7. **Game fields changed:** a saved row whose fields no longer validate against the game's unarchived fields (a required field added, a format tightened) is `complete: false`. Its chip fills what still applies and leaves the buy box on the fields with the errors shown. Saving again replaces nothing: it is a new row (a new hash).

### One-tap repeat (F14)
- OT1. "اشترِ مجدداً" shows on an own order in `delivered` or `partially_refunded` whose product is shown on the store (SF1). It opens `/games/<slug>?pack=<product>&repeat=<order id>`. The buy box reads the order (`GET /api/orders/:id`), fills its fields and quantity, and opens the slide step at today's price. The store sends `confirmPlayer: true`, since that ID already received a delivery.
- OT2. When the product is unavailable, the quantity is above today's `max_quantity`, or the fields no longer validate, the buy box opens on the pack with what still applies and the reason shown. When the order was a gift, the repeat does not copy the gift: the customer ticks it again.
- OT3. `repeatable` in the order responses is true under OT1's status rule and when the product's game is shown. Availability is checked when the buy box opens.

### Cart (F16; owner 2026-10-09)
- CT1. **Storage:** one cart per browser in `localStorage` (`vd-cart`, versioned), wrapped in try/catch. Each line holds `productId`, `gameSlug`, `quantity`, `fields`, `expectedUnitPriceUsdUnits` (the price when added), `confirmPlayer`, the player check shown, `savePlayer?` and `gift?`. Signed-out visitors can fill it. Signing out clears it, so player IDs do not stay on a shared device. Without `localStorage` (private mode), the cart is off: "أضف إلى السلة" is hidden and the buy box works as in S09.
- CT2. **Adding:** "أضف إلى السلة" in the buy box needs the same field checks as paying (BB2 and the PV7 confirmation when the ID is not `valid`), but not the balance. A line with the same `cartLineKey` (product, canonical fields, no gift) adds its quantity to the existing line, up to `max_quantity`. A gift line is always its own line. Over 10 lines: "السلة ممتلئة (10 بنود)". A toast offers "عرض السلة".
- CT3. **Calculator:** S09's result gains "أضف الكل إلى السلة". It asks for the fields once in the buy box (with the check), then adds each pack × count as lines with those fields. A count above `max_quantity` becomes several lines. When the result would exceed 10 lines, nothing is added and the customer is told.
- CT4. **The cart page** (`/cart`) reads today's prices and availability from S09's search index (`GET /api/catalog/search-index`, already public and cached). A line whose price changed shows the old price struck through and the new one, and it is updated to it. An unavailable line shows "غير متوفرة حالياً" and must be removed before paying. It also shows the totals in USD and "≈" SYP, and the balance after (read in the browser, BB4). When the balance is short: "رصيدك $X، ينقصك $Y" with "اشحن رصيدك" (BB8's prefill). There is no reserve action (owner, 2026-10-09). Signed out: "سجّل الدخول للدفع", and the cart stays.
- CT5. **Checkout** (`POST /api/checkouts`, `Idempotency-Key`; one key per body, reused on a retry as in S09's buy box). One READ COMMITTED transaction:
  1. take the switches lock shared and refuse `PURCHASES_STOPPED` when purchases are stopped;
  2. lock every line's product `FOR SHARE`, **in product id order** (no deadlock with repricing or another checkout);
  3. check each line as S08 O3–O5 and S09 PV8 would (availability for this customer, `expectedUnitPriceUsdUnits`, quantity, fields, player confirmation), plus the gift rules (GF1–GF3). Collect every line's refusal. If any line is refused, refuse the whole checkout with `CHECKOUT_REFUSED` and each line's code and details, and nothing is written;
  4. insert the `checkouts` row, then one order per line (`paid`, `checkout_id`, `checkout_line`, its own number, its price row, minimum margin and SYP display, `player_check`, gift columns);
  5. post **one** purchase journal for the sum (rule M1 below). It locks the wallet and refuses `INSUFFICIENT_BALANCE` (`details.balanceUnits`, `details.totalUnits`), which rolls everything back;
  6. for each order, write the `paid` event, the audit entry `order.paid` (with `checkoutId`), the saved ID (SP1, SP4), the gift link (GF4) and `orders.fulfil`.
- CT6. **After paying:** the store clears the cart and goes to `/orders?checkout=<id>`, which shows the checkout's orders, live (S09 LT2). On `CHECKOUT_REFUSED` the cart page marks each refused line with its reason (`PRICE_CHANGED`: the new price is applied and the customer slides again; `PRODUCT_UNAVAILABLE`: remove it; `VALIDATION_FAILED`: "عدّل البيانات" opens the line in the buy box; `PLAYER_NOT_CONFIRMED`: the confirmation box on that line). On `INSUFFICIENT_BALANCE`: the shortfall of CT4.
- CT7. **Finishing:** whenever an order of a checkout reaches a terminal state, the same transaction locks its `checkouts` row `FOR UPDATE`. When no order of the checkout is still open and `finished_at` is null, it sets `finished_at` and notifies `checkout_finished` once. The lock serializes two orders finishing together, so exactly one of them sends it. This lives in `transitionOrder`'s terminal path in `packages/db/src/orders`, so the api and the worker both run it.
- CT8. **Notifications per order:** a checkout's orders write their S08 center notifications (`order_delivered`, `order_partially_refunded`, `order_refunded`, `order_delayed`) with **no email**. The one email is `checkout_finished`: "اكتملت سلتك: سُلّم 3، سُلّم جزئياً 1، استُرد 1 ($2.50 أُعيدت إلى رصيدك)", linking to `/orders?checkout=<id>`. Its email can be turned off like any other (NT8) (owner, 2026-10-09).
- CT9. **Limits:** a checkout counts **once** in S08's purchase rate limit (10 per 10 minutes per customer, 30 per IP), since it is one request. Each line is limited by its product's `max_quantity`. There is no amount cap beyond the balance (S08 O1).
- CT10. A checkout with one line is still a checkout (one journal, one summary email). The buy box's own "متابعة" stays the single-order path of S08 and S09.

### Gift top-up (F16; owner 2026-10-09)
- GF1. The buy box shows "هذا الشحن هدية" for a `direct` product. Ticked, it shows "اسمك كما يظهر للمُهدى إليه" (optional, at most 30) and "رسالة" (optional, at most 140, with a live counter). The request carries `gift`. A gift on a `code` product is `VALIDATION_FAILED` (`details.gift`).
- GF2. A gift can be paid at once, reserved (S09 RS1) or be a cart line. A reservation's gift link is created when it is paid. A cancelled reservation never has one.
- GF3. **`giftTextAllowed`:** after NFKC and Arabic-Indic digits mapped to Latin (SR1's digit step), the text is refused when it holds:
  - a control character, a bidi control (U+202A–U+202E, U+2066–U+2069) or a zero-width character other than ZWNJ and ZWJ;
  - `://` or `www.`;
  - a token with a dot followed by two or more Latin letters (a domain);
  - `@` followed by three or more letters, digits or underscores (a handle);
  - seven or more digits in a row, allowing spaces, dots and dashes between them (a phone number).
  - The Arabic text says what to remove: "لا يمكن أن تحتوي الرسالة على روابط أو أرقام هواتف أو معرّفات حسابات".
- GF4. **Link:** a paid gift order gets its gift link in the payment transaction (the immediate purchase, the reservation's RS4 step 7, or the checkout). The order page shows it with "نسخ الرابط", "مشاركة" (the Web Share API, falling back to copy), "تنزيل الصورة", and "إلغاء الرابط". After a revocation, "رابط جديد" makes a new token with the same texts.
- GF5. **The gift page** (`/g/<token>`, public, `noindex`): "هدية لك 🎁"; the sender name ("من <name>", or no line without one); the message as plain text; the game cover and accent; the pack and quantity; the player ID masked (SH3); the state (SH4). No price, no order number, no buyer email, phone or name, and no in-game name (owner, 2026-10-09: sender, message and state). Below: "اشحن لعبتك من VERTEX DIGITAL" linking home.

### Shareable receipt (F16; owner 2026-10-09)
- RC1. "مشاركة الإيصال" on an own order in `paid`, `sent_to_supplier`, `failed`, `needs_review`, `delivered`, `partially_refunded` or `refunded`. Never for `awaiting_balance` or `cancelled` (`ORDER_NOT_SHAREABLE`, `status`). A sheet shows the two choices, "إظهار السعر" (on) and "المعرّف: مُقنّع / كامل" (masked), with a live preview. "إنشاء الرابط" creates the receipt link. Changing a choice later updates the live link (`PUT`, same token), and the page and image follow within their cache life.
- RC2. **The receipt page** (`/r/<token>`, public, `noindex`): VERTEX DIGITAL's mark; "إيصال طلب"; the order number; the game and pack, the quantity; the state (SH4) with its time; the paid time; with `showPrice`, the total paid in USD (and the refunded amount when there is one; no SYP, since the rate moves); the game's input fields with their labels (SH3 masked, or in full); "تحقق من هذا الإيصال على digital.vertexmedia.pro/r/…". Never a code, the email, the phone, the customer's name or the in-game name.
- RC3. A receipt link has no expiry. "إلغاء الرابط" revokes it, and the page then answers not found. "رابط جديد" makes a new token. Revoking cannot be undone.

### Share pages and images (gift and receipt)
- SH1. `GET /api/shares/:token` (public, no cookie) answers the `publicShareSchema` of a live link, and `NOT_FOUND` for an unknown or revoked one. `Cache-Control: public, max-age=30`, so a revocation takes effect within 30 seconds.
- SH2. **Images:** `GET /api/shares/:token/image?format=og|square` renders a PNG (1200 × 630 for link previews, 1080 × 1080 to download or post) from the same data. The API renders it with `sharp` from an SVG template: the brand's dark surface, the game accent as a band, the cover, and Arabic text in the store's font. It carries no data the page does not show. `Cache-Control: public, max-age=300`. Nothing is stored. The store pages set `og:image` to the `og` format.
- SH3. **`maskFieldValue`:** a value of 6 characters or more shows "••••" and its last 4 characters; a shorter one shows "••••" only. `select` fields (server, region) show their option label in full. Values are shown LTR inside the Arabic text.
- SH4. **`shareStage`:** "قيد الشحن" (`paid`, `sent_to_supplier`, `failed`, `needs_review`), "تم الشحن" (`delivered`), "تم شحن <d> من <q>" (`partially_refunded`), "تعذّر الشحن" (`refunded`). With the time of the last change.
- SH5. Rate limits: 60 page or image reads per minute per IP in the API, and the nginx zone `vdshare` on `/api/shares/` and `/g/`, `/r/`. `robots.txt` disallows `/g/`, `/r/` and `/cart`. Both pages send `noindex` and `Referrer-Policy: no-referrer`.
- SH6. The store renders `/g/[token]` and `/r/[token]` on the server per request (no `'use cache'`: they must follow a revocation), reading the API route through `API_INTERNAL_URL`.

### Admin
- AD1. Order page: "ضمن سلة" with the checkout's order count, total, and links to its other orders; the gift's sender name and message; the share links (kind, created, state, and who revoked them and why). "إلغاء الرابط" asks for a reason (5–500) and writes `order.share_revoked`. It needs no re-authentication: it only removes exposure.
- AD2. Orders list: a "هدية" badge, and a "سلة" badge with the checkout's short id. `q` also finds the orders of a checkout by its id.

## Money flows
- **M1. Checkout:** journal `purchase`, key `checkout:<id>:purchase`; `customer_wallet:<customer>` **−total**, `sales_revenue:USD` **+total**, where total = the sum of the lines' `orderTotal`. One posting pair, so one wallet entry (owner, 2026-10-09). It locks the wallet and refuses `INSUFFICIENT_BALANCE`. Every order of the checkout points to this journal. Posted once (the journal key, and `(customer_id, idempotency_key)` on `checkouts`).
- **Refunds of a checkout order:** S08 M3, unchanged and per order: key `order:<id>:refund` or `order:<id>:refund:<attempt>`, `customer_wallet` **+unit × units**, `refunds:USD` **−the same**. An order's refund never exceeds its own total (S08's checks), so the refunds of a checkout never exceed its journal.
- **Cost of goods:** S08 M2 per attempt, unchanged.
- **Single purchase, reservation, one-tap and repeat:** S08 M1 and S09 RS4, unchanged. Saving an ID, a gift and a share link move no money.
- **Reconciliation (S13):** for each checkout, the journal's amount equals the sum of its orders' `total_usd_units`. A database test enforces it, and S13 checks it nightly.

## API
Customer responses `Cache-Control: no-store`. Public share responses as SH1 and SH2, with no cookie read or set.

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/saved-players` | Customer | `gameId?` | `{ items: savedPlayerSchema[] }` (at most 50, no paging) | `VALIDATION_FAILED` |
| `PATCH /api/saved-players/:id` | Customer | `{ label }` | `savedPlayerSchema` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `DELETE /api/saved-players/:id` | Customer | — | `204` | `NOT_FOUND` |
| `POST /api/orders` (S08, S09, extended) | Customer, `Idempotency-Key` | `+ savePlayer?`, `gift?` | `orderSchema` `+ savedPlayer` (or `null`) | as before, `VALIDATION_FAILED` (`details.gift`, `details.label`) |
| `POST /api/checkouts` | Customer, `Idempotency-Key`, S08 purchase limit (counts once) | `checkoutRequestSchema` | `201` `checkoutSchema` (`200` on a replay) | `CHECKOUT_REFUSED`, `INSUFFICIENT_BALANCE`, `PURCHASES_STOPPED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `EMAIL_NOT_VERIFIED` |
| `GET /api/orders` (extended) | Customer | `checkout?` | adds `checkoutId`, `isGift`, `repeatable`; with `checkout`, that checkout's orders in line order plus `{ checkout: { id, totalUsdUnits, orderCount, finishedAt } }` | `VALIDATION_FAILED`, `NOT_FOUND` (another customer's checkout) |
| `GET /api/orders/:id` (extended) | Customer | — | adds `checkoutId`, `gift`, `shareLinks`, `repeatable` | — |
| `PUT /api/orders/:id/receipt-link` | Customer, 20 / hour | `receiptOptionsSchema` | `shareLinkSchema` (created, or the live one updated) | `ORDER_NOT_SHAREABLE`, `RATE_LIMITED`, `NOT_FOUND` |
| `POST /api/orders/:id/gift-link` | Customer, 20 / hour | — | `shareLinkSchema` | `ORDER_NOT_SHAREABLE` (`not_gift`, `status`, `link_exists`), `RATE_LIMITED`, `NOT_FOUND` |
| `POST /api/orders/:id/share-links/:linkId/revoke` | Customer | — | `204` | `NOT_FOUND` |
| `GET /api/shares/:token` | Public, 60 / min / IP | — | `publicShareSchema` | `NOT_FOUND`, `RATE_LIMITED` |
| `GET /api/shares/:token/image` | Public, 60 / min / IP | `format=og\|square` | `image/png` | `NOT_FOUND`, `VALIDATION_FAILED`, `RATE_LIMITED` |
| `GET /api/wallet/entries` · `GET /api/admin/wallets/:customerId/entries` (S02, extended) | — | — | a checkout's `purchase` entry carries `checkout` (W5) | — |
| `GET /api/admin/orders/:id` · `GET /api/admin/orders` (extended) | Admin | `q` also matches a checkout id | adds `checkout`, `gift`, `shareLinks` with their revocation | — |
| `POST /api/admin/orders/:id/share-links/:linkId/revoke` | Admin | `{ reason }` | `adminOrderSchema` | `VALIDATION_FAILED`, `NOT_FOUND` |

Statuses: `409` for `CHECKOUT_REFUSED` and `ORDER_NOT_SHAREABLE`. A revoked link's revoke answers `204` again (idempotent).

## Jobs and integrations
- No new queue. The checkout queues one `orders.fulfil` per order in its transaction (S08 R1). `checkout_finished` is written by the order write path (CT7) inside the transaction that finishes the last order, through S05's `notifyCustomer`. The worker's existing jobs run it.
- `notifyCustomer` gains an option to write the center row without queuing the email (CT8). It is used only for the orders of a checkout.
- Email template `customer_checkout_finished` (Arabic, RTL, as S05's): the counts, the refunded amount, and a link to `/orders?checkout=<id>`. Never fields, codes or gift texts.
- Telegram: unchanged. The daily summary adds "سلال اليوم: N (M طلبات)".
- `order:place` (api CLI) gains `--gift-message <text>`, `--gift-sender <name>` and `--save <label>`. A new `checkout:place --email <customer> --line <product>[:<quantity>] [--field <key>=<value>]…` (repeatable `--line`, each followed by its fields; development only) prints the checkout id and its order numbers.

## Screens

### Store (phone width first, Arabic RTL, dark default; `brand/identity.md` §6)
- **Header:** a cart button with the line count (a badge from 1). Hidden when `localStorage` is unavailable.
- **Buy box** (S09, extended):
  - saved-ID chips above the fields (SP3, SP6, SP7), with "معرّف جديد" to type one;
  - under the fields, "احفظ هذا المعرّف" with the label (SP1);
  - "هذا الشحن هدية" with the sender name and the message with its counter (GF1, GF3 errors inline);
  - two actions: "متابعة" (S09's slide) and "أضف إلى السلة" (CT2).
  - Signed out, the save box is hidden; the gift and cart work.
- **`/cart`:**
  - lines as cards: the cover, the game and pack, a quantity stepper, the fields (in full; this is the customer's own device), the name chip or "أكّدت المعرّف بنفسك", a "هدية" badge, the unit and line price (with the price-change mark), and "حذف";
  - the totals, the balance after, the slide "اسحب لدفع $X" (BB5's slider), the shortfall view (CT4);
  - refused lines marked (CT6);
  - empty: "سلتك فارغة" with a link to the games. The page renders from the device at once; the price check shows a skeleton per price.
- **`/orders?checkout=<id>`:** a header "سلة من N طلبات · $X" with the finished state, then the orders as S09's cards, live.
- **`/orders/[id]`** (extended):
  - "اشترِ مجدداً" (OT1);
  - the gift section (GF4) with the image preview;
  - "مشاركة الإيصال" (RC1) as a bottom sheet with the choices, the preview, copy, share, download and revoke;
  - "ضمن سلة" linking to the checkout view.
- **`/orders`:** "اشترِ مجدداً" on repeatable cards; a "هدية" badge.
- **`/account/players` "معرّفاتي":** linked from the account menu. Groups by game with the cover, rows with the label, the masked main value, the name and "آخر استخدام". Actions: "اشحن", "إعادة تسمية" (inline) and "حذف" (dialog). Empty: "لم تحفظ أي معرّف بعد. احفظه عند الشراء القادم". Loading skeletons; an error with retry.
- **`/g/[token]`** and **`/r/[token]`** (GF5, RC2): one centered card at phone width, the brand frame, the game accent. "تنزيل الصورة" (the `square` image) and "مشاركة". Not found: "هذا الرابط غير متاح" with a link home.
- **Calculator** (S09): "أضف الكل إلى السلة" (CT3).
- **`/wallet`:** a checkout entry reads "شراء سلة: N طلبات" and expands to its orders' numbers and products.

### Admin (Arabic, RTL, light and dark)
- Order page: the checkout block, the gift block and the share-links table with "إلغاء الرابط" (AD1). Orders list: the badges and the `q` match (AD2).

## Audit and notifications
- Audit: `order.paid` gains `checkoutId` and `gift` (one entry per order, as S08). `order.share_revoked` (admin). Not audited: customers saving, renaming or deleting IDs, and creating, changing or revoking their own links. These are their own preferences, not money or admin actions (AGENTS.md). Link revocations stay visible in `order_share_links`.
- Customer notifications: `checkout_finished` (center and email). The center notifications of a checkout's orders are written without email (CT8). Single orders are unchanged.
- Telegram: the daily summary line only.

## Abuse and fraud
| Threat | Control |
|---|---|
| Guessing share links to read other customers' orders | 128-bit CSPRNG tokens; pages show only what the owner chose (masked ID by default, never codes, email, phone or names); 60 reads per minute per IP and nginx `vdshare`; `noindex`; revocation by the customer or the admin |
| Phishing or scams through gift messages on the store's domain ("send money to …") | Text only (no HTML); GF3 refuses links, domains, handles, phone numbers and bidi tricks; at most 140 characters; a gift needs a paid order; the admin revokes a reported link with a reason |
| A forged receipt image passed off as proof of payment | Every image carries its verification link, and the real page on the store's domain shows the true state; a revoked or unknown token answers not found |
| Double tap or retry paying a cart twice | One `Idempotency-Key` per body, kept on retry; unique `(customer_id, idempotency_key)` on `checkouts`; the journal key `checkout:<id>:purchase` |
| Paying a cart at a stale price | Each line's `expectedUnitPriceUsdUnits` against the price in force under the product lock; any change refuses the whole cart |
| Deadlocks or a half-paid cart | Products locked in id order; all or nothing in one transaction; one journal |
| Bypassing the purchase rate limit with carts | At most 10 lines per checkout, each within `max_quantity`; the checkout counts in the purchase limit; the balance is the cap, as for single orders |
| Two orders of a checkout finishing at once, sending the summary twice or never | The `checkouts` row lock in each terminal transition, and `finished_at` set once |
| Refunds of a cart exceeding what was paid | Refunds are per order and bounded by S08's checks; the checkout's journal equals the sum of its orders (a database test, and S13 nightly) |
| A saved ID making a wrong ID cheap to reuse | A supplier refusal marks the saved ID rejected (SP6) and turns off its one-tap; a refusal still refunds at once (S08) |
| Player IDs left on a shared device | The cart is cleared at sign-out; saved IDs live on the server behind the session; shares mask IDs by default |
| Script injection through labels, gift texts or player names on public pages and images | Rendered as text only (ADR 0015); labels and gift texts printable without bidi controls; SVG text escaped before rendering |
| Another customer's saved IDs, checkouts or links | Customer routes take no customer id; another customer's row answers `NOT_FOUND` |
| Image rendering used to load the server | Rendering is rate limited per IP, cached 5 minutes by HTTP, and has a fixed size and template; the cover is the stored WebP variant (SF5) |

## Edge cases
1. A cart line's price changes between adding and paying: `CHECKOUT_REFUSED` with `PRICE_CHANGED`; the cart applies the new price and the customer slides again.
2. One line becomes unavailable: the whole cart is refused; that line must be removed.
3. The balance covers 9 of 10 lines: refused `INSUFFICIENT_BALANCE` with the shortfall. Nothing is reserved, and the cart stays.
4. Purchases stop during checkout: the switches lock decides; the checkout commits before the stop or is refused.
5. The same checkout key is sent twice at once: the unique key decides; the second answers `200` with the first checkout.
6. One order of a checkout delivers, one refunds and one waits in `needs_review` for hours: the center tells each; the summary email waits for the last one.
7. Two orders of a checkout finish in the same second: the checkout lock lets one send the summary.
8. A checkout order is refunded: its own refund journal; the wallet shows the checkout entry and that order's refund entry.
9. The same player ID is saved twice: one row (unique hash); the old label stays.
10. A saved ID's game gains a required field: `complete: false`; the chip fills what applies and asks for the rest.
11. The saved ID's game or product is paused or archived: chips show only on shown games; "معرّفاتي" still lists them, with "اشحن" disabled and "غير متوفرة حالياً".
12. A gift on a reservation that expires: no gift link was ever made.
13. A gift order refunded: the gift page shows "تعذّر الشحن". The buyer can revoke the link.
14. Revoke, then a new link: the old token answers not found; the new one works. The gift texts are the same.
15. A receipt link for a code product: allowed; it shows the product and quantity, never a code.
16. A receipt's "full" player ID choice changed back to "masked": the page follows within 30 seconds and the image within 5 minutes.
17. Signing out with a full cart: it is cleared. Signing in as another customer starts empty.
18. `localStorage` blocked: no cart; the buy box works as in S09; saved IDs still work (server).
19. A test customer's checkout: availability per line over the test routes (S08 R4); the checkout's `is_test` is set.
20. Repeat of an order whose pack is now cheaper or dearer: today's price, shown on the slide step.
21. A cart filled signed out, then a sign-in as an unverified customer: the cart stays; paying asks to verify first.
22. The calculator's result needs 12 lines: nothing is added; "النتيجة تحتاج أكثر من 10 بنود. اشترِ الباقات على دفعات".
23. A line's player check was `invalid` when added and confirmed: the line carries `confirmPlayer: true`; the server stores `invalid_confirmed`.
24. The customer has 50 saved IDs and ticks "save": the box is hidden; if sent anyway, the purchase succeeds without saving.
25. The share image's cover is missing or archived: the template draws the accent band alone.

## Open questions
None blocking. To verify in PR 1: `sharp`'s SVG text (librsvg with Pango) shapes Arabic correctly with the bundled font on the server. If it does not, the image route ships with text drawn by the browser instead (the download button renders the card with a canvas) and `og:image` uses the game cover. The PR reports which one it took.

## Acceptance
The owner's browser check (local, `pnpm dev`, `SUPPLIER_FAKE_ENABLED=true`, `TELEGRAM_TRANSPORT=log`, the email `log` transport). The data is S09's: PUBG Mobile with "60 UC", "325 UC" and "660 UC" on fake offers, Free Fire active, an iTunes code product. The customer is a non-test one with $30 from a manual deposit adjustment.
1. Buy "60 UC" for `51234567` with "احفظ هذا المعرّف" ticked and the label "حسابي". The name check shows the name, and the order delivers. Open "معرّفاتي": "حسابي" with the name.
2. Open PUBG again and pick "325 UC": the "حسابي" chip opens the slide step at once with the name; slide; it delivers.
3. On the first order, press "اشترِ مجدداً": the slide step with "60 UC" and the same ID at today's price.
4. Add "60 UC" for `51234567` and "325 UC" for `51234568` (marked as a gift with the sender "أحمد" and the message "كل عام وأنت بخير") to the cart, and a Free Fire pack. Try the message "تواصل معي 0933123456": refused with the text. The header shows 3.
5. Open `/cart`: three lines, the totals and the balance after. Change the fake cost of "325 UC" so its price changes, then slide: the line shows the new price; slide again. `/orders?checkout=…` shows three orders moving live. One email "اكتملت سلتك" is logged, and three delivery notifications are in the center. `/wallet` has one entry "شراء سلة: 3 طلبات".
6. On the gift order, copy the gift link and open it in a private window: the sender, the message, the masked ID "••••4568" and "تم الشحن", with no price. Download the image. Revoke the link: the page says "هذا الرابط غير متاح" within 30 seconds. Make a new link.
7. On the first order, "مشاركة الإيصال": turn the price off and the ID to "كامل", then create. The private window shows the order number, no price and the full ID. Revoke it.
8. Script the fake offer `--order <offer> partial:1` for a "60 UC" × 2 cart line and another line `failed` with no other route: the summary email says one partly delivered, one refunded, with the amount; the refunds are separate wallet entries.
9. Script `--order <offer> invalid` and buy for a saved ID: the order refunds at once, and the chip now shows "رفض المورد هذا المعرّف…" and opens the fields instead of the slide.
10. Fill the cart with 10 lines and add one more: "السلة ممتلئة". Use the calculator for 3000 UC and "أضف الكل إلى السلة".
11. Sign out: the cart is empty.
12. In the panel, open the gift order: the checkout block, the gift texts, the links; revoke the live link with a reason; the audit log shows `order.share_revoked`.

Tests:
- Contracts (100% coverage): `giftTextAllowed` (each refusal, Arabic text with digits under 7, Arabic-Indic digits, spacing tricks, bidi controls), `maskFieldValue`, `canonicalFields`, `shareStage` (each status), `cartLineKey`, `checkoutTotal`, the new schemas (label, gift, checkout bounds 1–10, receipt options).
- Database: the `checkouts` trigger (only `finished_at`, once); the orders checks (checkout pair, no reserved cart line, gift only on `direct`, gift columns fixed); the partial unique on `purchase_journal_id` and the journal match on insert; the journal equals the sum of its orders; `order_share_links` (one live link per kind, no change after revocation, no delete); `saved_players` unique hash.
- Concurrency and idempotency (real PostgreSQL): the same checkout key in parallel (one checkout, one journal); a checkout racing a repricing of one of its products, and a stop; two checkouts sharing products in opposite order (no deadlock); two orders of a checkout finishing together (one summary); a checkout and a single purchase racing for one balance (never negative).
- API, every route: saved players (list by game, rename, delete; another customer's 404; the limits skip saving without failing the purchase; the name from a `valid` order only; rejected after `input_rejected`; cleared after a delivery); checkout (success, each line refusal collected, insufficient balance, the stop, replay and reused key, rate limit counted once, a test customer, 401, unverified); gift (code product refused, GF3, the link in each payment path, none for a cancelled reservation); receipt (statuses refused, create, update, revoke, new link); public share and image (no cookie, cache headers, revoked 404, data limited to the choices, never codes, rate limit); admin revoke (audit, reason bounds); wallet entries with `checkout`; `GET /api/orders?checkout=`.
- Worker: the terminal transitions of checkout orders write center rows without emails and one `checkout_finished` with the right counts (delivered, partial, refunded, `needs_review` then resolved).
- Store unit: the cart store (merge by key, 10 lines, gift lines apart, sign-out clearing, throwing `localStorage`), the calculator's line split, the checkout refusal mapping, request functions.
- E2E with RTL screenshots (phone and desktop, dark and light): the buy box with saved chips (complete, rejected, incomplete), the save and gift options with a refused message, the cart (lines, price change, refused lines, short balance, empty), the checkout view, the order page with repeat, gift and receipt sheet, "معرّفاتي" (list and empty), the gift and receipt pages (and not found), the wallet's checkout entry. Admin: the order page's checkout, gift and links with the revoke dialog. Performance: the game page's budget (230 KB) holds with the cart button; `/cart` and the share pages get budgets, measured in PR 2 and recorded in `apps/store/CLAUDE.md`.

## Implementation notes
- Suggested split, each leaving `main` green:
  1. Contracts, db, api:
     - db: `checkouts`, the `orders` changes, `saved_players`, `order_share_links`;
     - `checkoutOrders` and the CT7 finishing hook in `packages/db/src/orders`, beside `purchaseOrder`, sharing its line checks;
     - api: the saved-players routes, `POST /api/checkouts`, the order extensions (save, gift), the share routes, the image rendering, and the admin additions;
     - `notifyCustomer`'s option without email, and the `customer_checkout_finished` template;
     - the wallet entry extras; the CLI options and `checkout:place`; OpenAPI and the admin client.
     - The worker needs no new job, since CT7 runs in the shared write path. Its tests for CT8 come here too.
  2. Store and admin: the buy box additions, the cart and `/cart`, the checkout view, repeat, the gift and receipt UI, "معرّفاتي", `/g/` and `/r/`, the calculator's "add all", the wallet entry, the admin order page; E2E and screenshots; nginx (`vdshare`, `robots.txt`).
- Module layering: `orders` owns checkouts, saved players and share links. The public share routes live in `orders` under a public controller (as S08's webhook route is public under `suppliers`) and read `catalog` for names and covers.
- The image template's font: the fallback Arabic font the store already ships (Noto Kufi Arabic, ADR 0012) is bundled with the API for rendering; Madani replaces it once Q2's license allows.
- Update `docs/architecture.md` (the new tables, the checkout journal shared by orders, the public share routes), the commands table (`order:place` options, `checkout:place`), `apps/store/CLAUDE.md` (the cart store, the share pages, the budgets), `deploy/` and `docs/deployment.md` (the `vdshare` zone), and S02's W5 list.
