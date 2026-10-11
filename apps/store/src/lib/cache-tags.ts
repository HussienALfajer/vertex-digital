/*
 * The tags of the store's cached reads (ADR 0002). The worker's `store.revalidate` job calls
 * `POST /_internal/revalidate`, which expires them when what the public catalog routes return
 * changes (S09 rule SF4).
 */

/** The storefront, the game pages and the sitemap. */
export const CATALOG_TAG = 'catalog';

/**
 * Store content (S14 CP1, CP2): the announcement, banners, pages, FAQ and live activity, with a
 * 60-second life so a schedule boundary shows without a job; every panel change expires it.
 */
export const CONTENT_TAG = 'content';

/**
 * The support channels (S12 SC2): the footer and `/support`. The API does not revalidate it when
 * the panel changes the link; its 60-second life (the route's own `max-age`) bounds the delay.
 */
export const SUPPORT_TAG = 'support';
