import type { ShopGame, ShopStorefront } from '@vertex-digital/contracts';
import { cacheLife, cacheTag } from 'next/cache';
import { CATALOG_TAG, shopTag } from '@/lib/cache-tags';
import { API_READ_TIMEOUT_MS, apiInternalUrl, CACHED_READ_HEADERS } from '@/lib/server-env';
import { isShopSlug } from './paths';

/*
 * A shop's public pages as the store's server components read them (S26 PR1–PR4): the API's
 * public shop routes, which read no cookie and carry only selling prices, cached under `catalog`
 * and the shop's own `shop:<id>` (the API queues it on the shop's settings, hidden games, selling
 * prices and state). An old slug (SH3) answers its current one, which the page redirects to; an
 * unknown shop is null. A failed read throws and is never cached.
 */

/** As the catalog's: revalidated every 5 minutes at most, the router reuses a page for 30 s. */
const SHOP_LIFE = { stale: 30, revalidate: 300, expire: 24 * 60 * 60 };

class ShopUnavailable extends Error {}

/** The shop's answer, the slug it moved to (SH3), or null for no shop. */
export type ShopRead<T> = { status: 'found'; data: T } | { status: 'moved'; slug: string } | null;

async function readShop<T>(path: string): Promise<ShopRead<T>> {
  const response = await fetch(`${apiInternalUrl()}${path}`, {
    headers: CACHED_READ_HEADERS,
    redirect: 'manual',
    signal: AbortSignal.timeout(API_READ_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (response.status === 301) {
    const moved = (await response.json().catch(() => null)) as { slug?: unknown } | null;
    if (typeof moved?.slug !== 'string' || !isShopSlug(moved.slug)) {
      throw new ShopUnavailable(`GET ${path} moved without a slug`);
    }
    return { status: 'moved', slug: moved.slug };
  }
  if (!response.ok) throw new ShopUnavailable(`GET ${path} answered ${response.status}`);
  return { status: 'found', data: (await response.json()) as T };
}

const shopRoute = (slug: string) => `/api/shops/${encodeURIComponent(slug)}`;

/** `GET /api/shops/:slug`: the shop, pinned games first, then the categories (PR1). */
export async function getShopStorefront(slug: string): Promise<ShopRead<ShopStorefront>> {
  'use cache';
  cacheTag(CATALOG_TAG);
  cacheLife(SHOP_LIFE);
  if (!isShopSlug(slug)) return null;
  const read = await readShop<ShopStorefront>(shopRoute(slug));
  if (read?.status === 'found') cacheTag(shopTag(read.data.shop.id));
  return read;
}

/** `GET /api/shops/:slug/games/:game`: its packs at the selling prices (PR2–PR4). */
export async function getShopGame(slug: string, game: string): Promise<ShopRead<ShopGame>> {
  'use cache';
  cacheTag(CATALOG_TAG);
  cacheLife(SHOP_LIFE);
  if (!isShopSlug(slug) || game.length > 48 || !/^[a-z0-9-]+$/.test(game)) return null;
  const read = await readShop<ShopGame>(`${shopRoute(slug)}/games/${encodeURIComponent(game)}`);
  if (read?.status === 'found') cacheTag(shopTag(read.data.shop.id));
  return read;
}
