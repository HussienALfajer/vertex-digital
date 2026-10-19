# S19 — FazerCards: second automatic supplier and the store-wide player check

Status: Approved · Date: 2026-10-19 · Scope: `docs/product/v1-scope.md` §F09 (second supplier, the ROADMAP's Pilot item) and §F13 (player validation), owner 2026-10-19 · ADRs: 0003, 0004, 0005, 0020, 0021, 0023, 0030, 0031, 0032, 0034 (new)

## Summary
WDGZone does not check player ids, so the store cannot show the customer whose account a top-up goes to. FazerCards does (`POST /topups/validate-id`: valid, the in-game name, the region). S19 adds FazerCards as a second automatic supplier with its whole V1-relevant API (balance, top-up and gift-card catalog with images, orders with an idempotency key, signed webhooks, statement, subscription watch), and makes the player check **store-wide**: each game names a check provider, which answers for every pack of that game whichever supplier fulfils the order. Routing keeps "cheapest healthy route first"; equal costs go to the faster supplier by measured delivery time, then to WDGZone. A large price-basis switch to another supplier is held for review (Q17). Owner decisions of 2026-10-19 (interview below) settle the rules.

## Precondition: what the panel showed on 2026-10-19
Read-only, in the owner's signed-in reseller panel (session-cookie panel endpoints; the API key was not read):
- Account created 2026-10-14; trial (Gold tier) ending 2026-10-19 22:09 UTC; plans Bronze $3.99, Silver $6.99, Gold $9.99 per 30 days; webhook not set; balance 0.
- 300 top-up categories, 553 gift-card categories; 289 top-up categories and every gift card carry a webp cover on `reseller.fazercards.com/api/v2/media/…`; packs carry no image.
- Every compared pack costs exactly what WDGZone charges today (PUBG Mobile Auto 60/325/660/1800/3850/8100 UC = 0.875/4.38/8.76/22.00/43.9439/87.50; Free Fire MENA 110/231/583/1188 = 0.91/1.82/4.55/9.10; Likee, MICO, 8 Ball Pool and Bigo identical), with the same delivery-line names (Auto, Manual, Fast, Reserve). The two share one upstream: FazerCards' value is the player check and a second door when WDGZone's own API is down, not a lower price.
- The OpenAPI document (0.1.0, 47 paths) still lists `GET`/`POST /topups/validate-id`; a call on an inactive plan answers `403` with `code: subscription_inactive`. The panel UI has no check feature, so the list of games it supports is read in PR 2's exploration.

## Owner decisions (interview, 2026-10-19)
| # | Question | Decision |
|---|---|---|
| D1 | Plan | Bronze, bought only when PR 2's exploration needs an active plan (fund about $10 USDT with the invoice's exact `uniqueAmount`) |
| D2 | The check's region differs from the pack's | **Block** the purchase, with a clear message |
| D3 | Q17: a basis switch to another route moves the price above the review threshold | **Held for review**, as a same-route change |
| D4 | Telegram Stars / Premium | Deferred until after launch (not in S19) |
| D5 | Equal costs | The faster supplier by measured delivery time, then WDGZone |
| D6 | FazerCards gift cards | Listed and linkable; their routes stay off until one real order per card brand returns a clean code |
| D7 | FazerCards webhook URL | Set from our panel with a button (test event and delivery log too), audited |
| D8 | Low-balance alert | $5, editable in the panel |
| D9 | The check answers "not found" | Warning and the customer's confirmation, as today (ADR 0023 unchanged) |
| D10 | FazerCards images | Suggested in the panel; the admin picks; existing covers never change on their own |

## In scope / out of scope
- In:
  - Supplier `fazercards`: enum value, seeded row, `fazercards_paused` switch, credentials `apiKey` + `webhookSecret`, treasury place, labels.
  - Adapter `packages/suppliers/src/fazercards/`: balance, categories (top-up and gift card), offers per category, place order, get order, webhooks, statement, subscription watch, player check, images.
  - Catalog sync shaped for FazerCards' one-request-per-category API (rule FC3).
  - The store-wide player check: a per-game check provider (rules PC1–PC9), the region check (D2), built-in ID formats (rules ID1–ID4).
  - Routing: the delivery-time tie-break (D5) and Q17 (D3) for every supplier.
  - Admin screens: FazerCards' tabs like WDGZone's, the webhook and subscription cards, the game's check-provider card, the image suggestion. Store: name and region in the buy box.
  - The funded pilot (Acceptance).
- Out: Telegram Stars/Premium (D4), Steam top-up and gifts, game keys, manual services, FunPay, payments through the API (funding stays a manual admin action, S13), MCP tokens (never), FazerCards "Manual" categories and categories whose fields ask for an email and a password ("Auto Via Login", Q20), a check for a pack's own supplier when the game names another provider.

## Access
| Action | Route kind | Who |
|---|---|---|
| Enter or rotate FazerCards credentials | Admin, re-authentication (S07 SP2) | The admin |
| Set the FazerCards webhook URL, send its test event, read its delivery log | Admin, re-authentication for the set | The admin |
| Set a game's check provider, its category, field map and allowed regions | Admin | The admin |
| Use a supplier image as a game cover | Admin (S16 IM3) | The admin |
| Player check | Customer, PV4 limits (S09) · admin, AP8 | Verified customer · the admin |
| Receive a FazerCards webhook | Public, HMAC | FazerCards |

## Data
- `supplier_code` gains `fazercards`; `store_switch` gains `fazercards_paused` (default off). The seeded `suppliers` row (fixed UUID, `validation_daily_quota` 1000) is written by a hand-checked migration that does not use the new enum value in the same transaction it is added in (the enum is recreated as migration 0061 did, or the row is seeded in the next migration of the same PR, verified on a fresh and a migrated database).
- `SUPPLIER_CREDENTIAL_FIELDS.fazercards = ['apiKey', 'webhookSecret']` (encrypted as today). `supplier_low_balance` default for FazerCards $5 (D8).
- Treasury: place `supplier:fazercards`, account `supplier_prepaid:fazercards` (USD), as WDGZone's.
- New table `game_player_checks` (one row per game, current state; changes audited):
  - `game_id` uuid PK → `catalog_games`
  - `supplier_id` uuid → `suppliers` (a supplier with the `validatePlayer` capability)
  - `category_id` text, 1–128 (the provider's check category, e.g. FazerCards' validate `category_id`)
  - `field_map` jsonb (provider field → our input key, as `fieldMapSchema`), `option_map` jsonb (as routes)
  - `allowed_regions` text[] (0–20 codes, each 1–16 characters, upper-cased); empty = no region check
  - `enabled` boolean, `updated_at`, `admin_id`
- `player_checks` gains `region` text null (≤16) and `provider_supplier_id` (renamed meaning of `supplier_id`: the supplier that answered). `orders` gains `player_region` text null beside `player_name`.
- `supplier_offers.offer_id` for FazerCards: `topup:<category_id>:<offer_id>` and `gift:<category_id>:<card_id>` (≤128). Gift-card offers keep `min_quantity`/`max_quantity` in the existing quantity bounds of the product (S06) and `stock`.
- `supplier_categories` rows for FazerCards: flat (no parent), `kind` `direct` or `code`, `image_url` from `imageurl`/`icon_url`, `note` kept in a new `note` text column (≤1000, the supplier's region text, shown in the panel).
- Input field types gain `hoyoverse_uid` and `supercell_tag` (ID2, ID3); enum `input_field_type` extended the same safe way.
- No money table changes.

## States and rules

### FazerCards connection (FC)
- FC1. **Base and auth:** `https://api.fzr.cards/api/v2`, `X-API-Key`. 15 s per request, 30 s for an order. Rate limits per FazerCards' categories (catalog 120/min, orders 60/min, status 120/min, account 30/min): the adapter paces itself below them and honours `429 Retry-After` (a `429` on a read waits and retries once; on an order it is `unknown`, ADR 0004).
- FC2. **Availability:** `ADAPTERS_READY` gains `fazercards` only in PR 2. Before that the supplier shows "not available" in the panel, and sync, routing and checks skip it.
- FC3. **Sync:** the category lists (`GET /topups?limit=500`, `GET /giftcards`) are read once a day and on "sync now"; offers are read every 15 minutes for every category linked to a game (S16 SC5) plus a rolling window of 40 unlinked categories per run, so the whole catalog is seen at least every few hours and new packs still appear (SC11). Each run stays under 120 catalog requests a minute and under the 10-minute run limit. An offer not seen because its category was not in this run's window is not "missing"; `missing_since` is set only when its category was read and the offer was absent, or the category itself left the list.
- FC4. **Offers:** top-ups `GET /topups/offers?category_id=` → `offer_id`, `name`, `price_usd` (4-decimal string, parsed exactly into micro-dollars), `fields` (`key`, `label`, `type` text|select, `options`); gift cards `GET /giftcards/cards?category_id=` → `card_id`, `price_usd`, `stock`, `min_order_quantity`, `max_order_quantity`. Kind `direct` for top-ups, `code` for gift cards. Unsupported (shown, never routed or imported): categories named `… (Manual)`, any field that asks for a password or email (Q20), selects outside S06 bounds, as WDGZone's MF1–MF2.
- FC5. **Order:** `POST /topups/order` `{ category_id, offer_id, fields }` or `POST /giftcards/order` `{ category_id, card_id, quantity }`, header `Idempotency-Key: <attempt id>`. A replay answers the original order. `200/201` with `status` `completed` and the codes → `delivered`; `created`/`processing` → `pending` with `ord-N` kept; `failed`/`refund` → `failed_definitive` with `fail_reason`. Timeouts, `5xx`, `409`, `401/403` (except a refusal before sending), unreadable bodies → `unknown`. `403 subscription_inactive` before anything was charged is `failed_definitive` and pauses the supplier (FC9).
- FC6. **Poll:** `GET /orders/{ord-N}` → `status`, `status_history`, `fail_reason`, `completed_at`, `total_usd`, `cards` (codes, with pins kept as WDGZone's `<code> · PIN: <pin>`). The charged `total_usd` is compared with the attempt's expected cost as S18's charge check does for WDGZone.
- FC7. **Webhooks:** `X-Webhook-Signature: sha256=<hex>` HMAC of the raw body with `webhookSecret`, constant-time compare; `X-Webhook-Event-Id` is the replay key; the signed body's `timestamp` within 24 hours. Events: `order.status_changed` → map `data.status` as FC5 (a completed gift card returns `pending` so the poll fetches its codes); `order.created`, `webhook.test` and manual-service events are stored and ignored. Orders placed in FazerCards' own panel arrive too: they match no attempt and stay `unknown_key` (harmless).
- FC8. **Webhook setup (D7):** "ضبط الإشعارات" in the connection tab calls `PUT /account/webhook { url: <STORE_URL>/api/webhooks/suppliers/fazercards, enabled: true }`, then `POST /account/webhook/test`; the card shows the URL, enabled, and the last 50 deliveries (`GET /account/webhook/deliveries`). Rotating the secret (`POST /account/webhook/secret/regenerate`) is never automatic: the admin regenerates it in FazerCards and enters it with the key (S07 SP2 needs both fields). Each set or test is audited.
- FC9. **Subscription watch:** the balance job reads `GET /me` with `GET /balance`: Telegram alert 48 hours before `planExpiresAt` (once per expiry) and when `subscriptionActive` turns false; while inactive, the supplier is treated as paused for routing and checks (no new attempt, checks `unavailable`), and the panel shows why. Recovery clears it.
- FC10. **Statement:** `GET /transactions` (`id`, `type`, `status`, `amount`, `balanceBefore`, `balanceAfter`, `note`, `createdAt`) and `GET /orders` (`id`, `status`, `offer_id`, `category_id`, `total_usd`, `created_at`, `completed_at`), matched to attempts by `ord-N` as WDGZone's.
- FC11. **Images:** `imageHosts` = `reseller.fazercards.com`, `api.fzr.cards`; S16 IM1–IM3 apply unchanged (HTTPS, these hosts only, redirects only within them, 2 MB thumbnails / 5 MB covers, re-encoded, stored and served by us; never hotlinked).
- FC12. **Platform status:** none (`platformStatus` off).

### Routing (RT, amends S07 and ADR 0005)
- RT10. **Q17 (D3):** when a reprice moves the price basis to a different route and the new price differs from the stored one by more than the review threshold, the change opens a price review as a same-route change does, unless the basis is `manual`.
- RT11. **Tie-break (D5):** among usable routes of the same tier and the same cost, the route whose supplier has the shorter measured delivery time comes first; then the route priority (1–9); then the supplier precedence `wdgzone`, `fazercards`, `fake`, `manual` (replacing the alphabetical tie-break).
- RT12. **Measured delivery time:** per supplier, the median of `resolved_at − send_started_at` over its `delivered` attempts in the last 7 days, with at least 10 of them; otherwise "no measure" and RT11 skips to priority. Computed once a minute with the health job and kept in memory of the routing read (no new table).

### Store-wide player check (PC, amends S09 PV1–PV2, PV6)
- PC1. **Provider per game:** a game with an enabled `game_player_checks` row is checked by that provider for every `direct` pack, whichever supplier fulfils the order. Without a row, S09's route-based choice applies as today (the fake supplier keeps working in development and tests).
- PC2. **Mapping:** the provider's fields are filled from our input keys through the row's `field_map`/`option_map`, as a route's are; an unmappable value answers `not_supported`. The adapter's call becomes `validatePlayer({ categoryId, fields })` (WDGZone keeps none; the fake maps its own).
- PC3. **Region (D2):** the answer's `region` is kept. When `allowed_regions` is not empty and the region is present and not in it, the answer is `{ result: 'region_mismatch', playerName?, region }`. The buy box refuses the purchase with "هذا الحساب على منطقة <region> ولا تصلح له هذه الباقة" and the server refuses the order (`PLAYER_REGION_MISMATCH`), even with `confirmPlayer`. A missing region passes.
- PC4. **Not found (D9):** unchanged (ADR 0023): a warning and the customer's confirmation.
- PC5. **Unavailable:** provider down, paused, subscription inactive (FC9), quota reached or a timeout → `unavailable` and the customer confirms the id manually (PV6 unchanged).
- PC6. **Cache and limits:** S09 PV3–PV5 unchanged, keyed by game and fields; the quota is the provider's. A cached `region_mismatch` follows the `valid` lifetime (24 h).
- PC7. **Health:** `validate_player` calls no longer count toward a supplier's routing health (they join `PANEL_READ_OPERATIONS`' exclusion); a check outage must not stop deliveries, nor the reverse.
- PC8. **Test customers:** keep S09's rule: checks use the fake supplier only; a game whose provider is not the fake answers `not_supported` to a test customer.
- PC9. **What the customer sees:** "الاسم في اللعبة: <name> · المنطقة: <region>" (region only when present), `region_mismatch` as PC3; saved ids, cart, order page and the admin's order show the region beside the name.

### Built-in ID formats (ID, amends S06 CT7 with fixed types only)
- ID1. Formats are fixed field types, never admin patterns (CT7 stands).
- ID2. `hoyoverse_uid`: 9–10 digits; the server is derived from the leading digits (6 America, 7 Europe, 8 or 18 Asia, 9 TW/HK/MO); when the game also has a `select` server field, a value that contradicts the uid is refused before any check ("الخادم لا يطابق رقم الحساب"). Used for Genshin Impact, Honkai: Star Rail, Zenless Zone Zero.
- ID3. `supercell_tag`: `#` followed by 3–15 of `0289CGJLPQRUVY`, upper-cased, `O` read as `0`, the `#` added when missing. Used for Clash of Clans, Clash Royale, Brawl Stars.
- ID4. Digit lengths for PUBG Mobile, Free Fire and Mobile Legends (user id and zone id) stay the existing `digits` min/max set per game by the admin; S19 sets them in the catalog for the games on sale (PUBG 8–12, Free Fire 8–12, MLBB user 5–12 and zone 3–5), as data, not code.

## Money flows
None new. FazerCards purchases debit FazerCards' prepaid balance exactly as WDGZone's (S08 order flow, ADR 0004); funding is a manual treasury movement (S13) to `supplier_prepaid:fazercards`. The Bronze fee is paid from the FazerCards balance in its panel by the owner and recorded as a treasury expense like any supplier fee.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `PUT /api/admin/suppliers/fazercards/webhook` | Admin, re-auth | — | `{ url, enabled }` | `SUPPLIER_UNAVAILABLE`, `SUPPLIER_ERROR` |
| `POST /api/admin/suppliers/fazercards/webhook/test` | Admin | — | `{ ok }` | as above |
| `GET /api/admin/suppliers/fazercards/webhook` | Admin | — | `{ url, enabled, deliveries[] }` | as above |
| `GET /api/admin/suppliers/:code/check-categories` | Admin | — | `[{ categoryId, name, fields[] }]` (FazerCards' `GET /topups/validate-id`) | `NOT_SUPPORTED` |
| `GET /api/admin/catalog/games/:id/player-check` · `PUT …` | Admin | `gamePlayerCheckSchema` | the row | `VALIDATION_FAILED`, `NOT_SUPPORTED` |
| `POST /api/player-checks` (S09) | Customer | unchanged | `playerCheckSchema` + `region`, + `region_mismatch` | unchanged + — |
| `POST /api/orders` and checkout (S08, S10) | Customer | unchanged | unchanged | + `PLAYER_REGION_MISMATCH` |
| `POST /api/webhooks/suppliers/fazercards` | Public, HMAC | raw body | `204` | `401` |
| Supplier detail, catalog, offers, statement, runs, health | Admin (S07, S16) | unchanged, per capability | unchanged | unchanged |

## Jobs and integrations
- `suppliers.sync` (FC3), `suppliers.balances` (+ FC9), `suppliers.health` (+ RT12, PC7), the order jobs and `suppliers.webhook` unchanged in shape; the FazerCards adapter registered in the worker and API registries.
- Telegram: FazerCards low balance (D8), subscription expiry and inactive (FC9), the pause switch, health changes, S18's charge mismatch, gift-card route reminders none.

## Screens
- **Suppliers list:** a FazerCards card like WDGZone's (no platform status line), with the plan and its expiry.
- **FazerCards detail:** tabs Connection, Catalog (flat list with images and the category note), Offers, Statement, Runs, Health. Connection adds: the webhook card (FC8), the subscription card (plan, expiry, active), the validation quota (existing).
- **Game page → "فحص اللاعب" card:** provider (suppliers with the capability), the provider category (searchable list from `check-categories`), field map onto the game's fields (proposed by key), allowed regions (chips), enabled; a "تجربة" button runs the admin check (AP8) with entered values.
- **Image suggestion (D10):** on import, link and the game page, when a linked FazerCards category with the same name exists, its image is offered as "صورة FazerCards" beside the current cover; one click sets it (IM3).
- **Store buy box:** name and region (PC9); the region refusal (PC3); unchanged otherwise. RTL screenshots for each state.

## Audit and notifications
Audited: credentials, the webhook set and test, the game's check provider row, a cover chosen from a supplier image, the pause switch. Telegram: as "Jobs". No customer notification changes.

## Abuse and fraud
- Free name lookups through our store: S09 PV4 limits and the per-provider daily quota stand; the region of an account is shown only to the verified customer who typed its id.
- Forged webhooks: HMAC with FazerCards' own secret, event-id replay key, 24-hour window; a webhook is a hint, the poll (FC6) is the record.
- A FazerCards cost dropping near zero to capture the basis: RT10 holds it for review; the margin guard still applies.
- Used or invalid gift codes (FazerCards' reviews): D6 keeps gift routes off until a clean live order per brand; a code complaint follows S12's ticket path and the admin can pause the route.
- Panel orders placed by someone with the FazerCards login: they arrive as unmatched webhooks and in the statement as "unmatched" rows (S16 SF3), visible to the owner.
- Key leak: the key spends the balance; D8's low balance and a small float limit the loss.

## Edge cases
1. The trial or plan expires mid-day: FC9 pauses FazerCards for routing and checks; WDGZone routes carry on; checks become `unavailable` and customers confirm ids.
2. A game's provider is FazerCards and FazerCards does not list that game in `validate-id`: the panel refuses the category; the game falls back to PC1's route-based choice when the row is disabled.
3. The region strings FazerCards returns are not known before PR 2's exploration: `allowed_regions` stays empty (no region check) for a game until the owner sets it from a real answer.
4. Equal cost and no delivery measure: priority, then WDGZone first (RT11).
5. A webhook for a completed gift card carries no codes: the attempt stays pending until the poll reads `cards` (FC7).
6. Two FazerCards offers with the same `offer_id` in different categories: the composite offer id keeps them apart (FC4).
7. `403 subscription_inactive` on an order: refused before charging → `failed_definitive`, next route (FC5).
8. A FazerCards category disappears: its offers get `missing_since` (FC3), mapped routes become unusable, prices move to the next route under RT10.
9. S18 changes the same supplier contracts (`packages/contracts/src/suppliers.ts`, `core/adapter.ts`): S19's code PRs start after S18 merges, on its result.

## Open questions
None blocking. Recorded for PR 2's exploration: the `validate-id` game list and its region values (edge 3); whether Bronze prices differ from the trial's (D1 accepts either).

## Acceptance
- Owner, after PR 1's deploy: enter the FazerCards key and webhook secret in the panel; the card shows "not available" until PR 2.
- After PR 2: buy Bronze when asked; "sync now" fills the catalog with images; "ضبط الإشعارات" sets the webhook and its test arrives; the statement and subscription cards read correctly.
- After PR 3–4 (fake supplier and then live): set PUBG Mobile's and Free Fire's check provider; type the owner's own ids: the name and region appear; a wrong id warns; a region outside the allowed list blocks; with FazerCards paused, checks fall back to manual confirmation.
- Funded pilot (owner funds about $10 USDT): one real 60 UC order routed to FazerCards (WDGZone route paused for that minute), delivered and matched in the statement; then the WDGZone route re-enabled.
- Tests: adapter against a fake HTTP server (every endpoint, status, error, `429`, timeout → `unknown`, replay, webhook valid/wrong/stale/replayed, decimals); sync window and `missing_since` rules; routing RT10–RT12 units; player checks per PC1–PC9 (provider row, region mismatch at check and purchase, health exclusion, test customer); ID2–ID3 units; API 401/403 for every new admin route; E2E and RTL screenshots for the new screens.
- Delivery plan: PR 1 (enum, seed, switch, credentials, labels; deployable alone), PR 2 (adapter, sync, orders, webhooks, statement, subscription, images, webhook card), PR 3 (routing RT10–RT12, store-wide check PC1–PC9, ID formats, game check card, store display), then deploy and the pilot.
