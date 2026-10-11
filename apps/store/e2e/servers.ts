/*
 * The servers of the E2E run (playwright.config.ts): the store on 4001, the catalog the store's
 * server components read (e2e/catalog-server.mjs), a second store whose catalog is empty, and a
 * third with published content (S14).
 */

/** The catalog the store's server components read (e2e/catalog-server.mjs). */
export const CATALOG_PORT = 4002;

/** A second store whose catalog has no games yet, for the home page's empty state. */
export const EMPTY_STORE_URL = 'http://127.0.0.1:4003';

/** A third store whose content routes answer published content (S14: e2e/content.spec.ts). */
export const CONTENT_STORE_URL = 'http://127.0.0.1:4004';

/** The revalidation route's secret in E2E (e2e/catalog.spec.ts calls the route with it). */
export const E2E_REVALIDATE_SECRET = 'r'.repeat(48);
