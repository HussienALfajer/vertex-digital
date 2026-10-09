/*
 * The tags of the store's cached reads (ADR 0002). The worker's `store.revalidate` job calls
 * `POST /_internal/revalidate`, which expires them when what the public catalog routes return
 * changes (S09 rule SF4).
 */

/** The storefront, the game pages and the sitemap. */
export const CATALOG_TAG = 'catalog';
