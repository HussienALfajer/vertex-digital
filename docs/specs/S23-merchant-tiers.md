# S23 — Merchant tiers (F43)

Status: Approved · Date: 2026-10-30 · Scope: `docs/product/v1-scope.md` §F43 (Phase M) · ADRs: 0003, 0011, 0020, 0035, 0036, 0038 (new)

## Summary
S21 gave merchants volume levels that only pick a price list, and none exist in production. S23 turns them into four named **tiers**, Bronze, Silver, Gold and Diamond, that a merchant can see, show and work toward: a **price ladder** of chained lists with a smaller margin per tier (per category, and fixed prices on best sellers for Diamond), a tier **identity** (badge, card, celebration, the badge on receipts, verification, price list, statement, a wall certificate and a shop sticker), **progress** tools (progress bar, tier table, forecast, month-end reminder, history, savings), **operational privileges** per tier (deposit limits, player checks, bulk and code quantities, queue priority, a reply promise, a Diamond contact link, early access to new packs, faster alerts, receipt customisation), an explicit **grace** rule, a **manual tier** the admin grants for a set period, and the admin's **tier tools** (column and filter, report, Telegram alerts, threshold preview). No new money flow: the only money effect is the price a merchant pays, through S20's lists.

## Owner decisions (interview, 2026-10-29)
1. **Four tiers:** برونزي، فضي، ذهبي، ماسي. Bronze is every merchant without a level, priced by the seeded `wholesale` root list (renamed "البرونزية" in the panel; never deleted or archived, S20 LS1). Silver, Gold and Diamond are the three S21 levels, each with its own custom list: Silver's list inherits from wholesale, Gold's from Silver's, Diamond's from Gold's; each carries only its own rules.
2. **Thresholds:** set by the admin in the panel; the spec seeds starter values ($300, $1,000, $3,000 net purchases a month) the admin edits later.
3. **Margin ladder:** defaults chosen in the spec, editable in the panel: global margin Bronze 5% with a $0.05 minimum (today's wholesale rule, unchanged), Silver 4% and $0.04, Gold 3% and $0.03, Diamond 2% and $0.02. The minimum margin steps down with the percentage, otherwise cheap packs (60 UC at a cost of about $0.887) would not change price.
4. **Per category:** game top-ups and game cards take the full step; chat and streaming apps and subscriptions take half the step; store and platform cards and shopping cards take none (the Bronze price).
5. **Diamond fixed prices:** the admin sets fixed prices on Diamond's list for the best-selling packs (S20 fixed prices, guarded as always).
6. **Colours:** quiet metals, added to the identity for tier surfaces only: Bronze copper, Silver a green-tinted grey, Gold the brand sand, Diamond a pale glacier green; a different icon per tier.
7. **Badge to the merchant's customers:** from Silver up the tier's name and badge ("تاجر ذهبي معتمد من Vertex Digital"); Bronze shows "تاجر معتمد من Vertex Digital" without a tier name. Inside the merchant area every tier shows its badge.
8. **Tier table prices:** the table shows, for each tier, the price of the merchant's three most-bought packs (amends S20 AT4 for these prices only; never a list's name, rule or cost).
9. **Deposit limits per tier** (per deposit / 24 hours): Bronze $2,000 / $5,000, Silver $3,000 / $8,000, Gold $5,000 / $15,000, Diamond $10,000 / $30,000; editable in the panel; per-customer overrides (S12) still win.
10. **Player checks, bulk lines and codes per order:** defaults chosen in the spec, editable in the panel (see TS2).
11. **Support:** Gold and Diamond tickets come first in the panel with the tier's mark; the merchant sees "نرد عادةً خلال 3 ساعات" (Gold) or "خلال ساعة" (Diamond); the admin gets a Telegram alert when such a ticket waits past the promise.
12. **Diamond contact:** a WhatsApp number and a Telegram username set in the panel, each optional, shown to Diamond merchants only.
13. **Manual tier:** the admin grants a tier with an end date (1–90 days) and a reason; the merchant gets the tier's badge, prices and privileges like an earned tier, never lower than what they earned (the higher wins), with no "temporary" mark; at the end they return to their earned tier with a notification; the admin is reminded on Telegram 3 days before.
14. **Important merchant (Telegram):** any merchant entering or leaving Gold or Diamond. Other tier changes are counted in the daily summary only.
15. **Early access:** only for games or packs the admin marks "وصول مبكر 24 ساعة" when activating them; synced additions are visible to everyone at once.
16. **Excluded** (confirmed twice): deposit bonus, monthly cashback, credit lines, locking Diamond after three months, merchant referral rewards, seasonal challenges. Nothing touches money beyond the price ladder.

Defaults chosen in the spec (editable in the panel, flag in review if wrong): the privilege numbers of TS2; the month-end reminder on the 25th at 10:00 Damascus to merchants within 30% of the next tier or below their tier's threshold; the forecast from the 5th of the month; faster alerts every 15 minutes for Gold and Diamond; the receipt welcome line from Silver and the larger logo from Gold; the certificate's public page shows the trade name, city, governorate and current tier only.

## In scope / out of scope
- In:
  - Tiers on top of S21 levels: the `merchant_tier` enum, one live level per tier above Bronze, the chained tier lists and the **parent cap**, the price kind of tier lists, a one-off setup command for production.
  - Tier settings per tier (privileges), the effective tier (earned or granted), manual grants with their end job.
  - Identity: badge, tier card, celebration, the badge on receipts, verification, price list, statement; the certificate and its public page; the shop sticker; receipt customisation.
  - Progress: progress bar, tier table, forecast, month-end reminder, monthly history, savings, the grace made explicit.
  - Privileges: deposit limits, player-check quota, bulk lines and codes per order, deposit queue and ticket priority with the reply promise and its overdue alert, Diamond contact, early access, faster alerts.
  - Admin: the tiers page with the threshold preview, the merchants list column and filter, the profile's tier card and grant, the report by tier, Telegram alerts, the Diamond best-sellers helper.
- Out (later or never):
  - Everything in decision 16.
  - Tiers for retail customers: no; customers keep retail and S20's assigned lists.
  - More than four tiers or renamed tiers: no; the names and order are fixed (the admin edits thresholds, lists and privileges).
  - A tier badge on the public game pages or reviews: no; the badge appears only where the merchant shows it (receipts, verification, price list, certificate, sticker).
  - Server-side PDF or PNG rendering for the certificate and sticker: no; the browser prints and draws (ADR 0036).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the tier summary, tier table, history, savings, certificate data | Customer | Merchant (not archived; frozen allowed) |
| Mark the celebration seen; set the receipt welcome line; reissue the certificate code | Customer | Merchant, not frozen |
| Read the Diamond contact | Customer | Merchant whose effective tier has `direct_contact` |
| Read a certificate page | Public, rate-limited | Anyone holding the code |
| Read tiers, tier settings, the report, the preview, the best-sellers helper | Admin | The admin |
| Change a tier's threshold, list or settings; set the Diamond contact; grant or end a manual tier; set or end early access; clear a welcome line | Admin, re-authentication | The admin |
| Recompute tiers, end grants, reminders, overdue tickets, early-access ends, faster alerts | Worker jobs | System |

A customer of type `customer` gets `NOT_MERCHANT` on every merchant route. A merchant reads only their own tier data. The setup command runs on the server only.

## Data
Money is USD units (micro-dollars, ADR 0003). `merchants` owns tiers, settings, grants, months and changes; `pricing` owns the parent cap; `catalog` owns early access; `support` the ticket order.

### Contracts (`merchant-tiers.ts` new; `merchants.ts`, `merchant-tools.ts`, `pricing.ts`, `price-kinds.ts`, `catalog.ts`, `support.ts`, `deposits.ts`, `notifications.ts`, `telegram.ts`, `audit.ts`, `errors.ts`, `jobs.ts` extended)
- `MERCHANT_TIERS = ['bronze', 'silver', 'gold', 'diamond']` (ordered), `LEVEL_TIERS` (the last three), `TIER_NAMES_AR` (برونزي، فضي، ذهبي، ماسي).
- Pure functions, 100% coverage:
  - `tierRank(tier)`, `higherTier(a, b)`.
  - `effectiveLevel(earnedLevel, openGrant, levels)`: the higher of the earned level and the grant's tier's live level (TR3).
  - `tierProgress(levels, thisMonthUsdUnits, effectiveTier)`: the next tier, its threshold, the amount missing, the ratio (PG1).
  - `tierKeptUntil(levels, previousMonth, thisMonth, earnedTier, month)`: the last day the earned tier is held (PG7).
  - `tierForecast(thisMonthUsdUnits, dayOfMonth, daysInMonth, nextThresholdUsdUnits)`: the projected month total and the day the next threshold is reached, or null (PG4).
  - `tierReminder(levels, previousMonth, thisMonth, earnedTier)`: `reach` with the amount, `keep` with the amount, or null (PG3).
  - `parentCappedPrice(own, parent)` (PX2).
  - `welcomeTextSchema` rules (RC1).
- `MERCHANT_LEVELS_MAX` becomes 3; `MERCHANT_CODE_QUANTITY_MAX` and `BULK_LINES_MAX` become per-tier settings (`orderUnitsMax`, `bulkLinesMax`) with a hard ceiling `TIER_QUANTITY_CEILING = 100`.
- `PRICE_SOURCES` gains `parent_cap`.
- Notification events: `merchant_tier_reminder` (center, email, push), `merchant_early_access` (center, push). `merchant_level_changed` carries the tier and what it grants.
- Telegram events: `merchant_tier_changed` (important changes, TR8), `merchant_tier_grant_ending` (MG5), `ticket_overdue` (OP6). The daily summary line "مستويات التجار" becomes "فئات التجار: n تغيّرت اليوم".
- Error codes, each with its Arabic text: `MERCHANT_TIER_TAKEN` (409, a live level already has the tier), `MERCHANT_TIER_ORDER_INVALID` (422, thresholds must rise with the tier), `MERCHANT_TIER_LIST_INVALID` (422, `details.expectedParentListId`), `MERCHANT_TIER_UNAVAILABLE` (409, the tier has no live level), `MERCHANT_TIER_GRANT_NOT_HIGHER` (409), `MERCHANT_TIER_GRANT_OPEN` (409), `CERTIFICATE_REISSUE_LIMIT` (429); existing `NOT_MERCHANT`, `ACCOUNT_FROZEN`, `NOT_FOUND`, `REAUTHENTICATION_REQUIRED`, `PRICE_LIST_IN_USE`, `VALIDATION_FAILED`, `RATE_LIMITED`.

### `merchant_levels` (S21; changed)
- Gains `tier` (`merchant_tier`, required, one of `silver`, `gold`, `diamond`); unique among live levels. At most 3 live levels.
- `name_ar` is written by the API as the tier's Arabic name (kept for S21's reads and history); the panel no longer edits it.
- Rules checked by the API under the levels' advisory lock: thresholds rise with the tier among live levels (`MERCHANT_TIER_ORDER_INVALID`); a level's list is an unarchived `custom` list whose parent is the list of the next lower tier: wholesale for Silver, the live Silver level's list for Gold, Gold's for Diamond (`MERCHANT_TIER_LIST_INVALID`). A Gold level may exist without a Silver level only when its list's parent is wholesale (the rule reads "the next lower **live** tier").
- Migration: every live level is archived (production has none on 2026-10-29; the local seed runs the setup command instead, PX1), then the column is added as required.

### `merchant_tier_settings` (new; append-only versions per tier; the newest row per tier is in force)
- `id`, `tier` (`merchant_tier`), `per_deposit_usd_units`, `daily_deposit_usd_units` (whole cents, per deposit ≤ daily, both ≥ the deposit minimums as S20), `player_checks_per_hour` (10–1,000), `player_checks_per_day` (30–5,000, ≥ per hour), `bulk_lines_max` (10–100), `order_units_max` (1–100, the units of a code pack per order), `deposit_priority`, `support_priority` booleans, `support_reply_minutes` (15–1,440, nullable: no promise), `direct_contact`, `early_access`, `fast_alerts`, `receipt_welcome`, `receipt_large_logo` booleans, `admin_id` (nullable for the seed), `created_at`. Index `(tier, created_at desc)`. `append_only_guard`.
- Seeded by the migration with TS2's values; Bronze's deposit and check values are copied from the newest `merchant_settings` row so nothing changes for today's merchants.

### `merchant_settings` (S20; changed, still append-only versions)
- Gains `direct_contact_whatsapp` (E.164, nullable) and `direct_contact_telegram` (`^[A-Za-z0-9_]{5,32}$`, nullable).
- `per_deposit_usd_units`, `daily_deposit_usd_units`, `player_checks_per_hour` and `player_checks_per_day` are no longer read (the Bronze tier row replaces them) and leave the panel; a later contract PR drops them.

### `merchant_profiles` (S20, S21; changed)
- `level_id` becomes the **effective** level (earned or granted): what prices, privileges and the badge follow, so S21's list code is unchanged. Gains `earned_level_id` → `merchant_levels` (nullable), `level_source` (`earned`, `granted`; nullable with no level), `celebrate_pending` boolean (default false), `certificate_code` (22 base64url characters from 16 CSPRNG bytes, unique, written at grant and backfilled by the migration), `certificate_reissued_at` (nullable). Written by the level job (TR6) except `celebrate_pending` (cleared by the merchant) and the certificate code (reissued by the merchant).

### `merchant_tier_grants` (new; business table, never deleted; ended by `ended_at`; owner `merchants`)
- `id`, `customer_id` → `customers`, `tier` (`silver`, `gold`, `diamond`), `starts_at`, `ends_at` (after `starts_at`, at most 90 days later), `reason` (5–500), `admin_id`, `ended_at` (nullable), `end_reason` (`expired`, `ended_by_admin`, `merchant_revoked`, `tier_archived`; nullable), `timestamps`. One open grant per customer (partial unique index on `customer_id` where `ended_at is null`). Index `(ended_at, ends_at)` for the end job. A guard: no delete; `customer_id`, `tier`, `starts_at`, `reason`, `admin_id` fixed; `ended_at` and `end_reason` set once; `ends_at` fixed (the admin ends a grant early and grants a new one to extend it). A business record closed by its end, never archived.

### `merchant_tier_changes` (new; append-only)
- `id`, `customer_id`, `from_tier`, `to_tier` (`merchant_tier`), `source` (`earned`, `granted`, `grant_ended`, `revoked`, `tiers_changed`), `created_at` (`clock_timestamp()`). Index `(created_at)` and `(customer_id, created_at desc)`. Written in TR6's transaction whenever the effective tier changes. Read by the report, the history, the Telegram alert and the daily summary.

### `merchant_tier_months` (new; append-only)
- `customer_id`, `month` (date, the 1st), `net_purchases_usd_units` (LV2), `earned_tier`, `held_tier` (the effective tier at the month's end), `held_source` (`earned`, `granted`), `created_at`. Primary key `(customer_id, month)`. Written by the monthly cron for the month just ended (insert on conflict do nothing). History starts with the month S23 is deployed in.

### `merchant_receipt_settings` (S21; changed)
- Gains `welcome_text` (nullable, RC1).

### `catalog_games`, `catalog_products` (S06; changed)
- Gain `early_access_until` (timestamptz, nullable). Index on each where not null.

### `product_prices` (S07, S20; changed)
- `source` gains `parent_cap` (PX2); `rule_id` is the parent row's rule, as `retail_cap` names retail's.

## States and rules

### Tiers and the effective tier
- TR1. The tiers are Bronze, Silver, Gold, Diamond in that order. Bronze is a merchant with no effective level; the other three are the live levels with that `tier`.
- TR2. **Earned level:** S21 LV2–LV3 unchanged (`levelFor` over the larger of the previous and this month's net purchases).
- TR3. **Effective level:** the higher of the earned level and the level of the open grant's tier (MG1) when that tier has a live level. The **effective tier** is that level's tier, or Bronze.
- TR4. **Price:** S21 LV5 with the effective level: the account's assigned list, else the effective level's list, else wholesale. A merchant on an assigned list keeps their tier's badge and privileges.
- TR5. **Privileges:** the current `merchant_tier_settings` row of the effective tier (TS1).
- TR6. **Recomputation** (S21 LV4 extended, `merchants.level`): in one transaction with the customer `FOR UPDATE`, computes the earned level and the effective level; when either differs it writes `earned_level_id`, `level_id`, `level_source`, `level_changed_at` (when the effective level changed), the audit entry, and, when the effective tier changed, a `merchant_tier_changes` row, `celebrate_pending = true` on a rise (false on a fall), the notification `merchant_level_changed`, and the Telegram alert (TR8). A change of the effective list follows S20 AT3 (reservations cancelled). Queued as in LV4, and also by a grant's start or end, a tier settings change that changes a level, and the end job (MG4). Running it twice is a no-op.
- TR7. **Grace, made explicit:** a tier earned is held while the previous or the current month reaches its threshold (LV3). The tier card shows "فئتك محفوظة حتى <date>": the end of next month when this month has reached the threshold, else the end of this month (`tierKeptUntil`). While a grant sets the tier above the earned one, the line is hidden.
- TR8. **Important change:** a change of effective tier into or out of Gold or Diamond sends Telegram `merchant_tier_changed` (trade name, from and to, source, this month's and last month's net purchases) with dedupe key `tier-change:<customer>:<change id>`. Every change counts in the daily summary.
- TR9. **Revocation** (S20 MA7, S21 LV7): clears `level_id`, `earned_level_id`, `level_source`, ends an open grant (`merchant_revoked`), writes the change row (`revoked`); no notification beyond the revocation's own. The certificate page shows "لم يعد معتمداً" (ID7).

### Tier settings (privileges)
- TS1. Each tier has one current settings row; a change appends a row (re-authentication, audit before and after). A change that touches a level's threshold or list requeues every merchant (S21 LV6).
- TS2. **Defaults** (seeded):

| Setting | Bronze | Silver | Gold | Diamond |
|---|---|---|---|---|
| Per deposit / 24 hours | $2,000 / $5,000 | $3,000 / $8,000 | $5,000 / $15,000 | $10,000 / $30,000 |
| Player checks per hour / day | 100 / 300 | 150 / 500 | 250 / 800 | 400 / 1,500 |
| Bulk lines / codes per order | 50 / 50 | 50 / 50 | 100 / 100 | 100 / 100 |
| Deposit queue priority | no | no | yes | yes |
| Ticket priority / reply promise | no / none | no / none | yes / 180 min | yes / 60 min |
| Direct contact | no | no | no | yes |
| Early access | no | no | yes | yes |
| Faster alerts (every 15 minutes) | no | no | yes | yes |
| Receipt welcome line / larger logo | no / no | yes / no | yes / yes | yes / yes |

- TS3. **Deposit limits** (amends S20 MD1): a merchant's per-deposit and 24-hour limits are their effective tier's; S12 per-customer overrides still replace them; the profile's limit source reads "الافتراضي: تاجر ذهبي" (the tier's name). Telegram approval keeps its $100 ceiling (MD4). Limits apply at a deposit's creation (S03 SC3): a fall does not touch deposits already created.
- TS4. **Player checks** (amends S21 BK4): the effective tier's hourly and daily numbers; the per-IP limit for a merchant's request is the hourly number; the supplier's daily quota still caps everything.
- TS5. **Quantities** (amends S21 QT1, BK1, BK3): a merchant's code order may carry up to the tier's `order_units_max`, a bulk list and a merchant checkout up to `bulk_lines_max`. The database checks widen to 1–100 (`orders.quantity`, `checkouts.line_count`); customers keep the product's `max_quantity` and 10 lines. QT3 (a supplier offer's own limit) is unchanged. A bulk list checked under a higher tier and paid after a fall is refused with `VALIDATION_FAILED` naming the limit.

### Price ladder
- PX1. **Setup** (`pnpm --filter @vertex-digital/api merchants:setup-tiers`, idempotent, after `pnpm build`; run once in production after the deploy): renames the wholesale list "البرونزية"; creates the three custom lists "الفضية" (parent wholesale), "الذهبية" (parent Silver's), "الماسية" (parent Gold's) with their global and category rules (PX3); creates the three levels at $300, $1,000 and $3,000 on them. Anything that already exists by name is left untouched and reported; it never changes a rule the admin edited. Creating each list prices it (S20 RP3). `pnpm db:seed-local` runs it too.
- PX2. **Parent cap** (amends S20 LP1–LP2 for tier lists): for a list named by a live level, the list's price for a product is at most its parent list's current price for it; when the parent's is lower, the row's price is the parent's, source `parent_cap`, with the parent row's rule and minimum margin. So a tier is never dearer than the tier below, whatever its own rules. The retail cap still holds (the parent's price is already capped). Repricing (S20 RP1) prices lists parents before children (by chain depth), under the same product locks.
- PX3. **Default rules** (percent, fixed $0, minimum margin), written by PX1:

| Rule on the tier's list | Silver | Gold | Diamond |
|---|---|---|---|
| Global (game top-ups and game cards) | 4% · $0.04 | 3% · $0.03 | 2% · $0.02 |
| Category: chat and streaming apps; subscriptions and digital services | 4.5% · $0.05 | 4% · $0.04 | 3.5% · $0.04 |
| Category: store and platform cards; shopping cards | 5% · $0.05 | 5% · $0.05 | 5% · $0.05 |

  A minimum margin is whole cents (S07), so the half step's $0.045 and $0.035 are rounded up to $0.05 and $0.04 (owner, 2026-10-29). Bronze stays the wholesale global rule (5% · $0.05). The six production slugs (read 2026-10-29): `games` and `game-cards` (global rule), `apps` and `subscriptions` (half step), `gift-cards` and `shopping` (no step). PR 1 reads the six production category slugs (read only) and lists them in the command; a missing slug is skipped with a warning. Because the nearer list wins (S20 LS4), a game or product rule on wholesale is overridden by a tier's category or global rule; the parent cap keeps the tier at or below it, and the admin repeats a specific rule on a tier list to keep it lower.
- PX4. **Never below cost:** every tier row is at least cost plus its minimum margin (≥ $0.01, S20 LS2), guarded by S20 LP1 and the routing guard; the parent cap only lowers a price to a parent price that is itself guarded.
- PX5. **Diamond fixed prices:** S20 fixed prices on Diamond's list; the tiers page's helper lists the 20 packs merchants bought most in the last 30 days (delivered units) with each tier's price and margin, and opens S20's fixed price dialog for a pack. The fallback (S20 LP1) and the parent cap apply.
- PX6. **Price kind** (amends S20 AT4): an account whose effective list is a live level's list has price kind `wholesale` (shown "سعر الجملة"); the tier's name is shown beside it. Lists' names, rules and costs stay hidden. The tier table (PG2) shows the prices of three packs on every tier's list (decision 8).

### Manual tier
- MG1. **Grant** (`POST /api/admin/customers/:id/merchant/tier-grant`, re-authentication): a granted, not revoked merchant; `tier` (Silver, Gold or Diamond, with a live level, else `MERCHANT_TIER_UNAVAILABLE`), `endsAt` (1–90 days from now, Damascus end of day), `reason` (5–500). Refused when the tier is not above the earned tier (`MERCHANT_TIER_GRANT_NOT_HIGHER`) or a grant is open (`MERCHANT_TIER_GRANT_OPEN`). In one transaction: the grant row, the audit entry, then TR6 (the recomputation runs inline).
- MG2. The merchant sees the tier like an earned one (badge, prices, privileges, receipts, certificate), with no mark of a grant (decision 13). The admin sees "ممنوحة يدوياً حتى <date>" on the profile and the merchants list.
- MG3. **End early** (`POST /api/admin/customers/:id/merchant/tier-grant/end`, re-authentication, reason): `ended_at`, `ended_by_admin`, audit, TR6.
- MG4. **End job** (`merchants.tier-grants`, every 10 minutes): grants with `ends_at` past and `ended_at` null get `expired` and TR6 in one transaction per grant; the merchant falls to their earned tier with `merchant_level_changed`. Idempotent (the row lock and `ended_at`).
- MG5. **Reminder:** the same job sends Telegram `merchant_tier_grant_ending` once when `ends_at` is within 3 days (dedupe key `grant-ending:<grant>`).
- MG6. If the earned tier rises to or above the grant's tier, the grant keeps running without effect; TR6 sets `level_source = earned`.
- MG7. Archiving a tier's level ends its open grants (`tier_archived`) in the same transaction before the recomputations.

### Identity
- ID1. **Badge** (`TierBadge` in `packages/ui`): the tier's icon (Lucide: Bronze `Shield`, Silver `Medal`, Gold `Crown`, Diamond `Gem`) and name on a tier tint. Tier colour tokens (`tier-bronze`, `tier-silver`, `tier-gold`, `tier-diamond`, each with a text step for light and dark) join `brand/identity.md` in PR 2, measured for contrast (non-text ≥ 3 on green-900 and white; text AA). Starting values: Bronze `#B07A55`, Silver `#A9B4B2`, Gold `#B9A87A` (gold-400), Diamond `#8FD3C8`. Tier colours tint the badge, the tier card, the certificate and the sticker only; never buttons, prices or status (§2, §9).
- ID2. **Header and menu:** the merchant area's header and the account menu show the badge.
- ID3. **Tier card** on the dashboard (replaces S21's level card): a quiet gradient of two steps of the tier's hue, the tier name and badge, "منذ <date>" (`level_changed_at`, or the grant date of the merchant profile for Bronze), what the tier grants (from TS2), the progress bar (PG1), the keep line (TR7), and the savings (PG6); a link to the tier page.
- ID4. **Celebration:** on the first merchant-area visit with `celebrate_pending`, a full-screen sheet with the new badge, the tier's name, what it grants and one short motion (the mark's three strokes, then the badge; `prefers-reduced-motion` shows it still); "متابعة" calls `POST /api/merchant/tier/celebrated`. The S21 `merchant_level_changed` notification and email name the tier and what it grants.
- ID5. **Receipts and verification** (S21 PR2, VF2, BR1): a merchant's receipt (print and share link) and the verification page show under the shop name "تاجر <tier> معتمد من Vertex Digital" with the badge for Silver and up, "تاجر معتمد من Vertex Digital" for Bronze; the tier is the merchant's **current** effective tier when the page is rendered; a revoked merchant shows none. Thermal paper prints the icon and text in black.
- ID6. **Price list** (S21 PL2): the same line and badge in the header of the print page and the PNG (the api's Pango render draws the icon and the tier's colour).
- ID7. **Certificate:** `/merchant/certificate/print` (A4 landscape, browser print): the trade name, city and governorate, "تاجر <tier> معتمد" (Bronze: "تاجر معتمد"), since (ID3), the print date, the Vertex mark, and a QR of `https://digital.vertexmedia.pro/m/<certificate_code>`. The public page `/m/<code>`: the trade name, city, governorate and the current tier with "منذ"; for a revoked merchant "هذا المتجر لم يعد تاجراً معتمداً لدى Vertex Digital"; an unknown code shows the neutral not-found page (as VF3). Never a phone, address, price or email; `noindex`; 60 lookups a minute per IP; cached 30 seconds. The merchant may reissue the code (old prints stop resolving): 3 a day (`CERTIFICATE_REISSUE_LIMIT`), audited `merchant.certificate_reissued`.
- ID8. **Sticker:** on the tier page, "صورة للواجهة" draws in the browser (canvas) a square 1080 px and a story 1080 × 1920 px PNG: the badge, the trade name, "تاجر <tier> معتمد من Vertex Digital" (Bronze: without the tier), the certificate QR (`qrcode.react`), and the store's domain; downloaded or shared with the Web Share API. No server render.
- ID9. **Statement** (S21 ST2): the header shows the badge; a "فئتك هذا الشهر" block: the tier held at the month's end (or now for this month), net purchases, the savings (PG6), and the next tier with the amount that was missing. Print page and Excel ("الملخص" sheet) alike.

### Progress
- PG1. **Progress bar:** this month's net purchases against the next tier's threshold: "$720 من $1,000، باقي $280 للذهبي". At Diamond: "أعلى فئة" with the amount needed this month to keep it next month. The bar uses the 60° motif segments (§5).
- PG2. **Tier page** (`/merchant/tier`): the tier table, one row per tier: the threshold, the privileges of TS2, and the price of the merchant's three most-bought packs (delivered units in the last 90 days; with none, the three packs merchants bought most in 30 days) on each tier's list, read from current price rows; "أنت هنا" on the current tier. Below it the history (PG5) and the certificate and sticker actions.
- PG3. **Month-end reminder** (`merchants.tier-reminders`, the 25th at 10:00 Damascus): `tierReminder` per merchant: `reach` when this month is short of the next tier by at most 30% of its threshold ("ينقصك $X لتصل إلى الذهبي قبل نهاية الشهر"); `keep` when the earned tier came from the previous month only and this month is below its threshold ("اشترِ بـ $X قبل نهاية الشهر لتحتفظ بالذهبي في الشهر القادم"). `merchant_tier_reminder` (center, email, push), dedupe key `tier-reminder:<customer>:<month>`; respects the preference switch; test merchants included, frozen ones not.
- PG4. **Forecast:** from the 5th of the month, with this month above zero: `tierForecast` projects the month at the current daily pace. When the next threshold falls within the month: "بوتيرتك الحالية تصل إلى الذهبي نحو 22 نوفمبر"; otherwise "بوتيرتك الحالية تنهي الشهر عند نحو $X". Labelled as an estimate.
- PG5. **History:** the `merchant_tier_months` rows, newest first: month, net purchases, the tier held; the current month live on top.
- PG6. **Savings:** for this month's orders charged at a tier's list (Silver and up) and delivered in the month: Σ delivered units × (the wholesale price in force at the order's creation − the unit price paid), each order floored at zero; the wholesale price is the newest `product_prices` row of the wholesale list created at or before the order. "وفّرت فئتك هذا الشهر $12.40". Read live; Bronze and assigned lists show none.
- PG7. The keep date of TR7.

### Operational privileges
- OP1. **Deposit queue** (S03 panel queue): Sham Cash deposits of merchants whose tier has `deposit_priority` come first (then by submission time), with the badge; the Telegram card (S05) names the tier ("تاجر ذهبي"). The review flow and every check are unchanged.
- OP2. **Ticket queue** (S12): open tickets of customers whose tier has `support_priority` come first (then by `last_customer_message_at`), with the badge.
- OP3. **Reply promise:** the store's new-ticket and ticket pages show "نرد عادةً خلال ساعة" (or the tier's minutes) to merchants whose tier has `support_reply_minutes`.
- OP4. **Diamond contact:** merchants whose tier has `direct_contact` see on the tier card and the support pages a WhatsApp button (`https://wa.me/<number>`) and a Telegram button (`https://t.me/<username>`), each only when set in the merchant settings. Served by `GET /api/merchant/tier` only to those merchants; never in a public bundle.
- OP5. **Early access:** the admin sets `early_access_until = now + 24 hours` on a game or product when activating it or later (re-authentication, audited), and may end it early. While it is in the future the game or product is visible and buyable only by merchants whose effective tier has `early_access` (with a "وصول مبكر" chip); for every other account and the public cache it is hidden as S06's hidden products, and orders, checkouts, reservations, quick links and the cart refuse it as unavailable. Admin orders on behalf of a merchant follow that merchant; walk-in and owner-funded orders follow retail (hidden). Setting it sends `merchant_early_access` (center, push) once to merchants of those tiers who follow the game (S21 follows) or bought from it in 30 days (dedupe key `early-access:<game or product>:<customer>`).
- OP6. **Overdue tickets** (`support.overdue-tickets`, every 15 minutes): an `open` ticket of a customer with `support_reply_minutes` whose last customer message is older than the promise sends Telegram `ticket_overdue` once per waiting period (dedupe key `ticket-overdue:<ticket>:<last_customer_message_at>`).
- OP7. **Early access end** (`catalog.early-access-end`, every 5 minutes): for windows that ended since the last run, revalidates the store's catalog cache for the game; F42 alerts and S21 watch alerts then see the product as new. Idempotent.
- OP8. **Faster alerts** (amends S21 AL2–AL3, decision 11): the watch-alerts job runs every 15 minutes (:05, :20, :35, :50); merchants whose tier has `fast_alerts` are compared every run (dedupe key per quarter hour), the rest only at :05 (hourly, unchanged).
- RC1. **Receipt welcome line** (tiers with `receipt_welcome`): `merchant_receipt_settings.welcome_text`, 2–60 characters after trimming, no control characters, no URL, no run of 7 or more digits; printed under the shop name on receipts and the branded receipt link. Kept but not printed while the tier lacks the privilege. The admin may clear it (re-authentication, reason, audited `merchant.welcome_text_removed`), as the logo (S21 BR3).
- RC2. **Larger logo** (tiers with `receipt_large_logo`): the logo prints at twice the S21 size on 80 mm and A4 receipts and on the price list; 58 mm stays as is.

### Admin
- AD1. **Merchants list** (S20, S21): the level column becomes the tier badge, with "ممنوحة" for a granted tier; the filter takes the four tiers and "ممنوحة يدوياً".
- AD2. **Tiers page** (`/merchants/tiers`, replaces `/merchants/levels`): the four tiers as cards: Bronze (wholesale list link, settings), Silver, Gold, Diamond (threshold, list link with its parent, settings, merchant counts earned and granted); edit dialogs for thresholds and lists (TS1, `merchant_levels` rules) and settings (TS2's columns); the Diamond contact fields; the best-sellers helper (PX5).
- AD3. **Threshold preview** (`POST /api/admin/merchant-tiers/preview`, read only): proposed thresholds for the three tiers → per tier the merchants who would hold it (LV3 on the previous and this month), and the lists of who would rise and fall (at most 50 each, trade names), against today. "مع الذهبي عند $800 يصبح 4 تجار ذهبيين".
- AD4. **Report by tier** (`/reports/merchant-tiers`, a month): per tier: merchants holding it at the month's end (or now), net purchases, sales and profit of their orders (S13's measures, by the tier held when each order was placed: the order's list is the tier's list or wholesale), rises and falls in the month (`merchant_tier_changes`); test merchants excluded (S13). Excel export as S13.
- AD5. **Customer profile** (S20, S21): the tier card (effective and earned tier, source, since, this and last month's net purchases), "منح فئة" (MG1) and "إنهاء المنح" (MG3), the grant history, the welcome line with "حذف" (RC1).
- AD6. **Telegram:** TR8, MG5, OP6, and the daily summary line.

## Money flows
None new. A tier changes only which list's price a purchase is charged (S20 PO2), through the effective list; every purchase, checkout, reservation and refund posts S08's, S09's and S10's journals unchanged. A change of the effective list cancels unpaid reservations only (S20 AT3). Savings, forecasts, reminders, reports and the preview read the ledger and orders and never write them. Deposit limits change only the amounts accepted at creation (S03, S04).

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/merchant/tier` | Merchant | — | effective tier (never its source), since, kept-until, progress, forecast, savings, privileges, the Diamond contact when allowed | `NOT_MERCHANT` |
| `GET /api/merchant/tier/table` | Merchant | — | tiers with thresholds, privileges, three packs' prices per tier | `NOT_MERCHANT` |
| `GET /api/merchant/tier/history` | Merchant | — | months | `NOT_MERCHANT` |
| `POST /api/merchant/tier/celebrated` | Merchant | — | `204` | `NOT_MERCHANT` |
| `GET /api/merchant/certificate` · `POST /api/merchant/certificate/reissue` | Merchant · not frozen | — | the certificate data and URL | `CERTIFICATE_REISSUE_LIMIT`, `ACCOUNT_FROZEN` |
| `GET /api/certificates/:code` | Public, 60 / minute per IP, cached 30 s | — | trade name, city, governorate, tier, since, or `revoked` | `NOT_FOUND` |
| `PUT /api/merchant/receipt-settings` (S21, extended) | Merchant, not frozen | adds `welcomeText` | the settings | `VALIDATION_FAILED` |
| `GET /api/admin/merchant-tiers` | Admin | — | tiers, levels, settings, counts, the Diamond contact | — |
| `PUT /api/admin/merchant-tiers/:tier/level` | Admin, re-authentication | threshold, `priceListId` (creates, updates or archives the level) | the tier | `MERCHANT_TIER_TAKEN`, `MERCHANT_TIER_ORDER_INVALID`, `MERCHANT_TIER_LIST_INVALID`, `PRICE_LIST_ARCHIVED`, `VALIDATION_FAILED` |
| `PUT /api/admin/merchant-tiers/:tier/settings` | Admin, re-authentication | TS2's fields | the settings | `VALIDATION_FAILED` |
| `POST /api/admin/merchant-tiers/preview` | Admin | three thresholds | AD3 | `VALIDATION_FAILED` |
| `GET /api/admin/merchant-tiers/best-sellers` | Admin | — | PX5 | — |
| `POST /api/admin/customers/:id/merchant/tier-grant` · `/end` | Admin, re-authentication | MG1 · `{ reason }` | the grant | `MERCHANT_TIER_UNAVAILABLE`, `MERCHANT_TIER_GRANT_NOT_HIGHER`, `MERCHANT_TIER_GRANT_OPEN`, `NOT_MERCHANT`, `NOT_FOUND` |
| `DELETE /api/admin/customers/:id/merchant/welcome-text` | Admin, re-authentication | `{ reason }` | `204` | `NOT_FOUND` |
| `PUT /api/admin/catalog/games/:id/early-access` · `products/:id/early-access` | Admin, re-authentication | `{ on: boolean }` | the game or product | `NOT_FOUND` |
| `GET /api/admin/reports/merchant-tiers` · `/export` | Admin | `month` | AD4 · `.xlsx` | `VALIDATION_FAILED` |
| `PUT /api/admin/merchant-settings` (S20, extended) | Admin, re-authentication | adds the Diamond contact; drops the deposit and check fields | the settings | `VALIDATION_FAILED` |

S21's `/api/admin/merchant-levels` routes are replaced by the tiers routes (the panel is their only client). S20's `GET /api/admin/merchants` and `GET /api/admin/customers/:id`, the deposit and ticket queues gain the tier. The OpenAPI document and the admin client are regenerated.

## Jobs and integrations
- `merchants.level` (S21, extended to TR6) and `merchants.level-schedule` (the 1st 00:10 Damascus): the schedule also writes `merchant_tier_months` for the month just ended, after each merchant's recomputation (on conflict do nothing).
- `merchants.tier-grants` (every 10 minutes): MG4, MG5.
- `merchants.tier-reminders` (the 25th, 10:00 Damascus): PG3.
- `merchants.watch-alerts` (S21): every 15 minutes, OP8.
- `support.overdue-tickets` (every 15 minutes): OP6.
- `catalog.early-access-end` (every 5 minutes): OP7.
- Email templates: `merchant_tier_reminder`; `merchant_level_changed` updated. Push per S15 for `merchant_tier_reminder` and `merchant_early_access`.
- Telegram: `merchant_tier_changed`, `merchant_tier_grant_ending`, `ticket_overdue`; the daily summary line.
- The price list PNG (api, sharp and Pango) draws the badge. The certificate and sticker are drawn by the browser.
- No supplier, chain or payment call beyond S21's player checks.

## Screens

### Store (RTL, phone first; the tier page and certificate also at tablet and desktop)
- **Merchant area header and account menu:** the badge (ID2).
- **Dashboard** (`/merchant`): the tier card (ID3) in place of the level card; the celebration sheet on the first visit after a rise (ID4).
- **Tier page** (`/merchant/tier`): the tier card at the top, the tier table (PG2) as cards at phone width and a table from tablet, the forecast, the history, "اطبع شهادة التاجر المعتمد", "صورة للواجهة" (ID8), and the Diamond contact (OP4). Loading skeletons; empty history shows "يبدأ السجل من هذا الشهر".
- **Certificate print** (`/merchant/certificate/print`): ID7, with the on-screen print bar (S21 PR1).
- **Certificate page** (`/m/[code]`): phone first, server-rendered, `noindex`.
- **Receipt settings** (`/merchant/receipt`, S21): the welcome line field with its counter and the live preview, shown disabled with "متاح من الفئة الفضية" below Silver.
- **Receipts, verification, price list, statement:** ID5, ID6, ID9; RC1, RC2.
- **Support** (S12): the reply promise (OP3) and the Diamond contact (OP4).
- **Games and packs:** the "وصول مبكر" chip for early-access merchants (OP5).

### Admin
- **Tiers** (`/merchants/tiers`): AD2, AD3 (the preview as a side panel with the counts and the movers), PX5.
- **Merchants** (`/merchants`): AD1.
- **Customer profile:** AD5.
- **Deposit queue and ticket queue:** the badge and the priority order (OP1, OP2).
- **Catalog game and product pages:** "وصول مبكر 24 ساعة" on activation and a running window's end time with "إنهاء الآن" (OP5).
- **Reports:** "حسب فئة التاجر" (AD4).
- **Settings → merchants:** the Diamond contact; the deposit and check fields move to the tiers page.

## Audit and notifications
- Audit (in the transaction of the change): `merchant_tier.level_changed` (a tier's threshold or list, before and after), `merchant_tier.settings_changed` (before and after), `merchant.level_changed` (S21, gains the tiers and the source), `merchant.tier_granted`, `merchant.tier_grant_ended` (reason), `merchant.certificate_reissued`, `merchant.welcome_text_removed` (reason), `catalog.early_access_set`, `catalog.early_access_ended`, `merchant_settings.changed` (gains the Diamond contact). The merchant's own welcome line is not audited (S21's preferences rule).
- Customer notifications (templates and preference switches, on by default): `merchant_level_changed` (center, email, push; the tier and what it grants), `merchant_tier_reminder` (center, email, push), `merchant_early_access` (center, push). Emails never carry a list's name or a cost.
- Telegram (admin): `merchant_tier_changed`, `merchant_tier_grant_ending`, `ticket_overdue`; the daily summary.

## Abuse and fraud
| Abuse | Control |
|---|---|
| Buying to reach a tier, then refunding | Net purchases (S21 LV2, Q26): refunds count against the month the order was paid; TR6 lowers the tier at once |
| Buying at month end to hold a tier two months | Real purchases at real margins; the hold is the published grace (TR7); every tier list is guarded (PX4) |
| A tier price below cost after a cost rise | Each row is cost + its minimum margin (≥ $0.01); the margin guard pauses unprofitable routes per list (S20 PO1) |
| A tier list dearer than the tier below after rule edits | The parent cap (PX2) |
| The tier table used to learn costs | Only three packs' prices per tier, never rules, costs or list names; merchants are admin-approved |
| A forged certificate or sticker | The QR resolves on our domain to the live tier; revoked or reissued codes show "لم يعد معتمداً" or not found; 128-bit codes, rate limit, `noindex` |
| Scraping certificate pages for the merchant directory | 60 lookups a minute per IP plus nginx limits; random codes; only the trade name, city and tier |
| A welcome line used for scam contacts | No URLs or long digit runs; only approved merchants; the admin clears it (audited) and can revoke |
| Higher deposit limits for laundering | Limits only from the tier's earned purchases or the admin's grant; S03/S04 fraud checks, review and Telegram's $100 ceiling unchanged; per-customer overrides can lower them |
| Larger player-check quotas as a name lookup | Tier quotas, per-IP limit, the supplier's daily quota and S09's cache unchanged |
| A grant left on by mistake | At most 90 days, a Telegram reminder 3 days before, the end job, the profile shows it |
| Early-access packs leaking to retail | Hidden from the public cache and from every non-eligible account's private routes and purchase paths; tests per path |
| Diamond contact numbers leaking | Served only to Diamond merchants by the private route |
| A race between a purchase and a tier change | TR6 takes the customer `FOR UPDATE`; purchases take it `FOR SHARE` (S20 AT3): a purchase sees the old or the new list |

## Edge cases
1. A merchant on an assigned list (for example cost) reaches Gold: badge and privileges Gold; prices stay on the assigned list; no reservation is cancelled; no savings shown.
2. The admin lowers Gold's threshold below a merchant's purchases: the requeue upgrades them at once with the celebration and notification.
3. The admin archives the Silver level while Gold exists: allowed (the chain rule is checked when a level is created or its list changed); Silver merchants fall to Bronze. Silver's list stays live, since Gold's list names it as parent (S20 LS5 refuses its archive), so it is still repriced and Gold keeps its cap against it. The tiers page notes the gap.
4. A grant of Gold to a merchant who earns Diamond mid-grant: Diamond (earned) wins; when the grant expires nothing changes.
5. A grant of Diamond to a Silver merchant who earns Gold during it: Diamond until `ends_at`, then Gold (earned) with a notification of the fall.
6. A grant expiring while a purchase is in flight: serialized by the customer lock; the purchase is charged the list in force when it took the lock.
7. A revoked merchant with an open grant: the grant ends `merchant_revoked`; a re-grant of merchant status recomputes without it.
8. A tier fall with awaiting-balance reservations: cancelled with `price_list_changed` (S20 AT3), as any list change.
9. A bulk list of 100 lines checked as Gold, the merchant falls to Silver before paying: refused with `VALIDATION_FAILED` naming the 50-line limit.
10. A code order of 80 units for a Gold merchant on an offer limited to 50: QT3 skips that route; with none left, S08's refund path.
11. A merchant with no purchases for three months: Bronze; the history shows the months with zero; no reminder unless within 30% of Silver.
12. The 25th reminder for a merchant already at Diamond who has reached Diamond's threshold this month: none.
13. An early-access game: a Bronze merchant opening its direct link sees not found until the window ends; a Gold merchant buys it; at the end the public cache shows it within 5 minutes.
14. Early access set on a product of a game not in early access: only that product is hidden from the others.
15. Ending early access early: visible to all at once and the cache revalidated by the same transaction's outbox.
16. The certificate of a frozen merchant: still shows the tier (freezing is internal); a revoked one shows "لم يعد معتمداً".
17. The verification page of an order placed when the merchant was Gold, viewed when they are Silver: shows Silver (the current tier, ID5).
18. Savings for an order delivered this month but created last month: counted this month (delivered in the month), against the wholesale price in force at its creation.
19. The month's first day: `merchant_tier_months` written by the schedule after the recomputations; a schedule that runs twice writes nothing new.
20. Production on deploy day: no level exists, every merchant is Bronze; the setup command creates the tiers; merchants who already passed $300 last month are upgraded by the requeue it triggers.
21. A test merchant: everything works; excluded from the report (S13).

## Open questions
None blocking. The starter thresholds and the defaults listed after the owner decisions are the spec's choices and editable in the panel.

## Acceptance
- End-to-end check (fake supplier, `pnpm db:seed-local`, which runs the setup command; a merchant approved as in S20):
  1. The panel's tiers page shows Bronze on "البرونزية" and Silver, Gold, Diamond at $300, $1,000 and $3,000 on their chained lists. The price matrix shows 60 UC at 0.94, 0.93, 0.92, 0.91 (fake cost 0.887) and a store card at the same price on every tier.
  2. As a new merchant: the header shows the Bronze badge; the tier card shows "$0 من $300"; the tier page shows the table with three packs' prices per tier.
  3. Buy $310 of packs: the celebration sheet appears once, the badge is Silver, the email arrives, prices drop; the receipt print and its QR page show "تاجر فضي معتمد من Vertex Digital".
  4. Set a welcome line; print an 80 mm receipt: it shows the line. Print the certificate and open its QR: the trade name and Silver. Download the sticker.
  5. In the panel preview Gold at $300: the merchant is listed as rising. Grant the merchant Diamond for 2 days: Telegram alert, Diamond badge, Diamond prices, the contact buttons, 100 bulk lines; end the grant: back to Silver with a notification and a Telegram alert.
  6. Mark a new pack "وصول مبكر": a Gold-granted merchant sees and buys it with the chip; a customer and a Bronze merchant do not; end it: everyone sees it.
  7. As the Gold merchant open a ticket and wait past the promise (lowered to 15 minutes): the Telegram overdue alert; the ticket is first in the queue. Create a Sham Cash deposit: first in the queue with the badge.
  8. Run the reminder job on a date set to the 25th: the merchant within 30% of the next tier gets the reminder. Run the monthly schedule: the history shows last month. The statement shows the tier block; the report by tier shows the counts, sales, profit and the rises and falls.
- Tests:
  - Unit (contracts, 100%): `effectiveLevel`, `tierProgress`, `tierKeptUntil`, `tierForecast`, `tierReminder`, `parentCappedPrice`, the welcome-line rules, the schemas; S20's `listPrice` with the parent cap.
  - db: the migration (levels archived, tier column, settings seeded with Bronze copied from merchant settings, certificate codes backfilled unique, widened quantity checks), the grants guard and its one-open index, append-only changes and months, repricing parents before children and the parent cap under concurrent rule changes, TR6 in parallel with a purchase.
  - API: every endpoint's success, 401, `NOT_MERCHANT`, 403 across customer and admin, other merchants' data; tier level rules (order, chain, taken); grants (not higher, open, unavailable, end, expiry); privileges per tier (deposit limits at creation, check quota, bulk lines, code quantity, falling between check and pay); early access hidden on every path (public catalog, private prices, order, checkout, reservation, quick link, cart, admin walk-in); the Diamond contact only for Diamond; the certificate page (revoked, reissued, unknown, rate limit, no personal data); the jobs twice (grants, reminders, overdue tickets, early-access end, faster alerts, the monthly snapshot); the preview's counts; the report.
  - E2E and RTL screenshots: the header badge per tier, the tier card, the celebration, the tier page, the receipt and verification with the badge, the certificate print and page, the receipt settings with the welcome line, the panel's tiers page with the preview, the profile's grant dialog, the merchants filter, the report.
- Delivery plan (three PRs, then one deploy and the setup command):
  - PR 1 **Tiers and prices** (decisions 1–5, 9, 10, 13, 14): the enum and the levels' tier, tier settings and their privileges (deposit limits, check quota, quantities with the widened checks), effective level and grants with the end job, tier changes and months, the parent cap and repricing order, the price kind, the setup command and the seed, the panel's tiers page with the preview, the profile's grant, the merchants column and filter, the Telegram alerts.
  - PR 2 **Identity and progress** (decisions 6–8): tier tokens in `brand/identity.md` and `TierBadge`, header, menu, tier card, celebration, tier page with the table, forecast, history and savings, the reminder job, the badge on receipts, verification, price list and statement, the certificate with its public page and reissue, the sticker, the welcome line and the larger logo.
  - PR 3 **Operations and reports** (decisions 11, 12, 15): deposit and ticket queue priority, the reply promise and the overdue job, the Diamond contact, early access with its end job and notification, faster alerts, the Diamond best-sellers helper, the report by tier.
