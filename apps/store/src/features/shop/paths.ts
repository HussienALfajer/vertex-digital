/*
 * A shop's addresses (S26): every page lives under `/s/<slug>/`, which is also its service
 * worker's scope (SP1). No contracts import: the shop's header and bottom bar use this.
 */

/** Slugs as SH2 allows them; anything else is not a shop. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export const isShopSlug = (slug: string) => SLUG.test(slug);

/** `/s/<slug>` and a path under it (`'/orders'`, `'/games/pubg'`). */
export const shopPath = (slug: string, path = '') => `/s/${slug}${path}`;

/**
 * The service worker's scope, the manifest's `scope`, `id` and `start_url`: `/s/<slug>`, without
 * a trailing slash, since the store answers `/s/<slug>/` with a redirect to `/s/<slug>` and a
 * scope matches as a plain prefix (the home page must be inside it).
 */
export const shopScope = (slug: string) => `/s/${slug}`;

/** Whether `pathname` is one of the shop's pages: its home or a page under it. */
export const inShop = (slug: string, pathname: string) =>
  pathname === shopPath(slug) || pathname.startsWith(`${shopPath(slug)}/`);

/**
 * A path to return to after signing in, resolved first (so `..` or `%2e%2e` cannot climb out):
 * a page of this shop, or the shop's home for anything else.
 */
export function shopNext(slug: string, next: string | null): string {
  const home = shopPath(slug);
  if (!next?.startsWith('/') || next.startsWith('//') || next.includes('\\')) return home;
  let url: URL;
  try {
    url = new URL(next, 'http://shop.invalid');
  } catch {
    return home;
  }
  if (url.origin !== 'http://shop.invalid' || !inShop(slug, url.pathname)) return home;
  return `${url.pathname}${url.search}`;
}

/** The API's `/api/shops/<slug>` and a path under it. */
export const shopApi = (slug: string, path = '') => `/api/shops/${encodeURIComponent(slug)}${path}`;
