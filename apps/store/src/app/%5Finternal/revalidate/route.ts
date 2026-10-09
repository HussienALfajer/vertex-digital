import { revalidateTag } from 'next/cache';
import { authorizedRevalidation } from '@/features/catalog/revalidation';
import { CATALOG_TAG } from '@/lib/cache-tags';
import { revalidateSecret } from '@/lib/server-env';

/*
 * `POST /_internal/revalidate` (S09 rule SF4; the folder name `%5Finternal` is how Next.js routes
 * a segment starting with `_`). The worker's `store.revalidate` job calls it on 127.0.0.1 after a
 * change to what the public catalog routes return; the cached pages read the API again on their
 * next request. nginx answers 404 for `/_internal/` on the public host, and this route also
 * refuses anything that came through a proxy or names another host.
 */
export async function POST(request: Request) {
  if (!authorizedRevalidation(request.headers, revalidateSecret())) {
    return new Response(null, { status: 401 });
  }
  // Expired at once: the next visitor reads the new prices, not the old page once more.
  revalidateTag(CATALOG_TAG, { expire: 0 });
  return new Response(null, { status: 204 });
}
