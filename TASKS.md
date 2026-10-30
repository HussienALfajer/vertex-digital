# TASKS — Merchant tools overhaul (owner, 2026-10-30)

Branch: `claude/merchant-tools-overhaul-eto2vk` (the cloud session's branch; the owner named `feat/merchant-tools-overhaul`). One PR.

## 1. USD leads
- [x] `sale-figures.ts`: USD main, SYP after "≈"; profit from integer USD units; USD alone without a rate; tests
- [x] `sale-counter.tsx`: cards, confirmation and profit badge in the new order
- [x] Confirmation's selling price starts in USD; an untouched price is never saved as `manual`
- [x] `selling-price-field.tsx` bug: untouched → the API's ready amount in the other currency; typed → cleared on a currency change; regression test

## 2. Slide to confirm
- [x] `SlideToPay` in the sale confirmation (`key` remount, `autoFocus`, sending state, retry), disabled while checking, until an unfound id is confirmed, when frozen or stopped
- [x] `sendAttempt`, idempotency, `PRICE_CHANGED`, terms sheet, sale write after the order unchanged
- [x] Shortcuts help: `End` replaces `Enter`

## 3. "ألعابك" pinned games
- [x] `/db-migration`: `merchant_pinned_games` (additive), max 20, explicit position
- [x] Contracts schema, `GET /api/merchant/pinned-games`, `PUT` (not frozen), tests
- [x] Star on game cards and the game page (merchants only, browser-loaded, no layout shift, budgets)
- [x] "ترتيب" dialog with move up/down
- [x] Row: pinned in order, then suggestions (followed games, 30-day units) with "مقترحة" up to 10

## 4. Categories first
- [x] Home order: search, categories, banners, "اشحن مجددًا", game rows
- [x] Sale mode: search, categories, "ألعابك", banners, game rows; quick buy hidden, banners shown
- [x] "تصفّح حسب الفئة"; new `CategoryCard` (3:2, sand border, light green surface, chevron, compact); 6 columns desktop, scroll on phone
- [x] Clean fallback (no cropped collage); "147 عنصرًا" pluralized

## 5. Delete bulk orders
- [x] Store: `/merchant/bulk` → `/merchant` redirect, sidebar link, `bulk-page.tsx`, requests, messages, E2E
- [x] API: `POST /api/merchant/bulk/check`, service code, contracts, tests; OpenAPI + admin client
- [x] Past `source: bulk` rows stay valid; new code never creates it; keep the merchant player-check quota
- [x] S23 tier privileges and the 50-line limit callers: report
- [x] `v1-scope.md` F33, S21, S23: removed by the owner on 2026-10-30

## 6. Selling prices
- [x] Shared store game picker (bar + dialog: search AR/EN, arrows + Enter, "ألعابك", category chips, cover grid; single and multiple)
- [x] `?game=` in the URL
- [x] Compact table with sticky header, filter chips with counts; cards on phone
- [x] Markup settings collapsed to one line, opening the same form

## 7. Price list
- [x] Two columns, sticky settings, multi-select picker with quick choices; default "ألعابك", else top 10 by sales; API empty selection matches (PL1)
- [x] A4 page preview with previous/next, page and pack counts
- [x] PDF button + one image selector and one download; 20/hour refusal shown
- [x] Document: header, tier line, covers, alternating rows, USD before SYP, footer
- [x] API PNG renderer to match, Arabic shaping

## 8. Statement
- [x] Screen split from the print/Excel (unchanged)
- [x] Month navigation, summary sentence, four cards, tier progress
- [x] "مبيعاتك وربحك" in API and contracts (estimated)
- [x] Movements: chips, search, grouped by day, icons, clear titles, order links, running balance, month-name dates

## 9. Account menu
- [x] Remove "أدوات التاجر" and its tier read; `merchant-card.tsx` still leads to `/merchant`

## 10. Sale mode polish
- [x] Unavailable packs last; 1–9 for available packs only; no key numbers on touch
- [x] Each merchant page's title is its section

## Finish
- [x] Specs, architecture, folder CLAUDE.md, commands table, ROADMAP
- [x] RTL screenshots (dark, light, phone, desktop) for every changed screen
- [x] `pnpm verify`, `reviewer`, fixes
- [x] Push the branch
- [ ] The owner presses **Create PR** in the session; then auto-merge (merge commit) and the wait for the merge

## Local session (cannot run in the cloud)
- [ ] Deploy `main` once the PR has merged (migration 0109 runs through the deploy, `docs/deployment.md`; no new secret, no `provision.sh` change)
- [ ] Check production without real money: the home page (categories first, the new cards), a merchant's sale mode (USD first, the slide, the star and "ألعابك", "ترتيب"), `/merchant/bulk` → `/merchant`, the selling prices (picker, `?game=`, chips), the price list (A4 pages, PDF, one image), the statement screen, the account menu without "أدوات التاجر"
- [ ] The owner uploads the six category images in the panel ("إدارة الفئات")
- [ ] Browser test against the full local store (`pnpm db:seed-local`)
- [ ] Deploy log line in a docs PR

## E2E
- [x] `merchant-counter.spec.ts`: sale mode (USD first, slide, End, unavailable last, touch keys), pinned star and "ألعابك"
- [x] `merchant-tools.spec.ts`, `merchant-tier.spec.ts`: no "أدوات التاجر" in the menu; prices table, picker, `?game=`
- [x] `merchant-documents.spec.ts`: price list (pages, image select, rate refusal), statement screen
- [x] Home and category pages: categories first, new card, counts
