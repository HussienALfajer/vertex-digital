import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { storeUrl } from '@/lib/server-env';

/** Rule SF6: crawlers welcome, except the customer's pages and the internal route. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/wallet', '/orders', '/account', '/notifications', '/_internal'],
    },
    sitemap: `${storeUrl()}/sitemap.xml`,
  };
}
