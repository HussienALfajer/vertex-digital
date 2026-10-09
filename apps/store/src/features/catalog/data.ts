import type { Storefront, StoreGame } from '@vertex-digital/contracts';
import { cacheLife, cacheTag } from 'next/cache';
import { CATALOG_TAG } from '@/lib/cache-tags';
import { apiInternalUrl } from '@/lib/server-env';

/*
 * The public catalog as the store's server components read it (S09 rules SF1, SF4): the API's
 * public routes, which read no cookie and hold no customer data, cached under the `catalog` tag.
 * The worker's `store.revalidate` expires the tag when the catalog, prices, availability, health
 * or the rate change; 5 minutes is the ceiling (delivery stats refresh within it). A failed read
 * is never cached: the page's error view offers a retry.
 */

/** Rule SF4: revalidated every 5 minutes at most; the browser's router reuses a page for 30 s. */
const CATALOG_LIFE = { stale: 30, revalidate: 300, expire: 24 * 60 * 60 };

class CatalogUnavailable extends Error {}

async function readCatalog<T>(path: string): Promise<T | null> {
  const response = await fetch(`${apiInternalUrl()}${path}`, {
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new CatalogUnavailable(`GET ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** `GET /api/catalog/storefront`: the shown games by category, with the service line. */
export async function getStorefront(): Promise<Storefront> {
  'use cache';
  cacheTag(CATALOG_TAG);
  cacheLife(CATALOG_LIFE);
  const storefront = await readCatalog<Storefront>('/api/catalog/storefront');
  if (!storefront) throw new CatalogUnavailable('The storefront route is missing');
  return storefront;
}

/** `GET /api/catalog/games/:slug`; null for an unknown, archived or paused game. */
export async function getGame(slug: string): Promise<StoreGame | null> {
  'use cache';
  cacheTag(CATALOG_TAG);
  cacheLife(CATALOG_LIFE);
  return readCatalog<StoreGame>(`/api/catalog/games/${encodeURIComponent(slug)}`);
}
