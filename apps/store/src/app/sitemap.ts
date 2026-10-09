import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { getStorefront } from '@/features/catalog/data';
import { storeUrl } from '@/lib/server-env';

/** Rule SF6: the home page and every shown game, from the `catalog` cache at request time. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const origin = storeUrl();
  const storefront = await getStorefront();
  return [
    { url: `${origin}/`, changeFrequency: 'daily', priority: 1 },
    ...storefront.categories.flatMap((category) =>
      category.games.map((game) => ({
        url: `${origin}/games/${game.slug}`,
        changeFrequency: 'daily' as const,
        priority: 0.8,
      })),
    ),
  ];
}
