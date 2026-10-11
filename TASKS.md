# TASKS — S14 Content and live activity

Spec: `docs/specs/S14-content-and-live-activity.md` (F21, F25; ADRs 0002, 0008, 0011, 0012, 0015, 0016, 0022, 0026, 0028). Two PRs (the spec's PRs 2 and 3 merged into one, owner 2026-10-11); each leaves `main` green.

## PR 1 — Contracts, db, api (`feat/s14-content-api`)
- [x] Contracts `content.ts` (new, re-exported): `CONTENT_PAGES`, `ANNOUNCEMENT_TONES`, limits and activity constants, `linkPathSchema` (MD4), `richTextSchema(max)` and `parseRichText` (MD1–MD3, MD5), `bannerState`/`announcementState` (BN4), `activityVisible` (LA3), `floorToFiveMinutes` (LA4), `formatDeliveryDuration` (LA5); request and response schemas with `.meta({ id })`; unit tests at 100%
- [x] Contracts extended: error codes `CONTENT_STALE`, `CONTENT_UNCHANGED`, `CONTENT_LIMIT_REACHED` with Arabic text in both catalogs; audit entity types and actions with admin labels; customer profile `termsVersion`/`privacyVersion`
- [x] Db (`/db-migration`): enums `content_page`, `announcement_tone`; `content_page_drafts` (seeded), `content_page_versions` and `faq_publications` (append-only), `faq_sections`, `faq_items`, `banners`, `announcements` (one-enabled index, checks), `content_settings` (seeded); `customers.terms_version_id`/`privacy_version_id`; activity index on `orders`; tests of checks, triggers, grants, seeds
- [x] Api `content` module: public controller (site, page, FAQ, activity; `Cache-Control: public, max-age=60`), admin controller (pages, FAQ, banners with image upload, announcements, settings, activity preview) with `StoreRevalidateInterceptor`; audit in every transaction
- [x] Api sign-up stores the newest terms and privacy versions (TA2); S12 customer profile returns them (TA3)
- [x] Store revalidation route expires the `content` tag (CP1); `lib/cache-tags` gains `content`
- [x] `TABLE_OWNERS`, `app.module.ts`; `test/content.test.ts` (every route: success, 401, 403, each error code, public routes leak nothing, activity rules LA1–LA6, concurrent announcement enables, sign-up versions)
- [x] Bridge: build, OpenAPI export, admin client; mocks follow changed shapes
- [x] Wiring checklist, docs (`docs/architecture.md` modules, folder `CLAUDE.md` files, spec "Settled in implementation")
- [x] Checks (lint, typecheck, build, e2e, drift passed and recorded on c2ed6653ee10; tests passed but the known `reconciliation.test.ts` E3 case that fails against the local test database, on main too), reviewer (no blocking issues), owner acceptance (2026-10-11), PR with auto-merge

## PR 2 — RichText, admin screens and store (`feat/s14-content-ui`)
- [x] `packages/ui` `RichText` (server-compatible, parser nodes only) with tests
- [x] Admin `features/content/`: pages list, page editor (problems by line, preview at phone and desktop widths, Ctrl+S, unsaved guard, versions, stale dialog), FAQ (sections, questions, order, archive, publish bar), banners (upload with 2:1 guide, schedule, enable, order), announcements (replace confirm, live preview), activity (switch, count, preview); navigation "المحتوى"; i18n keys
- [x] Admin customer profile line (TA3)
- [x] Store cached content reads (`content` tag, 60 s), failure never cached
- [x] Store announcement bar with dismissal (no flash, inline script), footer links, home banner carousel, activity cards (home and game page), `/faq`, `/terms`, `/privacy`, `/refund`, `/about`, sign-up sentence, support callout, sitemap; i18n keys
- [x] Store unit tests (relative time and duration texts, dismissal key logic)
- [x] E2E: admin flows and screenshots (light and dark) on a content mock; store flows and screenshots (phone and desktop, dark and light); performance budgets (SL5)
- [x] Wiring checklist, docs (`docs/ROADMAP.md` S14 done, `wiring.md` patterns, spec "Settled in implementation")
- [x] Checks (lint, typecheck, build, e2e recorded on dca945a0c589; tests passed but the known E3 case in `packages/db/src/reconciliation/reconciliation.test.ts`, failing on main too), reviewer (one blocking finding, fixed: the carousel scrolled the page), owner acceptance (2026-10-11), PR with auto-merge
