import type {
  ContentPage,
  PublishedFaq,
  PublishedPage,
  SiteContent,
} from '@vertex-digital/contracts';
import { cacheLife, cacheTag } from 'next/cache';
import { connection } from 'next/server';
import { CONTENT_TAG } from '@/lib/cache-tags';
import { apiInternalUrl } from '@/lib/server-env';

/*
 * Store content as the server components read it (S14 CP2): the API's public content routes,
 * which read no cookie and answer only what the store shows, cached under the `content` tag with
 * the routes' own 60 seconds, so a schedule boundary shows within about 2 minutes without a job.
 * Every panel change expires the tag (CP1). A failed read is never cached.
 */

const CONTENT_LIFE = { stale: 60, revalidate: 60, expire: 24 * 60 * 60 };

class ContentUnavailable extends Error {}

async function readContent<T>(path: string): Promise<T | null> {
  const response = await fetch(`${apiInternalUrl()}${path}`, {
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new ContentUnavailable(`GET ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** `GET /api/content/site`: the announcement, live banners, published pages, FAQ presence. */
export async function getSiteContent(): Promise<SiteContent> {
  'use cache';
  cacheTag(CONTENT_TAG);
  cacheLife(CONTENT_LIFE);
  const site = await readContent<SiteContent>('/api/content/site');
  if (!site) throw new ContentUnavailable('The site content route is missing');
  return site;
}

/** `GET /api/content/pages/:page`; null while unpublished (PG2). */
export async function getPublishedPage(page: ContentPage): Promise<PublishedPage | null> {
  'use cache';
  cacheTag(CONTENT_TAG);
  cacheLife(CONTENT_LIFE);
  return readContent<PublishedPage>(`/api/content/pages/${page}`);
}

/** `GET /api/content/faq`; null while unpublished or empty (FQ5). */
export async function getPublishedFaq(): Promise<PublishedFaq | null> {
  'use cache';
  cacheTag(CONTENT_TAG);
  cacheLife(CONTENT_LIFE);
  return readContent<PublishedFaq>('/api/content/faq');
}

/**
 * The site content at request time, never during the build; null when the read failed: a
 * missing announcement, banner set or footer link must not break the page that shows it (CP2).
 */
export async function siteContent(): Promise<SiteContent | null> {
  await connection();
  try {
    return await getSiteContent();
  } catch {
    return null;
  }
}
