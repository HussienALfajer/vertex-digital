# TASKS — Store speed, state and navigation overhaul (owner, 2026-10-30)

## PR 1 `fix/store-speed-and-state`
- [x] nginx: catalog images from disk in the `vdimage` zone (`proxy_cache` cannot keep X-Accel answers; why in the site's comment); customer images in `vdimage`; the logo and photo's missing internal locations
- [x] API: image route out of the per-address throttler
- [x] `CatalogPicture`: retry, branded fallback, first row eager, plain `?w=160` covers
- [x] Brotli in `provision.sh`; precompressed static files in `deploy.sh`
- [x] Header sign-up in the cached HTML (`GET /api/content/site`), no waterfall
- [x] `FreshOnShow` on every listed form; bulk's double payment fixed
- [x] Typed input: buy box per game, sign-in draft taken once, merchant application, terms in a dialog, sign-up, ticket, POS, deposit network, prices dialog
- [x] Storefront read: one array parameter, grouped status, reads together
- [x] First load: the theme switch's tooltip out (about 30 KB of Base UI and Floating UI)
- [x] `pnpm verify`, reviewer and its findings (in-flight writes, POS and draft clean-up, the shop photo's upload location)

## PR 2 `feat/store-navigation-and-home`
- [x] Spec, roadmap
- [x] `BackLink` on inner pages
- [x] Phone bottom navigation
- [x] Category image (migration, admin upload, contract, OpenAPI)
- [x] New home page, `/categories/[slug]`, sitemap
- [x] `pnpm verify`, reviewer
