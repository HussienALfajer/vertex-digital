# TASKS — S06 Catalog and pricing

Spec: `docs/specs/S06-catalog-and-pricing.md` (F08, F10; ADRs 0003, 0005, 0008, 0011, 0012, 0016, 0020). Two PRs, as the spec's implementation notes suggest; each leaves `main` green and runs in its own session.

## PR 1 — Contracts, db, `catalog` and `pricing` API modules, bridge · Opus 5.5 `high`
- [ ] Contracts `catalog.ts`: `CATALOG_STATUSES`, `PRODUCT_KINDS`, `INPUT_FIELD_TYPES`, `PRODUCT_AVAILABILITIES` (CT9), `slugSchema`, `accentColorSchema`, category / game / input field / product schemas (entity, create, update, list query, page, detail), `reorderSchema`, `catalogImageSchema`, `contrastRatio`, `ACCENT_MIN_CONTRAST`; unit tests (100%)
- [ ] Contracts `pricing.ts`: `MARGIN_SCOPES`, rule values / rule / set / preview schemas; pure `priceFromCost`, `isProfitable`, `resolveMarginRule`, `savings` (PR1–PR8); unit tests (100%, every boundary of the spec)
- [ ] Contracts: error codes `SLUG_TAKEN`, `NAME_TAKEN`, `FIELD_KEY_TAKEN`, `CATALOG_INCOMPLETE`, `CATALOG_NOT_EMPTY`, `PARENT_ARCHIVED`, `ACCENT_CONTRAST_TOO_LOW`, `IMAGE_INVALID`, `CATALOG_LIMIT_REACHED`, `GLOBAL_RULE_REQUIRED` with their Arabic admin text; audit entity types and actions with admin labels
- [ ] Db (`/db-migration`): `catalog_categories`, `catalog_games`, `catalog_input_fields`, `catalog_products`, `margin_rules` (enums, checks, partial unique indexes, sort indexes); `stored_file_kind` gains `catalog_image`; seeds (three categories, the global rule); `TABLE_OWNERS`; tests (indexes, checks, seeds, file kind)
- [ ] Api `files`: `catalog_image` preparation (PNG/JPEG/WebP, 5 MB, 25 MP, fit 1600, WebP, metadata stripped)
- [ ] Api `catalog` module: image upload and the public image route; categories, games, fields, products (CRUD, reorder, archive/restore, CT1–CT10); audit in each transaction; `no-store`; rate limit on upload; `test/catalog.test.ts` (every route, 401/403, every error code, concurrency: same name, parallel reorders)
- [ ] Api `pricing` module: rules list, set (re-authentication, upsert under lock), archive (global refused), preview (rule or draft, SYP via `RatesService.current()`, savings); `test/pricing.test.ts` (every route, re-authentication, parallel sets leave one live rule)
- [ ] nginx: image route (immutable cache) and upload size, if the existing zones do not cover them
- [ ] Bridge: build, OpenAPI export, admin client
- [ ] Wiring checklist, docs (`docs/architecture.md` `catalog`, `pricing`, `files` rows and "built so far", folder `CLAUDE.md` if needed)
- [ ] Checks, reviewer, acceptance (endpoints summary), PR with auto-merge

## PR 2 — Admin screens and E2E · Opus 5.5 `high`
- [ ] Admin `features/catalog/`: `/catalog` (category tabs, game cards, filters, search, move up/down, empty, loading, error), categories dialog, `/catalog/games/new` and `/catalog/games/$id` (tabs: data with uploads and live contrast, input fields, products with archived filter, pricing)
- [ ] Admin `features/pricing/`: `/pricing` (global, category, overrides, rule form with live preview, calculator, re-authentication)
- [ ] Navigation "الكتالوج" and "التسعير"; i18n (namespaces, errors, audit labels)
- [ ] E2E: catalog and pricing flows and RTL screenshots (light and dark), re-authentication dialog
- [ ] Wiring checklist, docs (`docs/ROADMAP.md` S06 done, `wiring.md` patterns)
- [ ] Checks, reviewer, owner acceptance (spec steps 1–10), PR with auto-merge
