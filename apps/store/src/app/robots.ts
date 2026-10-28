import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { storeUrl } from '@/lib/server-env';

/**
 * Rule SF6: crawlers welcome, except the customer's pages, the cart (S10 SH5) and the internal
 * route. Share links, `/v/` and `/q/` are crawled to read their `noindex`: a disallowed page's
 * `noindex` is never seen, and a linked token could be listed bare (audit A10-58).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/wallet', '/orders', '/account', '/notifications', '/cart', '/_internal'],
    },
    sitemap: `${storeUrl()}/sitemap.xml`,
  };
}
