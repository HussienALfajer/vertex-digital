import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageBackLink } from '@/components/page-back-link';
import { t } from '@/lib/i18n';
import { getStorefront } from './data';
import { GameCard } from './game-card';
import { SLUG } from './slug';

/** A shown category by its slug, from the cached storefront; null for anything else (rule NH3). */
export async function categoryOf(slug: string) {
  if (slug.length > 48 || !SLUG.test(slug)) return null;
  const { categories } = await getStorefront();
  return categories.find((item) => item.slug === slug && item.games.length > 0) ?? null;
}

/** `/categories/[slug]` (S24 NH3): the category's title, its game count and every shown game. */
export async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const category = await categoryOf(slug);
  if (!category) notFound();
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <PageBackLink href="/">{t('back.home')}</PageBackLink>
        <h1 className="flex items-center gap-3 text-2xl font-bold md:text-3xl">
          <AscentBar className="h-7 w-1.5" />
          {category.nameAr}
        </h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          {t('catalog.gameCount', { count: category.games.length })}
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {category.games.map((game, index) => (
          <li key={game.id}>
            <GameCard game={game} priority={index < 5} />
          </li>
        ))}
      </ul>
    </div>
  );
}
