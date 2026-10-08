# TASKS — S06 Catalog and pricing

Spec: `docs/specs/S06-catalog-and-pricing.md` (F08, F10; ADRs 0003, 0005, 0008, 0011, 0012, 0016, 0020). Two PRs, as the spec's implementation notes suggest; each leaves `main` green and runs in its own session.

## PR 1 — Contracts, db, `catalog` and `pricing` API modules, bridge · Opus 5.5 `high`
- [x] Contracts `catalog.ts`: `CATALOG_STATUSES`, `PRODUCT_KINDS`, `INPUT_FIELD_TYPES`, `PRODUCT_AVAILABILITIES` (CT9), `slugSchema`, `accentColorSchema`, category / game / input field / product schemas (entity, create, update, list query, page, detail), `reorderSchema`, `catalogImageSchema`, `contrastRatio`, `ACCENT_MIN_CONTRAST`; unit tests (100%)
- [x] Contracts `pricing.ts`: `MARGIN_SCOPES`, rule values / rule / set / preview schemas; pure `priceFromCost`, `isProfitable`, `resolveMarginRule`, `savings` (PR1–PR8); unit tests (100%, every boundary of the spec)
- [x] Contracts: error codes `SLUG_TAKEN`, `NAME_TAKEN`, `FIELD_KEY_TAKEN`, `CATALOG_INCOMPLETE`, `CATALOG_NOT_EMPTY`, `PARENT_ARCHIVED`, `ACCENT_CONTRAST_TOO_LOW`, `IMAGE_INVALID`, `CATALOG_LIMIT_REACHED`, `GLOBAL_RULE_REQUIRED` with their Arabic admin text; audit entity types and actions with admin labels
- [x] Db (`/db-migration`): `catalog_categories`, `catalog_games`, `catalog_input_fields`, `catalog_products`, `margin_rules` (enums, checks, partial unique indexes, sort indexes); `stored_file_kind` gains `catalog_image`; seeds (three categories, the global rule); `TABLE_OWNERS`; tests (indexes, checks, seeds, file kind)
- [x] Api `files`: `catalog_image` preparation (PNG/JPEG/WebP, 5 MB, 25 MP, fit 1600, WebP, metadata stripped)
- [x] Api `catalog` module: image upload and the public image route; categories, games, fields, products (CRUD, reorder, archive/restore, CT1–CT10); audit in each transaction; `no-store`; rate limit on upload; `test/catalog.test.ts` (every route, 401/403, every error code, concurrency: same name, parallel reorders)
- [x] Api `pricing` module: rules list, set (re-authentication, upsert under lock), archive (global refused), preview (rule or draft, SYP via `RatesService.current()`, savings); `test/pricing.test.ts` (every route, re-authentication, parallel sets leave one live rule)
- [x] nginx: image route (immutable cache) and upload size, if the existing zones do not cover them
- [x] Bridge: build, OpenAPI export, admin client
- [x] Wiring checklist, docs (`docs/architecture.md` `catalog`, `pricing`, `files` rows and "built so far", folder `CLAUDE.md`, `docs/deployment.md`, spec details settled, `wiring.md` patterns)
- [x] Checks (lint, typecheck, test, build, e2e, drift: all passed and recorded), reviewer (no blocking findings), owner acceptance (2026-10-08), PR with auto-merge

## PR 2 — Admin screens and E2E · Opus 5.5 `high`
- [x] Admin `features/catalog/`: `/catalog` (category tabs, game cards, filters, search, move up/down, empty, loading, error), categories dialog, `/catalog/games/new` and `/catalog/games/$id` (tabs: data with uploads and live contrast, input fields, products with archived filter, pricing)
- [x] Admin `features/pricing/`: `/pricing` (global, category, overrides, rule form with live preview, calculator, re-authentication)
- [x] Navigation "الكتالوج" and "التسعير"; i18n (namespaces, errors, audit labels)
- [x] E2E: catalog and pricing flows and RTL screenshots (light and dark), re-authentication dialog
- [x] Wiring checklist, docs (`docs/ROADMAP.md` S06 done, `wiring.md` patterns)
- [x] Checks (lint, typecheck, test, build, e2e: all passed and recorded), reviewer (one blocking finding, fixed), owner acceptance (2026-10-08), PR with auto-merge
