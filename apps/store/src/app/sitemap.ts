import { contentPagePath } from '@vertex-digital/contracts';
import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { getStorefront } from '@/features/catalog/data';
import { siteContent } from '@/features/content/data';
import { storeUrl } from '@/lib/server-env';

/**
 * Rule SF6: the home page and every shown game, from the `catalog` cache at request time; S14 SL4:
 * `/faq` and each published page at its path (`/merchant-terms`, audit A08-33), when the content
 * read answers.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const origin = storeUrl();
  const [storefront, site] = await Promise.all([getStorefront(), siteContent()]);
  return [
    { url: `${origin}/`, changeFrequency: 'daily', priority: 1 },
    ...storefront.categories.flatMap((category) =>
      category.games.map((game) => ({
        url: `${origin}/games/${game.slug}`,
        changeFrequency: 'daily' as const,
        priority: 0.8,
      })),
    ),
    ...(site?.faqPublished ? [{ url: `${origin}/faq`, changeFrequency: 'weekly' as const }] : []),
    ...(site?.pages ?? []).map((page) => ({
      url: `${origin}${contentPagePath(page.page)}`,
      lastModified: page.updatedAt,
      changeFrequency: 'monthly' as const,
    })),
  ];
}
