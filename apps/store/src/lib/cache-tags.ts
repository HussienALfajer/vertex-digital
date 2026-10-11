/*
 * The tags of the store's cached reads (ADR 0002). The worker's `store.revalidate` job calls
 * `POST /_internal/revalidate`, which expires them when what the public catalog routes return
 * changes (S09 rule SF4).
 */

/** The storefront, the game pages and the sitemap. */
export const CATALOG_TAG = 'catalog';

/**
 * The support channels (S12 SC2): the footer and `/support`. The API does not revalidate it when
 * the panel changes the link; its 60-second life (the route's own `max-age`) bounds the delay.
 */
export const SUPPORT_TAG = 'support';
