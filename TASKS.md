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
- [ ] `v1-scope.md` F33, S21, S23: removed by the owner on 2026-10-30

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
- [ ] Specs, architecture, folder CLAUDE.md, commands table, ROADMAP
- [ ] RTL screenshots (dark, light, phone, desktop) for every changed screen
- [ ] `pnpm verify`, `reviewer`, fixes
- [ ] Push, owner presses Create PR, auto-merge, wait for the merge

## Local session (cannot run in the cloud)
- [ ] Deploy `main` (the migration runs through the deploy, `docs/deployment.md`)
- [ ] Check production: home, sale mode, game page star, merchant prices, price list (PDF, image), statement
- [ ] Browser test against the full local store (`pnpm db:seed-local`)
- [ ] Deploy log line in a docs PR

## E2E (in progress)
- [ ] `merchant-counter.spec.ts`: sale mode (USD first, slide, End, unavailable last, touch keys), pinned star and "ألعابك"
- [ ] `merchant-tools.spec.ts`, `merchant-tier.spec.ts`: no "أدوات التاجر" in the menu; prices table, picker, `?game=`
- [ ] `merchant-documents.spec.ts`: price list (pages, image select, rate refusal), statement screen
- [ ] Home and category pages: categories first, new card, counts
