import { revalidateTag } from 'next/cache';
import { authorizedRevalidation } from '@/features/catalog/revalidation';
import { CATALOG_TAG, CONTENT_TAG } from '@/lib/cache-tags';
import { revalidateSecret } from '@/lib/server-env';

/*
 * `POST /_internal/revalidate` (S09 rule SF4; the folder name `%5Finternal` is how Next.js routes
 * a segment starting with `_`). The worker's `store.revalidate` job calls it on 127.0.0.1 after a
 * change to what the public catalog or content routes return (S14 CP1); the cached pages read the API again on their
 * next request. nginx answers 404 for `/_internal/` on the public host, and this route also
 * refuses anything that came through a proxy or names another host.
 */
export async function POST(request: Request) {
  if (!authorizedRevalidation(request.headers, revalidateSecret())) {
    return new Response(null, { status: 401 });
  }
  // The job names the tag it expires (audit A10-16): a catalog change (every supplier sync) used
  // to expire the content too, which every page's announcement bar then read again. A job with no
  // tag (the release before, during a deploy) expires both.
  const body = (await request.json().catch(() => null)) as { tag?: unknown } | null;
  const tags =
    body?.tag === 'catalog'
      ? [CATALOG_TAG]
      : body?.tag === 'content'
        ? [CONTENT_TAG]
        : [CATALOG_TAG, CONTENT_TAG];
  // Expired at once: the next visitor reads the new prices, not the old page once more.
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return new Response(null, { status: 204 });
}
