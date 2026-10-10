import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { storeUrl } from '@/lib/server-env';

/** Rule SF6: crawlers welcome, except the customer's pages, the cart and share links (S10 SH5), and the internal route. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/wallet',
        '/orders',
        '/account',
        '/notifications',
        '/cart',
        '/g/',
        '/r/',
        '/_internal',
      ],
    },
    sitemap: `${storeUrl()}/sitemap.xml`,
  };
}
